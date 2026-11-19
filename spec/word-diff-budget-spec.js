describe("the shared line and word diff budget", () => {
  let mainModule, wordDiffModule, editor1, editor2;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const pkg = await lumine.packages.activatePackage("diff-view");
    mainModule = pkg.mainModule;
    wordDiffModule = require("../lib/compute-word-diff");
    editor1 = await lumine.workspace.open();
    lumine.workspace.getActivePane().splitRight();
    editor2 = await lumine.workspace.open();
    editor1.setText("one old\ntwo old\nunchanged\nthree old\n");
    editor2.setText("one new\ntwo new\nunchanged\nthree new\n");
  });

  afterEach(() => mainModule.disable());

  function expectLineHighlights() {
    for (const editor of [editor1, editor2]) {
      const lines = editor
        .getDecorations({ type: "line" })
        .filter((decoration) => /diff-view-(added|removed)/.test(decoration.getProperties().class));
      expect(lines.length).toBe(2);
      expect(mainModule.diffView.getNumDifferences()).toBe(2);
    }
  }

  it("uses the time left after line comparison across every changed line and chunk", async () => {
    let clockMs = 100;
    spyOn(Date, "now").and.callFake(() => clockMs);
    const resume = mainModule._resumeUpdateDiff;
    spyOn(mainModule, "_resumeUpdateDiff").and.callFake((editors, diff, deadline) => {
      // Seven of the ten milliseconds have elapsed before word comparison.
      clockMs += 7;
      resume.call(mainModule, editors, diff, deadline);
    });
    const compute = wordDiffModule.computeWordDiff;
    const words = spyOn(wordDiffModule, "computeWordDiff").and.callFake((oldText, newText) => {
      const result = compute(oldText, newText);
      clockMs += 4;
      return result;
    });

    await mainModule.diffEditors(editor1, editor2, {
      autoDiff: false,
      computeTimeout: 10,
      muteNotifications: true,
    });

    expect(words.calls.count()).toBe(1);
    expect(words.calls.first().args).toEqual(["one old", "one new", 3]);
    expectLineHighlights();
  });

  it("keeps line highlights when detailed word comparison runs out of time", async () => {
    const words = spyOn(wordDiffModule, "computeWordDiff").and.returnValue(null);

    await mainModule.diffEditors(editor1, editor2, {
      autoDiff: false,
      computeTimeout: 0,
      muteNotifications: true,
    });

    expect(words).toHaveBeenCalled();
    expectLineHighlights();
    for (const editor of [editor1, editor2]) {
      expect(
        editor
          .getDecorations({ type: "highlight" })
          .filter((decoration) => /diff-view-word-/.test(decoration.getProperties().class)).length,
      ).toBe(0);
    }
  });

  it("allows every word comparison when the configured budget is zero", async () => {
    let clockMs = 100;
    spyOn(Date, "now").and.callFake(() => clockMs);
    const compute = wordDiffModule.computeWordDiff;
    const words = spyOn(wordDiffModule, "computeWordDiff").and.callFake((oldText, newText) => {
      clockMs += 1000;
      return compute(oldText, newText);
    });

    await mainModule.diffEditors(editor1, editor2, {
      autoDiff: false,
      computeTimeout: 0,
      muteNotifications: true,
    });

    expect(words.calls.count()).toBe(3);
    expect(words.calls.allArgs().map((args) => args[2])).toEqual([0, 0, 0]);
    expectLineHighlights();
  });

  it("publishes the line comparison before computing detailed changes to a hard word pair", async () => {
    jasmine.useRealClock();
    const left = Array.from({ length: 430 }, (_, i) => `before${i}`).join(" ");
    const right = Array.from({ length: 430 }, (_, i) => `after${i}`).join("\t");
    editor1.setText(`${left} shared`);
    editor2.setText(`${right} shared`);
    const words = spyOn(wordDiffModule, "computeWordDiff").and.callThrough();
    const request = mainModule._requestWorkerComparison.bind(mainModule);
    const compareInWorker = spyOn(mainModule, "_requestWorkerComparison").and.callFake(
      (job, signal) => {
        expect(mainModule.diffView.getNumDifferences()).toBe(1);
        return request(job, signal);
      },
    );
    const wordHighlights = (editor) =>
      editor
        .getDecorations({ type: "highlight" })
        .filter((decoration) => /diff-view-word-/.test(decoration.getProperties().class));

    await mainModule.diffEditors(editor1, editor2, {
      autoDiff: false,
      computeTimeout: 0,
      muteNotifications: true,
    });

    expect(compareInWorker).toHaveBeenCalledTimes(1);
    expect(compareInWorker.calls.first().args[0].type).toBe("words");
    expect(words).not.toHaveBeenCalled();
    expect(wordHighlights(editor1).length).toBeGreaterThan(0);
    expect(wordHighlights(editor2).length).toBeGreaterThan(0);
  });
});
