const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileState, TextBuffer } = require("lumine");

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

  describe("diffing a buffer with its saved file", () => {
    let tempDir;
    let tempEditors;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-view-saved-"));
      tempEditors = [];
    });

    afterEach(() => {
      mainModule.disable();
      for (const editor of tempEditors) {
        if (!editor.isDestroyed()) {
          const buffer = editor.getBuffer();
          editor.destroy();
          if (!buffer.isDestroyed()) buffer.setPath(null);
        }
      }
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    async function openSavedFile(name, text) {
      const filePath = path.join(tempDir, name);
      fs.writeFileSync(filePath, text);
      const editor = await lumine.workspace.open(filePath);
      await editor.getBuffer().getFileWatchStartPromise();
      tempEditors.push(editor);
      return { editor, filePath };
    }

    function comparedEditors() {
      return {
        editor1: mainModule.diffView._editorDiffExtender1.getEditor(),
        editor2: mainModule.diffView._editorDiffExtender2.getEditor(),
      };
    }

    it("compares unsaved changes with an independent disk snapshot", async () => {
      const { editor } = await openSavedFile("modified.txt", "saved\n");
      editor.setText("changed in buffer\n");

      await lumine.commands.dispatch(
        lumine.views.getView(editor),
        "diff-view:diff-with-saved-file",
      );

      const compared = comparedEditors();
      expect(compared.editor1).toBe(editor);
      expect(compared.editor1.getText()).toBe("changed in buffer\n");
      expect(compared.editor1.getBuffer().getFileState()).toBe(FileState.MODIFIED);
      expect(compared.editor2.getText()).toBe("saved\n");
      expect(compared.editor2.getPath()).toBeUndefined();
      expect(compared.editor2.getBuffer().getFileState()).toBe(FileState.UNMODIFIED);
      expect(mainModule.diffView.getNumDifferences()).toBe(1);

      mainModule.disable();
      expect(compared.editor1.isDestroyed()).toBe(false);
      expect(compared.editor2.isDestroyed()).toBe(true);
    });

    it("reads the external disk version of a conflicted buffer", async () => {
      const { editor, filePath } = await openSavedFile("conflicted.txt", "original\n");
      editor.setText("local changes\n");
      fs.writeFileSync(filePath, "external changes\n");
      editor.getBuffer().setFileState(FileState.CONFLICTED);

      await mainModule.diffWithSavedFile();

      expect(comparedEditors().editor1.getText()).toBe("local changes\n");
      expect(comparedEditors().editor2.getText()).toBe("external changes\n");
    });

    it("reads the disk snapshot using the buffer's encoding", async () => {
      const windows1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]);
      const { editor } = await openSavedFile("encoded.txt", windows1251);
      const reloaded = new Promise((resolve) => editor.getBuffer().onDidReload(resolve));
      editor.setEncoding("WINDOWS-1251");
      await reloaded;
      editor.setText("local\n");

      await mainModule.diffWithSavedFile();

      expect(comparedEditors().editor2.getText()).toBe("Привет\n");
      expect(comparedEditors().editor2.getEncoding()).toBe("WINDOWS-1251");
    });

    it("represents a removed file with an empty snapshot instead of Git HEAD", async () => {
      const { editor, filePath } = await openSavedFile("removed.txt", "saved\n");
      editor.setText("kept in buffer\n");
      fs.unlinkSync(filePath);
      editor.getBuffer().setFileState(FileState.REMOVED);
      const repositoryForPath = spyOn(lumine.project, "repositoryForPath").and.returnValue(
        Promise.resolve({ getFileAtRevision: () => Promise.resolve("git head\n") }),
      );

      await mainModule.diffWithSavedFile();

      expect(comparedEditors().editor2.getText()).toBe("");
      expect(repositoryForPath).not.toHaveBeenCalled();
      expect(mainModule.diffView.getNumDifferences()).toBe(1);
    });

    it("keeps an existing empty right pane when the snapshot closes", async () => {
      const { editor } = await openSavedFile("existing-pane.txt", "saved\n");
      editor.setText("buffer\n");
      const sourcePane = lumine.workspace.paneForItem(editor);
      const rightPane = sourcePane.splitRight();
      const paneCount = lumine.workspace.getCenter().getPanes().length;
      sourcePane.activateItem(editor);
      sourcePane.activate();

      await mainModule.diffWithSavedFile();
      expect(lumine.workspace.paneForItem(comparedEditors().editor2)).toBe(rightPane);
      mainModule.disable();

      expect(lumine.workspace.getCenter().getPanes()).toContain(rightPane);
      expect(lumine.workspace.getCenter().getPanes().length).toBe(paneCount);
      expect(rightPane.getItems()).toEqual([]);
    });

    it("removes only its own pane after the snapshot tab is moved", async () => {
      const { editor } = await openSavedFile("moved-snapshot.txt", "saved\n");
      editor.setText("buffer\n");
      const sourcePane = lumine.workspace.paneForItem(editor);

      await mainModule.diffWithSavedFile();
      const snapshot = comparedEditors().editor2;
      const ownedPane = lumine.workspace.paneForItem(snapshot);
      const existingPane = sourcePane.splitDown();
      ownedPane.moveItemToPane(snapshot, existingPane, 0);
      mainModule.disable();

      expect(snapshot.isDestroyed()).toBe(true);
      expect(lumine.workspace.getCenter().getPanes()).not.toContain(ownedPane);
      expect(lumine.workspace.getCenter().getPanes()).toContain(existingPane);
    });

    it("removes its empty pane when the snapshot is closed by hand", async () => {
      const { editor } = await openSavedFile("closed-snapshot.txt", "saved\n");
      editor.setText("buffer\n");

      await mainModule.diffWithSavedFile();
      const snapshot = comparedEditors().editor2;
      const ownedPane = lumine.workspace.paneForItem(snapshot);
      snapshot.destroy();

      expect(mainModule.diffView).toBeNull();
      expect(lumine.workspace.getCenter().getPanes()).not.toContain(ownedPane);
    });

    it("uses the editor under the dispatch target before the active editor", async () => {
      const first = await openSavedFile("first.txt", "first saved\n");
      first.editor.setText("first buffer\n");
      lumine.workspace.getActivePane().splitRight();
      const second = await openSavedFile("second.txt", "second saved\n");
      second.editor.setText("second buffer\n");

      await mainModule.diffWithSavedFile({ target: lumine.views.getView(first.editor) });

      expect(comparedEditors().editor1).toBe(first.editor);
      expect(comparedEditors().editor2.getText()).toBe("first saved\n");
    });

    it("warns for a buffer that has never been saved", async () => {
      const editor = await lumine.workspace.open();
      editor.setText("unsaved\n");
      const warnings = [];
      spyOn(lumine.notifications, "addWarning").and.callFake((_title, options) =>
        warnings.push(options.detail),
      );
      const paneCount = lumine.workspace.getCenter().getPanes().length;

      await mainModule.diffWithSavedFile();

      expect(warnings).toEqual([
        "Save the current buffer before comparing it with the saved file.",
      ]);
      expect(mainModule.diffView).toBeNull();
      expect(lumine.workspace.getCenter().getPanes().length).toBe(paneCount);
    });

    it("stays silent when there is no editor surface", async () => {
      const warning = spyOn(lumine.notifications, "addWarning");
      spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(null);

      await mainModule.diffWithSavedFile();

      expect(warning).not.toHaveBeenCalled();
    });

    it("reports read failures without opening an orphan pane", async () => {
      await openSavedFile("unreadable.txt", "saved\n");
      spyOn(TextBuffer, "load").and.returnValue(Promise.reject(new Error("read denied")));
      const warnings = [];
      spyOn(lumine.notifications, "addWarning").and.callFake((_title, options) =>
        warnings.push(options.detail),
      );
      const paneCount = lumine.workspace.getCenter().getPanes().length;

      await mainModule.diffWithSavedFile();

      expect(warnings).toEqual(["Could not read the saved file: read denied"]);
      expect(mainModule.diffView).toBeNull();
      expect(lumine.workspace.getCenter().getPanes().length).toBe(paneCount);
    });

    it("does not revive a request that was disabled while its file was loading", async () => {
      await openSavedFile("slow.txt", "saved\n");
      let resolveLoad;
      spyOn(TextBuffer, "load").and.returnValue(
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
      );
      const pending = mainModule.diffWithSavedFile();
      const snapshot = new TextBuffer({ text: "saved\n" });

      mainModule.disable();
      resolveLoad(snapshot);
      await pending;

      expect(mainModule.diffView).toBeNull();
      expect(snapshot.isDestroyed()).toBe(true);
    });

    it("drops a snapshot if the buffer changes path while it is loading", async () => {
      const { editor } = await openSavedFile("old-name.txt", "saved\n");
      let resolveLoad;
      spyOn(TextBuffer, "load").and.returnValue(
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
      );
      const pending = mainModule.diffWithSavedFile();
      const snapshot = new TextBuffer({ text: "saved\n" });

      editor.getBuffer().setPath(path.join(tempDir, "new-name.txt"));
      resolveLoad(snapshot);
      await pending;

      expect(mainModule.diffView).toBeNull();
      expect(snapshot.isDestroyed()).toBe(true);
    });

    it("keeps a comparison editor that was already open", async () => {
      const left = await openSavedFile("already-left.txt", "left\n");
      const leftPane = lumine.workspace.paneForItem(left.editor);
      leftPane.splitRight();
      const right = await openSavedFile("already-right.txt", "right\n");
      leftPane.activateItem(left.editor);
      leftPane.activate();
      const treeEntry = {
        dataset: { path: right.filePath },
        querySelector: () => null,
      };
      const event = {
        target: {
          closest: (selector) => (selector === ".tree-view .file" ? treeEntry : null),
        },
      };

      await mainModule.diffPanes(event, null, { autoDiff: false, muteNotifications: true });
      expect(comparedEditors().editor2).toBe(right.editor);
      mainModule.disable();

      expect(right.editor.isDestroyed()).toBe(false);
      expect(lumine.workspace.paneForItem(right.editor)).not.toBeNull();
    });

    it("keeps a created comparison tab when it becomes the next target", async () => {
      await openSavedFile("tab-source.txt", "source\n");
      const targetPath = path.join(tempDir, "tab-target.txt");
      fs.writeFileSync(targetPath, "target\n");
      const treeEntry = { dataset: { path: targetPath }, querySelector: () => null };
      const treeEvent = {
        target: {
          closest: (selector) => (selector === ".tree-view .file" ? treeEntry : null),
        },
      };
      await mainModule.diffPanes(treeEvent, null, { autoDiff: false, muteNotifications: true });
      const targetEditor = comparedEditors().editor2;
      await targetEditor.getBuffer().getFileWatchStartPromise();
      tempEditors.push(targetEditor);
      const tab = {
        item: targetEditor,
        querySelector: () => ({ dataset: { path: targetPath } }),
      };
      const tabEvent = {
        target: {
          closest: (selector) => (selector === ".tab.texteditor" ? tab : null),
        },
      };

      await mainModule.diffPanes(tabEvent, null, { autoDiff: false, muteNotifications: true });

      expect(targetEditor.isDestroyed()).toBe(false);
      expect(comparedEditors().editor2).toBe(targetEditor);
    });

    it("keeps unsaved changes in a created tab when starting its Git diff", async () => {
      await openSavedFile("git-created-source.txt", "source\n");
      const targetPath = path.join(tempDir, "git-created-target.txt");
      fs.writeFileSync(targetPath, "target\n");
      const treeEntry = { dataset: { path: targetPath }, querySelector: () => null };
      const treeEvent = {
        target: {
          closest: (selector) => (selector === ".tree-view .file" ? treeEntry : null),
        },
      };
      await mainModule.diffPanes(treeEvent, null, { autoDiff: false, muteNotifications: true });
      const targetEditor = comparedEditors().editor2;
      await targetEditor.getBuffer().getFileWatchStartPromise();
      tempEditors.push(targetEditor);
      targetEditor.setText("unsaved target\n");
      spyOn(lumine.project, "repositoryForPath").and.returnValue(
        Promise.resolve({ getFileAtRevision: () => Promise.resolve("head target\n") }),
      );
      const tab = {
        item: targetEditor,
        querySelector: () => ({ dataset: { path: targetPath } }),
      };
      const tabEvent = {
        target: {
          closest: (selector) => (selector === ".tab.texteditor" ? tab : null),
        },
      };

      await mainModule.diffGit(tabEvent);

      expect(targetEditor.isDestroyed()).toBe(false);
      expect(comparedEditors().editor1).toBe(targetEditor);
      expect(comparedEditors().editor1.getText()).toBe("unsaved target\n");
      expect(comparedEditors().editor2.getText()).toBe("head target\n");
    });

    it("does not replace an explicit empty editor with Git HEAD", async () => {
      const { editor } = await openSavedFile("explicit.txt", "left\n");
      lumine.workspace.getActivePane().splitRight();
      const emptyEditor = await lumine.workspace.open();
      const repositoryForPath = spyOn(lumine.project, "repositoryForPath").and.returnValue(
        Promise.resolve({ getFileAtRevision: () => Promise.resolve("git head\n") }),
      );

      await mainModule.diffEditors(editor, emptyEditor, {
        autoDiff: false,
        muteNotifications: true,
      });

      expect(comparedEditors().editor2).toBe(emptyEditor);
      expect(comparedEditors().editor2.getText()).toBe("");
      expect(repositoryForPath).not.toHaveBeenCalled();
    });

    it("does not replace a selected empty file with Git HEAD", async () => {
      await openSavedFile("empty-target-left.txt", "left\n");
      const emptyPath = path.join(tempDir, "empty-target.txt");
      fs.writeFileSync(emptyPath, "");
      const repositoryForPath = spyOn(lumine.project, "repositoryForPath").and.returnValue(
        Promise.resolve({ getFileAtRevision: () => Promise.resolve("git head\n") }),
      );
      const treeEntry = { dataset: { path: emptyPath }, querySelector: () => null };
      const event = {
        target: {
          closest: (selector) => (selector === ".tree-view .file" ? treeEntry : null),
        },
      };

      await mainModule.diffPanes(event, null, { autoDiff: false, muteNotifications: true });

      const targetBuffer = comparedEditors().editor2.getBuffer();
      await targetBuffer.getFileWatchStartPromise();
      expect(comparedEditors().editor2.getText()).toBe("");
      expect(repositoryForPath).not.toHaveBeenCalled();
      mainModule.disable();
      if (!targetBuffer.isDestroyed()) targetBuffer.setPath(null);
    });

    it("computes a quick Git fallback even when auto diff is disabled", async () => {
      await openSavedFile("quick-git.txt", "working tree\n");
      spyOn(lumine.project, "repositoryForPath").and.returnValue(
        Promise.resolve({ getFileAtRevision: () => Promise.resolve("git head\n") }),
      );

      await mainModule.diffPanes(null, null, { autoDiff: false, muteNotifications: true });

      expect(comparedEditors().editor2.getText()).toBe("git head\n");
      expect(mainModule.diffView.getNumDifferences()).toBe(1);
    });

    it("does not insert the word Mixed into a Git snapshot", async () => {
      await openSavedFile("mixed.txt", "one\r\ntwo\n");
      spyOn(lumine.project, "repositoryForPath").and.returnValue(
        Promise.resolve({ getFileAtRevision: () => Promise.resolve("one\nchanged\n") }),
      );

      await mainModule.diffGit();

      expect(comparedEditors().editor2.getText()).toBe("one\nchanged\n");
      expect(comparedEditors().editor2.getText()).not.toContain("Mixed");
    });

    it("shows the Git target when another tab was active", async () => {
      const active = await openSavedFile("git-active.txt", "active\n");
      const target = await openSavedFile("git-target.txt", "target\n");
      const targetPane = lumine.workspace.paneForItem(target.editor);
      targetPane.activateItem(active.editor);
      spyOn(lumine.project, "repositoryForPath").and.returnValue(
        Promise.resolve({ getFileAtRevision: () => Promise.resolve("head target\n") }),
      );
      const treeEntry = { dataset: { path: target.filePath }, querySelector: () => null };
      const event = {
        target: {
          closest: (selector) => (selector === ".tree-view .file" ? treeEntry : null),
        },
      };

      await mainModule.diffGit(event);

      expect(comparedEditors().editor1).toBe(target.editor);
      expect(targetPane.getActiveItem()).toBe(target.editor);
    });
  });

  describe("diff request failures", () => {
    it("handles a rejected editor request without an unhandled rejection", async () => {
      const errors = [];
      spyOn(lumine.notifications, "addError").and.callFake((_title, options) =>
        errors.push(options.detail),
      );

      const result = await mainModule.diffPanes(
        null,
        Promise.reject(new Error("editor request failed")),
      );

      expect(result).toBeNull();
      expect(errors).toEqual(["editor request failed"]);
      expect(mainModule.diffView).toBeNull();
    });

    it("reports a synchronous quick-diff setup failure", async () => {
      spyOn(lumine.workspace, "getTextEditors").and.returnValue([]);
      spyOn(lumine.workspace, "buildTextEditor").and.throwError("could not build editor");
      const errors = [];
      spyOn(lumine.notifications, "addError").and.callFake((_title, options) =>
        errors.push(options.detail),
      );

      const result = await mainModule.diffPanes();

      expect(result).toBeNull();
      expect(errors).toEqual(["could not build editor"]);
    });

    it("cleans up a stale request without replacing the newer diff", async () => {
      const { editor1, editor2 } = await openEditorsSideBySide("new left\n", "new right\n");
      const staleEditor = lumine.workspace.buildTextEditor({ autoHeight: false });
      let resolveStale;
      const stale = mainModule.diffPanes(
        null,
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
        { autoDiff: false, muteNotifications: true },
      );

      await mainModule.diffEditors(editor1, editor2, {
        autoDiff: false,
        muteNotifications: true,
      });
      const currentDiff = mainModule.diffView;
      resolveStale({ editor1, editor2: staleEditor, createdEditor2: true });
      await stale;

      expect(mainModule.diffView).toBe(currentDiff);
      expect(staleEditor.isDestroyed()).toBe(true);
    });

    it("does not let a second quick diff reuse the first request's scratch editor", async () => {
      const editor = await lumine.workspace.open();
      editor.setText("left\n");
      const initialPaneCount = lumine.workspace.getCenter().getPanes().length;

      const first = mainModule.diffPanes(null, null, {
        autoDiff: false,
        muteNotifications: true,
      });
      const firstScratch = mainModule.pendingDiffRequest.editors.editor2;
      const second = mainModule.diffPanes(null, null, {
        autoDiff: false,
        muteNotifications: true,
      });
      const secondScratch = mainModule.pendingDiffRequest.editors.editor2;

      await Promise.all([first, second]);

      expect(firstScratch.isDestroyed()).toBe(true);
      expect(secondScratch).not.toBe(firstScratch);
      expect(secondScratch.isDestroyed()).toBe(false);
      expect(mainModule.diffView._editorDiffExtender2.getEditor()).toBe(secondScratch);
      expect(lumine.workspace.getCenter().getPanes().length).toBe(initialPaneCount + 1);
    });

    it("does not undo a soft-wrap change made while setup is waiting", async () => {
      const { editor1 } = await openEditorsSideBySide("left\n", "right\n");
      editor1.setSoftWrapped(false);
      let resolveGitSetup;
      const setupGitRepo = spyOn(mainModule, "_setupGitRepo").and.returnValue(
        new Promise((resolve) => {
          resolveGitSetup = resolve;
        }),
      );
      const pending = mainModule.diffPanes(null, null, {
        turnOffSoftWrap: true,
        muteNotifications: true,
      });
      await pollUntil(() => setupGitRepo.calls.count() === 1);

      editor1.setSoftWrapped(true);
      mainModule.disable();
      resolveGitSetup();
      await pending;

      expect(editor1.isSoftWrapped()).toBe(true);
    });

    it("does not recommit after an update subscriber disables the diff", async () => {
      const { editor1, editor2 } = await openEditorsSideBySide("left\n", "right\n");
      const subscription = mainModule.provideDiffView().onDidUpdate(() => {
        if (mainModule.isEnabled) mainModule.disable();
      });

      const result = await mainModule.diffEditors(editor1, editor2, {
        autoDiff: false,
        muteNotifications: true,
      });

      expect(result).toBeNull();
      expect(mainModule.diffView).toBeNull();
      expect(mainModule.contextMenuSubscriptions).toBeNull();
      subscription.dispose();
    });
  });

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

  describe("highlight colors", () => {
    it("uses package CSS variables with syntax color fallbacks", () => {
      const stylesheet = fs.readFileSync(
        path.join(__dirname, "..", "styles", "diff-view.css"),
        "utf8",
      );

      expect(stylesheet).toContain("var(--diff-view-added-color, var(--syntax-color-added))");
      expect(stylesheet).toContain("var(--diff-view-removed-color, var(--syntax-color-removed))");
    });

    it("does not register redundant color settings", () => {
      const { configSchema } = lumine.packages.getActivePackage("diff-view").metadata;
      expect(configSchema.overrideThemeColors).toBeUndefined();
      expect(configSchema.addedColor).toBeUndefined();
      expect(configSchema.removedColor).toBeUndefined();
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
