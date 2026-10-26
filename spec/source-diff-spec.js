const { TextBuffer } = require("lumine");
const { computeSourceDiff } = require("../lib/compute-source-diff");
const { computeDiff } = require("../lib/compute-diff");

function source(text) {
  const buffer = new TextBuffer(text);
  const snapshot = buffer.getTextSnapshot();
  buffer.destroy();
  return snapshot;
}

describe("Source-backed comparison", () => {
  beforeEach(() => jasmine.useRealClock());

  it("preserves line comparison semantics, whitespace policy and clipped offsets", async () => {
    const values = [
      "",
      "a",
      "a\nb\nc\n",
      "a\nx\nc\n",
      "a\nb\n",
      "a\n    b\n",
      "a\r\nb\r\n",
      "\n\na\n\n",
      "😀\nx\n",
    ];
    for (const left of values)
      for (const right of values)
        for (const trim of [true, false]) {
          const actual = await computeSourceDiff(source(left), source(right), trim, 0);
          expect(actual.chunks)
            .withContext(JSON.stringify([left, right, trim]))
            .toEqual(computeDiff(left, right, trim, 0).chunks);
        }
  });

  it("normalizes CRLF split between source chunks and groups lone-CR changes in real buffer rows", async () => {
    const prefix = source("x".repeat(65535) + "\r");
    const left = prefix.replace(prefix.length, prefix.length, "\na\r\nb\n");
    const right = source("x".repeat(65535) + "\na\nb\n");
    expect((await computeSourceDiff(left, right, false, 0)).chunks).toEqual([]);
    expect((await computeSourceDiff(source("a\rb"), source("a\rc"), false, 0)).chunks).toEqual([
      { oldLineStart: 0, oldLineEnd: 1, newLineStart: 0, newLineEnd: 1 },
    ]);
  });

  it("compares and groups a giant line without requesting an oversized native string", async () => {
    let left = source("x".repeat(65536));
    for (let i = 0; i < 14; i++) left = left.replace(left.length, left.length, left);
    const right = left.replace(left.length - 1, left.length, "y");
    const slice = left.constructor.prototype.slice;
    const spy = spyOn(left.constructor.prototype, "slice").and.callFake(function (
      start = 0,
      end = this.length,
    ) {
      expect(end - start).toBeLessThanOrEqual(65536);
      return slice.call(this, start, end);
    });
    const result = await computeSourceDiff(left, right, false, 0);
    expect(result.grouped).toBe(true);
    expect(result.chunks).toEqual([
      { oldLineStart: 0, oldLineEnd: 1, newLineStart: 0, newLineEnd: 1 },
    ]);
    expect(spy).toHaveBeenCalled();
  });

  it("narrows a large document to a small exact changed region and cancels obsolete work", async () => {
    const left = source("same\n".repeat(100000) + "old\nend\n");
    const right = left.replace(left.length - 8, left.length - 5, "new");
    const result = await computeSourceDiff(left, right, false, 0);
    expect(result.grouped).toBeUndefined();
    expect(result.chunks).toEqual([
      { oldLineStart: 100000, oldLineEnd: 100001, newLineStart: 100000, newLineEnd: 100001 },
    ]);
    let checks = 0;
    await expectAsync(
      computeSourceDiff(left, right, false, 0, () => ++checks < 2),
    ).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
  });
});

describe("Large source comparison integration", () => {
  let main, left, right;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("diff-view")).mainModule;
    left = await lumine.workspace.open();
    right = await lumine.workspace.open(null, { split: "right" });
  });
  afterEach(() => {
    main.disable();
    left.destroy();
    right.destroy();
  });

  it("copies a grouped snapshot and undoes it without whole-document or selected-range strings", async () => {
    let text = source("x".repeat(65536));
    for (let i = 0; i < 14; i++) text = text.replace(text.length, text.length, text);
    left.getBuffer().setTextInRange(left.getBuffer().getRange(), text);
    right.setText("different");
    spyOn(left, "getText").and.throwError("Whole document string");
    spyOn(right, "getText").and.throwError("Whole document string");
    spyOn(left, "getTextInBufferRange").and.throwError("Whole copied range string");
    await main.diffEditors(left, right, {
      autoDiff: false,
      muteNotifications: true,
      computeTimeout: 0,
      scrollSyncType: "None",
    });
    expect(main.diffView.getNumDifferences()).toBe(1);
    expect(main.footerView.numDifferencesText.textContent).toContain("grouped");
    main.diffView._chunks[0].isSelected = true;
    await main.copyToRight();
    expect(right.getBuffer().getTextSnapshot().equals(text)).toBe(true);
    right.undo();
    expect(right.getBuffer().getText()).toBe("different");
  });

  it("refuses stale hunk geometry before modifying either editor", async () => {
    left.setText("left");
    right.setText("right");
    await main.diffEditors(left, right, { autoDiff: false, muteNotifications: true });
    main.diffView._chunks[0].isSelected = true;
    left.setText("fresh source");
    const warning = spyOn(lumine.notifications, "addWarning");
    main.copyToRight();
    expect(right.getText()).toBe("right");
    expect(warning).toHaveBeenCalled();
  });

  it("discards a pending large copy when its source changes", async () => {
    let text = source("x".repeat(65536));
    for (let i = 0; i < 5; i++) text = text.replace(text.length, text.length, text);
    left.getBuffer().setTextInRange(left.getBuffer().getRange(), text);
    right.setText("unchanged target");
    await main.diffEditors(left, right, {
      autoDiff: false,
      computeTimeout: 0,
      muteNotifications: true,
    });
    main.diffView._chunks[0].isSelected = true;
    const copying = main.copyToRight();
    left.getBuffer().insert([0, 0], "new");
    expect(await copying).toBe(false);
    expect(right.getText()).toBe("unchanged target");
  });
});
