// The spec runner freezes setTimeout, so the editors a diff opens are awaited
// by polling on animation frames instead of timers.
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
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    const pkg = await lumine.packages.activatePackage("diff-view");
    mainModule = pkg.mainModule;
  });

  afterEach(() => {
    mainModule.disable();
  });

  async function openEditorsSideBySide(text1, text2) {
    const editor1 = await lumine.workspace.open();
    editor1.setText(text1);
    lumine.workspace.getActivePane().splitRight();
    const editor2 = await lumine.workspace.open();
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

    describe("when the diff runs out of its compute budget", () => {
      // jsdiff spends the budget against Date.now, which the harness freezes.
      beforeEach(() => jasmine.useRealClock());

      // Every other line differs, which is the shape the O(ND) diff costs the
      // most on. A 1ms budget makes it give up regardless of the machine.
      function pathologicalPair(differences) {
        const oldLines = [];
        const newLines = [];
        for (let i = 0; i < differences; i++) {
          oldLines.push(`old ${i}`, `same ${i}`);
          newLines.push(`new ${i}`, `same ${i}`);
        }
        return [oldLines.join("\n") + "\n", newLines.join("\n") + "\n"];
      }

      it("says so in the footer instead of drawing an empty diff", async () => {
        const [text1, text2] = pathologicalPair(500);
        const { editor1, editor2 } = await openEditorsSideBySide(text1, text2);

        mainModule.diffEditors(editor1, editor2, {
          autoDiff: false,
          muteNotifications: true,
          computeTimeout: 1,
        });
        await pollUntil(
          () =>
            workspaceElement.querySelector(".diff-view-ui .num-diff-text")?.textContent ===
            "too many differences",
        );

        expect(workspaceElement.querySelector(".diff-view-ui .num-diff-value").textContent).toBe(
          "",
        );
        expect(editor1.getDecorations({ type: "line" }).length).toBe(0);
        expect(editor2.getDecorations({ type: "line" }).length).toBe(0);
      });

      it("warns with the budget it gave up at", async () => {
        const [text1, text2] = pathologicalPair(500);
        const { editor1, editor2 } = await openEditorsSideBySide(text1, text2);
        const warnings = [];
        spyOn(lumine.notifications, "addWarning").and.callFake((title, options) =>
          warnings.push(options.detail),
        );

        mainModule.diffEditors(editor1, editor2, { autoDiff: false, computeTimeout: 1 });
        await pollUntil(() => warnings.length > 0);

        expect(warnings[0]).toContain("1ms");
        expect(warnings[0]).toContain("Compute Timeout");
      });

      it("draws the diff normally once the budget allows it", async () => {
        const [text1, text2] = pathologicalPair(500);
        const { editor1, editor2 } = await openEditorsSideBySide(text1, text2);

        mainModule.diffEditors(editor1, editor2, {
          autoDiff: false,
          muteNotifications: true,
          computeTimeout: 0,
        });
        await pollUntil(
          () => mainModule.diffView != null && mainModule.diffView.getNumDifferences() === 500,
        );

        expect(editor1.getDecorations({ type: "line" }).length).toBeGreaterThan(0);
      });
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

  describe("when an edit outdates the diff", () => {
    it("does not measure lines the buffer no longer has", async () => {
      const { editor1, editor2 } = await openEditorsSideBySide(
        Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
        Array.from({ length: 60 }, (_, i) => (i === 30 ? "changed" : `line ${i}`)).join("\n"),
      );

      mainModule.diffEditors(editor1, editor2, { autoDiff: false, muteNotifications: true });
      await pollUntil(
        () => mainModule.diffView != null && mainModule.diffView.getNumDifferences() > 0,
      );

      // The chunks still describe 60 lines. A resize or a soft-wrap change can
      // land in this window, and it used to throw out of a timer, which opened
      // the dev tools with nothing in the console to say why.
      editor2.setText("one line\n");

      expect(() => mainModule.diffView._syncViewZoneHeights()).not.toThrow();
    });

    it("leaves the existing view zones alone until the diff catches up", async () => {
      const { editor1, editor2 } = await openEditorsSideBySide(
        Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
        Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
      );

      mainModule.diffEditors(editor1, editor2, { autoDiff: false, muteNotifications: true });
      await pollUntil(
        () => mainModule.diffView != null && mainModule.diffView.getNumDifferences() > 0,
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const zonesBefore = mainModule.diffView._editorDiffExtender2.getViewZones().length;

      editor2.setText("one line\n");
      mainModule.diffView._syncViewZoneHeights();

      // Recomputing against stale chunks would place spacers at the wrong rows,
      // so the current ones stay until the diff already on its way lands.
      expect(mainModule.diffView._editorDiffExtender2.getViewZones().length).toBe(zonesBefore);
    });
  });

  describe("equalize widths", () => {
    it("sets the flex scale on the panes rather than on their elements", async () => {
      const { editor1, editor2 } = await openEditorsSideBySide("a\nb\n", "a\nc\n");
      mainModule.diffEditors(editor1, editor2, { autoDiff: false, muteNotifications: true });
      await pollUntil(
        () => mainModule.diffView != null && mainModule.diffView.getNumDifferences() > 0,
      );

      const pane1 = lumine.workspace.paneForItem(editor1);
      const pane2 = lumine.workspace.paneForItem(editor2);
      pane1.setFlexScale(0.4);
      pane2.setFlexScale(1.6);

      mainModule.equalizeWidths();

      // A style written behind the pane's back holds only until the next thing
      // that reads the model, and then the panes spring back.
      expect(pane1.getFlexScale()).toBe(1);
      expect(pane2.getFlexScale()).toBe(1);
    });
  });

  describe("custom highlight colors", () => {
    function customStylesheet() {
      const styleElement = document
        .querySelectorAll("style[source-path='diff-view-custom-styles']")
        .item(0);
      return styleElement != null ? styleElement.textContent : null;
    }

    function alphaOf(stylesheet, selector) {
      const rule = new RegExp(`\\${selector}\\s*\\{[^}]*background-color:\\s*rgba\\(([^)]*)\\)`);
      const match = stylesheet.match(rule);
      return match != null ? Number(match[1].split(",").pop().trim()) : null;
    }

    it("keeps the line highlights lighter than the word highlights", () => {
      const stylesheet = customStylesheet();
      expect(stylesheet).not.toBeNull();

      // The two alphas come from one color object per side, so aliasing it
      // would silently give every highlight the word alpha.
      expect(alphaOf(stylesheet, ".diff-view-added-custom")).toBe(0.4);
      expect(alphaOf(stylesheet, ".diff-view-removed-custom")).toBe(0.4);
      expect(alphaOf(stylesheet, ".diff-view-word-added-custom .region")).toBe(0.5);
      expect(alphaOf(stylesheet, ".diff-view-word-removed-custom .region")).toBe(0.5);
    });

    it("recomputes both alphas when the color changes", () => {
      lumine.config.set("diff-view.addedColor", "#123456");

      const stylesheet = customStylesheet();
      expect(stylesheet).toContain("rgba(18, 52, 86, 0.4)");
      expect(stylesheet).toContain("rgba(18, 52, 86, 0.5)");
    });
  });

  describe("provided services", () => {
    it("provides the diff-view control service", async () => {
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

    it("declares the diff-view service and no split-diff alias", () => {
      const { providedServices } = lumine.packages.getActivePackage("diff-view").metadata;
      expect(providedServices["diff-view"].versions["1.0.0"]).toBe("provideDiffView");
      expect(providedServices["split-diff"]).toBeUndefined();
    });

    it("provides the scrollbar-marker data surface on the service", async () => {
      const service = mainModule.provideDiffView();
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
      expect(latest.addedColorSide).toBe("left");
      expect(service.getDiffView().chunks.length).toBeGreaterThan(0);
      expect(service.getDiffView().addedColorSide).toBe("left");

      subscription.dispose();
    });
  });
});
