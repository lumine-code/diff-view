describe("Automatic comparison with None", () => {
  let main, left, right, grammar, runtime;
  beforeEach(async () => {
    const text = await lumine.packages.activatePackage("language-text");
    await text.resourceLoadPromise;
    if (lumine.packages.isPackageLoaded("diff-view"))
      await lumine.packages.unloadPackage("diff-view");
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("diff-view")).mainModule;
    left = await lumine.workspace.open();
    lumine.workspace.getActivePane().splitRight();
    right = await lumine.workspace.open();
    grammar = lumine.grammars.grammarForScopeName("text.plain");
    for (const editor of [left, right]) lumine.grammars.assignGrammar(editor, grammar);
    left.setText("before\n");
    right.setText("after\n");
    runtime = await main.loadRuntime();
  });
  afterEach(async () => {
    main.disable();
    lumine.config.unset("diff-view.diffWords");
    await lumine.packages.unloadPackage("diff-view");
    left.destroy();
    right.destroy();
  });
  const compare = (autoDiff = true) =>
    main.diffEditors(left, right, {
      autoDiff,
      muteNotifications: true,
      scrollSyncType: "Vertical",
      diffWords: false,
    });
  const stopped = (editor) => editor.getBuffer().emitDidStopChangingEvent();

  it("keeps explicit initial None comparison but refuses automatic text/config reads", async () => {
    lumine.grammars.assignGrammar(left, lumine.grammars.nullGrammar);
    await compare();
    expect(main.diffView.getNumDifferences()).toBe(1);
    const readLeft = spyOn(left, "getText").and.callThrough();
    const readRight = spyOn(right, "getText").and.callThrough();
    stopped(left);
    stopped(right);
    lumine.config.set("diff-view.diffWords", !lumine.config.get("diff-view.diffWords"));
    expect(readLeft).not.toHaveBeenCalled();
    expect(readRight).not.toHaveBeenCalled();
    expect(main.diffView.getNumDifferences()).toBe(0);
    expect(main.syncScroll).toBeNull();
    expect(main.isEnabled).toBe(true);
    await compare();
    expect(main.diffView.getNumDifferences()).toBe(1);
    expect(readLeft).toHaveBeenCalled();
  });

  it("clears on either None and resumes current data only after both grammars return", async () => {
    await compare();
    const readLeft = spyOn(left, "getText").and.callThrough();
    const readRight = spyOn(right, "getText").and.callThrough();
    lumine.grammars.assignGrammar(left, lumine.grammars.nullGrammar);
    expect(main.diffView.getNumDifferences()).toBe(0);
    expect(main.syncScroll).toBeNull();
    right.setText("before\n");
    stopped(right);
    lumine.grammars.assignGrammar(right, lumine.grammars.nullGrammar);
    lumine.grammars.assignGrammar(left, grammar);
    expect(readLeft).not.toHaveBeenCalled();
    expect(readRight).not.toHaveBeenCalled();
    expect(main.diffView.getNumDifferences()).toBe(0);
    lumine.grammars.assignGrammar(right, grammar);
    expect(readLeft).toHaveBeenCalledTimes(1);
    expect(readRight).toHaveBeenCalledTimes(1);
    expect(main.diffView.getNumDifferences()).toBe(0);
    expect(left.getBuffer().getText()).toBe("before\n");
    expect(right.getBuffer().getText()).toBe("before\n");
    right.setText("resumed\n");
    stopped(right);
    expect(main.diffView.getNumDifferences()).toBe(1);
  });

  it("does not turn automatic comparison back on when its option is disabled", async () => {
    await compare(false);
    const readLeft = spyOn(left, "getText").and.callThrough();
    const readRight = spyOn(right, "getText").and.callThrough();
    lumine.grammars.assignGrammar(right, lumine.grammars.nullGrammar);
    expect(main.diffView.getNumDifferences()).toBe(0);
    lumine.grammars.assignGrammar(right, grammar);
    stopped(right);
    expect(readLeft).not.toHaveBeenCalled();
    expect(readRight).not.toHaveBeenCalled();
    await compare(false);
    expect(main.diffView.getNumDifferences()).toBe(1);
  });

  it("cannot overwrite a fresh same-grammar comparison after a source-read callback round trip", async () => {
    left.setText("after\n");
    await compare();
    expect(main.diffView.getNumDifferences()).toBe(0);
    const read = left.getText.bind(left);
    let replace = true;
    spyOn(left, "getText").and.callFake(() => {
      const text = read();
      if (replace) {
        replace = false;
        lumine.grammars.assignGrammar(left, lumine.grammars.nullGrammar);
        left.setText("fresh\n");
        lumine.grammars.assignGrammar(left, grammar);
      }
      return text;
    });
    const compute = spyOn(runtime, "computeDiff").and.callThrough();
    stopped(left);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute.calls.mostRecent().args[0]).toBe("fresh\n");
    expect(main.diffView.getNumDifferences()).toBe(1);
  });

  it("does not paint an old synchronous computation if its callback selects None", async () => {
    await compare();
    const compute = runtime.computeDiff;
    let suspend = true;
    spyOn(runtime, "computeDiff").and.callFake((...args) => {
      const result = compute(...args);
      if (suspend) {
        suspend = false;
        lumine.grammars.assignGrammar(right, lumine.grammars.nullGrammar);
      }
      return result;
    });
    stopped(left);
    expect(main.diffView.getNumDifferences()).toBe(0);
    expect(main.syncScroll).toBeNull();
    lumine.grammars.assignGrammar(right, grammar);
    expect(main.diffView.getNumDifferences()).toBe(1);
    expect(main.isEnabled).toBe(true);
  });

  it("preserves the fresh comparison when scroll cleanup changes the source generation", async () => {
    await compare();
    const previous = main.syncScroll;
    const dispose = previous.dispose.bind(previous);
    spyOn(previous, "dispose").and.callFake(() => {
      dispose();
      lumine.grammars.assignGrammar(left, lumine.grammars.nullGrammar);
      left.setText("fresh during cleanup\n");
      lumine.grammars.assignGrammar(left, grammar);
    });
    stopped(left);
    expect(main.syncScroll).not.toBeNull();
    expect(main.syncScroll).not.toBe(previous);
    expect(main.diffView.getNumDifferences()).toBe(1);
    expect(left.getBuffer().getText()).toBe("fresh during cleanup\n");
  });
});
