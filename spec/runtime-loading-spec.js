const { execFileSync } = require("node:child_process");
const path = require("node:path");

function deferred() {
  let resolve;
  const promise = new Promise((accept) => (resolve = accept));
  return { promise, resolve };
}

describe("Diff View native runtime", () => {
  let main;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("diff-view")).mainModule;
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("diff-view");
  });

  async function editors() {
    const editor1 = await lumine.workspace.open();
    editor1.setText("before\n");
    lumine.workspace.getActivePane().splitRight();
    const editor2 = await lumine.workspace.open();
    editor2.setText("after\n");
    return { editor1, editor2 };
  }

  it("loads the bootstrap without the display, footer, scrolling, or calculation runtime", () => {
    const script = `
      const Module = require("node:module");
      const original = Module._load;
      Module._load = function(request, ...args) {
        return request === "lumine" ? { Disposable: class {} } : original.call(this, request, ...args);
      };
      const main = require("./lib/diff-view");
      if (typeof main.provideDiffView !== "function" || typeof main.activate !== "function") throw new Error("Missing bootstrap");
      console.log(JSON.stringify(Object.keys(require.cache).filter(file => /(?:diff-display|footer-view|sync-scroll|compute-diff|runtime)\\.js$/.test(file))));
    `;
    const output = execFileSync(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      encoding: "utf8",
    });
    expect(JSON.parse(output.trim())).toEqual([]);
  });

  it("shares native runtime imports and preserves the CommonJS constructors", async () => {
    const RuntimeLoader = require("../lib/runtime-loader");
    const loader = new RuntimeLoader();
    const importing = spyOn(loader, "importRuntime").and.callThrough();
    const first = loader.load();
    expect(loader.load()).toBe(first);
    const runtime = await first;
    expect(runtime).toBe(require("../lib/runtime"));
    expect(runtime.DiffView).toBe(require("../lib/diff-display"));
    expect(runtime.computeDiff).toBe(require("../lib/compute-diff").computeDiff);
    expect(importing).toHaveBeenCalledTimes(1);
  });

  it("retries an import failure and can start a new comparison", async () => {
    const pair = await editors();
    const load = main.loadRuntime.bind(main);
    const imported = spyOn(main, "loadRuntime").and.rejectWith(
      new Error("temporary runtime failure"),
    );
    expect(await main.diffEditors(pair.editor1, pair.editor2)).toBe(null);
    expect(main.diffView).toBe(null);
    imported.and.callFake(load);
    await main.diffEditors(pair.editor1, pair.editor2);
    expect(main.diffView).not.toBe(null);
    expect(main.diffView.getNumDifferences()).toBe(1);
  });

  it("does not mutate editors or construct a diff after cancellation during import", async () => {
    const pair = await editors();
    const importing = deferred();
    const started = deferred();
    const runtime = await main.loadRuntime();
    spyOn(main, "loadRuntime").and.callFake(() => {
      started.resolve();
      return importing.promise;
    });
    const setup = spyOn(main, "_setupVisibleEditors").and.callThrough();
    const pending = main.diffEditors(pair.editor1, pair.editor2, { turnOffSoftWrap: true });
    await started.promise;
    main.disable();
    importing.resolve(runtime);
    expect(await pending).toBe(null);
    expect(setup).not.toHaveBeenCalled();
    expect(main.diffView).toBe(null);
    expect(pair.editor1.isDestroyed()).toBe(false);
    expect(pair.editor2.isDestroyed()).toBe(false);
  });

  it("discards a superseded import and compares the latest buffer contents", async () => {
    const pair = await editors();
    const runtime = await main.loadRuntime();
    const importing = deferred();
    const started = deferred();
    const load = spyOn(main, "loadRuntime").and.callFake(() => {
      started.resolve();
      return importing.promise;
    });
    const first = main.diffEditors(pair.editor1, pair.editor2);
    await started.promise;
    load.and.resolveTo(runtime);
    pair.editor2.setText("latest\n");
    await main.diffEditors(pair.editor1, pair.editor2);
    const currentView = main.diffView;
    importing.resolve(runtime);
    expect(await first).toBe(null);
    expect(main.diffView).toBe(currentView);
    expect(currentView.getNumDifferences()).toBe(1);
  });

  it("keeps an import from a retired package generation out of the reloaded comparison", async () => {
    const pair = await editors();
    const oldMain = main;
    const runtime = await main.loadRuntime();
    const importing = deferred();
    const started = deferred();
    spyOn(main, "loadRuntime").and.callFake(() => {
      started.resolve();
      return importing.promise;
    });
    const pending = main.diffEditors(pair.editor1, pair.editor2);
    await started.promise;
    await lumine.packages.unloadPackage("diff-view");
    main = (await lumine.packages.activatePackage("diff-view")).mainModule;
    await main.diffEditors(pair.editor1, pair.editor2);
    const currentView = main.diffView;
    importing.resolve(runtime);
    expect(await pending).toBe(null);
    expect(main).not.toBe(oldMain);
    expect(main.diffView).toBe(currentView);
    expect(currentView.constructor).toBe(require("../lib/diff-display"));
    expect(currentView.constructor).not.toBe(runtime.DiffView);
  });
});
