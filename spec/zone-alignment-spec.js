const DiffView = require("../lib/diff-display");
const { computeDiff } = require("../lib/compute-diff");

describe("view zone alignment", () => {
  let editor1, editor2, diffView;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    editor1 = await lumine.workspace.open();
    lumine.workspace.getActivePane().splitRight();
    editor2 = await lumine.workspace.open();
  });

  afterEach(() => {
    if (diffView) {
      diffView.destroy();
      diffView = null;
    }
  });

  function totalZoneHeight(extender) {
    return extender.getViewZones().reduce((sum, zone) => sum + zone.pixelHeight, 0);
  }

  // The invariant every spacer exists for: screen rows plus spacers add up to
  // the same height on both sides, whatever each side's wrapping does.
  function expectHeightsBalanced() {
    const lineHeight = editor1.getLineHeightInPixels();
    const side1 =
      editor1.getScreenLineCount() * lineHeight + totalZoneHeight(diffView._editorDiffExtender1);
    const side2 =
      editor2.getScreenLineCount() * lineHeight + totalZoneHeight(diffView._editorDiffExtender2);
    expect(side1).toBe(side2);
  }

  function renderEditors() {
    editor1.component.updateSync();
    editor2.component.updateSync();
  }

  for (const longerSide of ["left", "right"]) {
    for (const wrapped of [false, true]) {
      it(`aligns common text after extra first lines on the ${longerSide}${wrapped ? " with a wrapped first common line" : ""}`, () => {
        const common = [`!? Groups ${"group ".repeat(12)}`, "body", "end"].join("\n");
        const longer = `SOFiSTiK 2023\n\n${common}`;
        editor1.setText(longerSide === "left" ? longer : common);
        editor2.setText(longerSide === "right" ? longer : common);
        lumine.config.set("editor.softWrapAtPreferredLineLength", true);
        lumine.config.set("editor.preferredLineLength", 20);
        editor1.setSoftWrapped(wrapped);
        editor2.setSoftWrapped(wrapped);
        renderEditors();

        diffView = new DiffView({ editor1, editor2 });
        diffView._chunks = computeDiff(editor1.getText(), editor2.getText(), false, 0).chunks;
        diffView._syncViewZoneHeights();
        renderEditors();

        const shorterExtender =
          longerSide === "left" ? diffView._editorDiffExtender2 : diffView._editorDiffExtender1;
        const zone = shorterExtender.getViewZones().find((z) => z.lineNumber === -1);
        expect(zone).toBeDefined();
        expect(zone.pixelHeight).toBe(2 * editor1.getLineHeightInPixels());
        expect(zone.decoration.getProperties().position).toBe("before");
        expect(zone.marker.getStartBufferPosition().toArray()).toEqual([0, 0]);
        expect(zone.element.isConnected).toBe(true);

        const row1 = longerSide === "left" ? 2 : 0;
        const row2 = longerSide === "right" ? 2 : 0;
        const view1 = lumine.views.getView(editor1);
        const view2 = lumine.views.getView(editor2);
        // Equal total heights do not prove placement: a spacer after the first
        // line would balance the files while leaving their first common text apart.
        for (const offset of [0, 1]) {
          expect(view1.pixelPositionForBufferPosition([row1 + offset, 0]).top).toBeCloseTo(
            view2.pixelPositionForBufferPosition([row2 + offset, 0]).top,
            5,
          );
        }
        if (wrapped) {
          expect(
            editor1.screenRowForBufferRow(row1 + 1) - editor1.screenRowForBufferRow(row1),
          ).toBeGreaterThan(1);
          expect(
            editor2.screenRowForBufferRow(row2 + 1) - editor2.screenRowForBufferRow(row2),
          ).toBeGreaterThan(1);
        }
        expectHeightsBalanced();
      });
    }
  }

  it("sums a line owed height by the wrap walk and by a chunk at once", () => {
    // Every left line wraps; the right side stays unwrapped — so the
    // per-line walk owes the right side the extra rows. Lines 3-4 are also
    // deleted on the right, so the delete chunk owes the gap after line 2 too.
    // Both land on line 2, and dropping either walks the sides apart by
    // exactly that height on every unequal-width resize.
    const wide = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(30)}`);
    editor1.setText(wide.join("\n"));
    editor1.setSoftWrapped(true);
    editor1.displayLayer.reset({ softWrapColumn: 20 });
    const narrow = wide.slice();
    narrow.splice(3, 2);
    editor2.setText(narrow.join("\n"));
    editor2.setSoftWrapped(false);

    diffView = new DiffView({ editor1, editor2 });
    diffView._chunks = [{ oldLineStart: 3, oldLineEnd: 5, newLineStart: 3, newLineEnd: 3 }];
    diffView._syncViewZoneHeights();

    const lineHeight = editor1.getLineHeightInPixels();
    const rowsPerLeftLine = editor1.screenRowForBufferRow(1) - editor1.screenRowForBufferRow(0);
    expect(rowsPerLeftLine).toBeGreaterThan(1);
    expect(editor2.getScreenLineCount()).toBe(narrow.length);

    // Line 2's zone carries both debts: its own wrap difference plus the
    // deleted chunk's rows.
    const zone = diffView._editorDiffExtender2.getViewZones().find((z) => z.lineNumber === 2);
    const wrapDebt = (rowsPerLeftLine - 1) * lineHeight;
    const chunkDebt = 2 * rowsPerLeftLine * lineHeight;
    expect(zone.pixelHeight).toBe(wrapDebt + chunkDebt);

    expectHeightsBalanced();
  });

  it("balances the two sides when only the chunk differs", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    editor1.setText(lines.join("\n"));
    const shorter = lines.slice();
    shorter.splice(5, 3);
    editor2.setText(shorter.join("\n"));

    diffView = new DiffView({ editor1, editor2 });
    diffView._chunks = [{ oldLineStart: 5, oldLineEnd: 8, newLineStart: 5, newLineEnd: 5 }];
    diffView._syncViewZoneHeights();

    expectHeightsBalanced();
  });

  it("rebalances after the wrapping changes, reusing the standing zones", () => {
    const wide = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(30)}`);
    editor1.setText(wide.join("\n"));
    const narrow = wide.slice();
    narrow.splice(3, 2);
    editor2.setText(narrow.join("\n"));

    diffView = new DiffView({ editor1, editor2 });
    diffView._chunks = [{ oldLineStart: 3, oldLineEnd: 5, newLineStart: 3, newLineEnd: 3 }];
    diffView._syncViewZoneHeights();
    expectHeightsBalanced();
    const zoneBefore = diffView._editorDiffExtender2.getViewZones().find((z) => z.lineNumber === 2);

    // What a pane resize does: the wrap column moves, every height changes.
    editor1.setSoftWrapped(true);
    editor1.displayLayer.reset({ softWrapColumn: 20 });
    diffView._syncViewZoneHeights();

    expectHeightsBalanced();
    // Resized in place, not recreated — recreating dropped the content height
    // for a frame and let each editor re-anchor onto a different row.
    const zoneAfter = diffView._editorDiffExtender2.getViewZones().find((z) => z.lineNumber === 2);
    expect(zoneAfter).toBe(zoneBefore);
  });
});
