// The spec runner freezes setTimeout, so completion of the background diff
// process is awaited by polling on animation frames instead of timers.
function pollUntil(condition, timeoutMs = 15000) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) {
        resolve();
      } else if (performance.now() - start > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  });
}

describe("diff-view", () => {
  let workspaceElement, mainModule;

  beforeEach(async () => {
    workspaceElement = atom.views.getView(atom.workspace);
    jasmine.attachToDOM(workspaceElement);
    const pkg = await atom.packages.activatePackage("diff-view");
    mainModule = pkg.mainModule;
  });

  afterEach(() => {
    mainModule.disable();
  });

  async function openEditorsSideBySide(text1, text2) {
    const editor1 = await atom.workspace.open();
    editor1.setText(text1);
    atom.workspace.getActivePane().splitRight();
    const editor2 = await atom.workspace.open();
    editor2.setText(text2);
    return { editor1, editor2 };
  }

  describe("diffing two editors", () => {
    it("computes the diff and renders chunk decorations", async () => {
      const { editor1, editor2 } = await openEditorsSideBySide(
        "aaa\nbbb\nccc\n",
        "aaa\nxxx\nccc\nddd\n",
      );

      mainModule.diffEditors(editor1, editor2, { autoDiff: false, muteNotifications: true });
      await pollUntil(
        () => mainModule.diffView != null && mainModule.diffView.getNumDifferences() === 2,
      );

      expect(mainModule.isEnabled).toBe(true);
      expect(mainModule.diffView.getNumDifferences()).toBe(2);

      const classesOf = (editor) =>
        editor
          .getDecorations({ type: "line" })
          .map((decoration) => decoration.getProperties().class)
          .join(" ");
      const allClasses = classesOf(editor1) + " " + classesOf(editor2);
      expect(allClasses).toContain("diff-view-added");
      expect(allClasses).toContain("diff-view-removed");

      // one side must carry the added highlight and the other the removed one
      const added = /diff-view-added/.test(classesOf(editor1)) ? editor1 : editor2;
      const removed = added === editor1 ? editor2 : editor1;
      expect(classesOf(added)).toContain("diff-view-added");
      expect(classesOf(removed)).toContain("diff-view-removed");
    });

    it("shows the footer panel with the number of differences", async () => {
      const { editor1, editor2 } = await openEditorsSideBySide("one\ntwo\n", "one\nfoo\n");

      mainModule.diffEditors(editor1, editor2, { autoDiff: false, muteNotifications: true });
      await pollUntil(
        () =>
          workspaceElement.querySelector(".diff-view-ui .num-diff-value") != null &&
          workspaceElement.querySelector(".diff-view-ui .num-diff-value").textContent === "1",
      );

      const footer = workspaceElement.querySelector(".diff-view-ui");
      expect(footer).not.toBeNull();
      expect(footer.querySelector(".num-diff-text").textContent).toBe("difference");
    });

    it("disable() clears the diff state and decorations", async () => {
      const { editor1, editor2 } = await openEditorsSideBySide("a\nb\n", "a\nc\n");

      mainModule.diffEditors(editor1, editor2, { autoDiff: false, muteNotifications: true });
      await pollUntil(
        () => mainModule.diffView != null && mainModule.diffView.getNumDifferences() > 0,
      );

      mainModule.disable();

      expect(mainModule.isEnabled).toBe(false);
      expect(mainModule.diffView).toBeNull();
      expect(mainModule.footerView).toBeNull();
      const lineClasses = editor1
        .getDecorations({ type: "line" })
        .map((decoration) => decoration.getProperties().class)
        .join(" ");
      expect(lineClasses).not.toContain("diff-view-added");
      expect(lineClasses).not.toContain("diff-view-removed");
    });
  });

  describe("provided services", () => {
    it("provides the diff-view/split-diff control service", async () => {
      const service = mainModule.provideDiffView();
      expect(typeof service.getMarkerLayers).toBe("function");
      expect(typeof service.diffEditors).toBe("function");
      expect(typeof service.disable).toBe("function");

      const { editor1, editor2 } = await openEditorsSideBySide("x\ny\n", "x\nz\n");
      const layersPromise = service.getMarkerLayers();
      service.diffEditors(editor1, editor2, { autoDiff: false, muteNotifications: true });
      const layers = await layersPromise;
      expect(layers.editor1.lineMarkerLayer).toBeDefined();
      expect(layers.editor2.lineMarkerLayer).toBeDefined();
      expect(layers.editor1.id).toBe(editor1.id);

      service.disable();
      expect(mainModule.isEnabled).toBe(false);
    });

    it("declares the split-diff service as a compatibility alias", () => {
      const { providedServices } = atom.packages.getActivePackage("diff-view").metadata;
      expect(providedServices["split-diff"].versions["1.0.0"]).toBe("provideDiffView");
      expect(providedServices["diff-view"].versions["1.0.0"]).toBe("provideDiffView");
    });

    it("provides the scrollbar-marker data service", async () => {
      const service = mainModule.provideDiffService();
      expect(service.getDiffView()).toBeNull();

      let latest = null;
      const subscription = service.onDidUpdate((data) => {
        latest = data;
      });

      const { editor1, editor2 } = await openEditorsSideBySide("1\n2\n", "1\n3\n");
      mainModule.diffEditors(editor1, editor2, { autoDiff: false, muteNotifications: true });
      await pollUntil(() => latest != null && latest.chunks != null);

      expect(latest.editor1).toBe(editor1);
      expect(latest.editor2).toBe(editor2);
      expect(service.getDiffView().chunks.length).toBeGreaterThan(0);

      subscription.dispose();
    });
  });
});
