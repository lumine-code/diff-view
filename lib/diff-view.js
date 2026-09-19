const fs = require("node:fs");
const path = require("node:path");
const { CompositeDisposable, Disposable, Emitter, FileState, TextBuffer } = require("lumine");
const DiffView = require("./diff-display");
const FooterView = require("./footer-view");
const SyncScroll = require("./sync-scroll");
const markerLayer = require("./marker-layer");
const { computeDiff } = require("./compute-diff");

// A one-shot TextBuffer data source. The no-op change subscription marks it as
// a self-watching custom source, so loading a snapshot does not briefly create
// a second filesystem watcher for the live editor's path.
class SavedFileSnapshot {
  constructor(filePath) {
    this.filePath = filePath;
  }

  getPath() {
    return this.filePath;
  }

  getBaseName() {
    return path.basename(this.filePath);
  }

  existsSync() {
    return fs.existsSync(this.filePath);
  }

  createReadStream() {
    return fs.createReadStream(this.filePath);
  }

  onDidChange() {
    return new Disposable();
  }
}

module.exports = {
  diffView: null,
  subscriptions: null,
  editorSubscriptions: null,
  lineEndingSubscription: null,
  contextMenuSubscriptions: null,
  isEnabled: false,
  wasEditor1Created: false,
  wasEditor2Created: false,
  ownedEditor1Pane: null,
  ownedEditor2Pane: null,
  originalEditor1SoftWrap: null,
  originalEditor2SoftWrap: null,
  docksToReopen: { left: false, right: false, bottom: false },
  splitDiffResolves: [],
  options: {},
  centerLinePosition: 0.5,
  centerLineElements: [],
  _centerLineDragCleanup: null,
  _centerLineResizeObserver: null,
  markerLayerConnection: null,
  diffRequestId: 0,
  pendingDiffRequest: null,

  activate() {
    this.contextForService = this;
    this.emitter = new Emitter();

    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "diff-view:enable": {
          description: "Compare the selected files, or the two open editors.",
          didDispatch: (event) => this.diffPanes(event),
        },
        "diff-view:next-diff": {
          description: "Move both panes to the next difference.",
          didDispatch: () => {
            if (this.isEnabled) {
              this.nextDiff();
            } else {
              this.diffPanes();
            }
          },
        },
        "diff-view:prev-diff": {
          description: "Move both panes to the previous difference.",
          didDispatch: () => {
            if (this.isEnabled) {
              this.prevDiff();
            } else {
              this.diffPanes();
            }
          },
        },
        "diff-view:copy-to-right": {
          description: "Copy this difference from the left pane to the right.",
          didDispatch: () => {
            if (this.isEnabled) {
              this.copyToRight();
            }
          },
        },
        "diff-view:copy-to-left": {
          description: "Copy this difference from the right pane to the left.",
          didDispatch: () => {
            if (this.isEnabled) {
              this.copyToLeft();
            }
          },
        },
        "diff-view:disable": {
          description: "Stop comparing, leaving both files open.",
          didDispatch: () => this.disable(),
        },
        "diff-view:close": {
          description: "Close the comparison and both of its panes.",
          didDispatch: () => this.close(),
        },
        "diff-view:set-ignore-whitespace": {
          description: "Treat lines differing only in spacing as the same.",
          didDispatch: () => this.toggleIgnoreWhitespace(),
        },
        "diff-view:set-auto-diff": {
          description: "Compare again by itself whenever either side changes.",
          didDispatch: () => this.toggleAutoDiff(),
        },
        "diff-view:toggle": () => this.toggle(),
        "diff-view:toggle-soft-wrap": {
          description: "Wrap long lines in both panes at once.",
          didDispatch: () => this.toggleSoftWrap(),
        },
        "diff-view:equalize-widths": {
          description: "Give the two panes the same width again.",
          didDispatch: () => this.equalizeWidths(),
        },
        "diff-view:git-head": {
          description: "Compare this file with the version in Git HEAD.",
          didDispatch: (event) => this.diffGit(event),
        },
        "diff-view:git-commit": {
          description: "Compare this file with its version in a commit you choose.",
          didDispatch: (event) => this.diffGit(event, "HEAD~1"),
        },
        "diff-view:diff-with-saved-file": {
          description: "Compare the current buffer with the version saved on disk.",
          didDispatch: (event) => this.diffWithSavedFile(event),
        },
        "diff-view:toggle-center-line": {
          description: "Show or hide the ribbon joining the two sides.",
          didDispatch: () => this.toggleCenterLine(),
        },
      }),
    );

    // The scrollbar/minimap layer consumes the package's own diff-view
    // service, exactly as the standalone adapter used to.
    markerLayer.activate();
    this.markerLayerConnection = markerLayer.connect(this.provideDiffView());
  },

  deactivate() {
    this.disable();
    // A disable between two diffs is a reset and the waiters keep waiting for
    // the next one, but the package going away means no diff is ever coming.
    while (this.splitDiffResolves.length) {
      this.splitDiffResolves.pop()(null);
    }
    if (this.markerLayerConnection != null) {
      this.markerLayerConnection.dispose();
      this.markerLayerConnection = null;
    }
    markerLayer.deactivate();
    this.subscriptions.dispose();
    this.emitter.dispose();
  },

  // called by "toggle" command
  // toggles split diff
  toggle() {
    if (this.isEnabled) {
      this.disable();
    } else {
      this.diffPanes();
    }
  },

  // called by "close" command
  // closes the diff view but keeps the secondary editor as a standard editor
  close() {
    this.diffRequestId++;
    this._cancelPendingDiffRequest();
    this.isEnabled = false;

    // remove listeners
    if (this.editorSubscriptions != null) {
      this.editorSubscriptions.dispose();
      this.editorSubscriptions = null;
    }
    if (this.contextMenuSubscriptions != null) {
      this.contextMenuSubscriptions.dispose();
      this.contextMenuSubscriptions = null;
    }
    if (this.lineEndingSubscription != null) {
      this.lineEndingSubscription.dispose();
      this.lineEndingSubscription = null;
    }

    if (this.diffView != null) {
      // Remove center line elements before cleanup
      this._removeCenterLineElements();

      const editor1 =
        this.diffView._editorDiffExtender1 != null
          ? this.diffView._editorDiffExtender1.getEditor()
          : null;
      const editor2 =
        this.diffView._editorDiffExtender2 != null
          ? this.diffView._editorDiffExtender2.getEditor()
          : null;

      // Restore original soft wrap state (with safety checks)
      if (editor1 != null && !editor1.isDestroyed() && this.originalEditor1SoftWrap != null) {
        try {
          editor1.setSoftWrapped(this.originalEditor1SoftWrap);
        } catch {
          /* editor may be destroyed */
        }
      }
      if (editor2 != null && !editor2.isDestroyed() && this.originalEditor2SoftWrap != null) {
        try {
          editor2.setSoftWrapped(this.originalEditor2SoftWrap);
        } catch {
          /* editor may be destroyed */
        }
      }

      // Destroy diff view (clears markers) but don't destroy editors
      this.diffView.destroy();
      this.diffView = null;
    }

    // remove views
    if (this.footerView != null) {
      this.footerView.destroy();
      this.footerView = null;
    }

    if (this.syncScroll != null) {
      this.syncScroll.dispose();
      this.syncScroll = null;
    }

    // auto hide tree view while diffing #82
    const hideDocks =
      this.options.hideDocks != null ? this.options.hideDocks : this._getConfig("hideDocks");
    if (hideDocks) {
      if (this.docksToReopen.left) {
        lumine.workspace.getLeftDock().show();
      }
      if (this.docksToReopen.right) {
        lumine.workspace.getRightDock().show();
      }
      if (this.docksToReopen.bottom) {
        lumine.workspace.getBottomDock().show();
      }
    }

    // reset all variables
    this.docksToReopen = { left: false, right: false, bottom: false };
    this.wasEditor1Created = false;
    this.wasEditor2Created = false;
    this.ownedEditor1Pane = null;
    this.ownedEditor2Pane = null;
    this.originalEditor1SoftWrap = null;
    this.originalEditor2SoftWrap = null;
    this.options = {};
    // Clear scroll-map layers
    this._updateScrollMapLayers();
  },

  _getTextEditorForEvent(event) {
    return (
      lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false }) ??
      lumine.workspace.getActiveTextEditor() ??
      null
    );
  },

  _getFilePathForEvent(event) {
    const target = event?.target;
    const tab = target?.closest?.(".tab.texteditor");
    if (tab) {
      return (
        tab.querySelector("[data-path]")?.dataset.path ??
        (typeof tab.item?.getPath === "function" ? tab.item.getPath() : null)
      );
    }

    const treeEntry = target?.closest?.(".tree-view .file");
    if (treeEntry) {
      return treeEntry.dataset?.path ?? treeEntry.querySelector("[data-path]")?.dataset.path;
    }

    return this._getTextEditorForEvent(event)?.getPath?.() ?? null;
  },

  _getFileEditorForEvent(event) {
    const target = event?.target;
    const tab = target?.closest?.(".tab.texteditor");
    if (tab && lumine.workspace.isTextEditor(tab.item)) return tab.item;
    if (target?.closest?.(".tree-view .file")) return null;
    return this._getTextEditorForEvent(event);
  },

  // Diffs the file against its git version (HEAD by default, or specified ref).
  async diffGit(event, ref = "HEAD") {
    const filePath = this._getFilePathForEvent(event);
    const targetEditor = this._getFileEditorForEvent(event);

    if (!filePath) {
      lumine.notifications.addWarning("Diff View", {
        detail: "No file found to diff",
        dismissable: false,
        icon: "diff",
      });
      return;
    }

    const requestId = ++this.diffRequestId;
    if (targetEditor != null) {
      this._preservePendingEditor(targetEditor);
    }
    this._cancelPendingDiffRequest();

    // Find the git repository and get the ref version
    let projectRepo;
    try {
      projectRepo = await lumine.project.repositoryForPath(filePath);
    } catch (error) {
      if (requestId === this.diffRequestId) this._reportDiffError(error);
      return null;
    }
    if (
      requestId !== this.diffRequestId ||
      targetEditor?.isDestroyed?.() ||
      (targetEditor != null && targetEditor.getPath() !== filePath)
    ) {
      return null;
    }
    if (projectRepo == null) {
      lumine.notifications.addWarning("Diff View", {
        detail: "File is not in a git repository",
        dismissable: false,
        icon: "diff",
      });
      return;
    }

    let gitText;
    try {
      gitText = await projectRepo.getFileAtRevision(filePath, ref);
    } catch {
      gitText = null;
    }
    if (
      requestId !== this.diffRequestId ||
      targetEditor?.isDestroyed?.() ||
      (targetEditor != null && targetEditor.getPath() !== filePath)
    ) {
      return null;
    }
    if (gitText == null) {
      lumine.notifications.addWarning("Diff View", {
        detail: `No ${ref} version found for this file`,
        dismissable: false,
        icon: "diff",
      });
      return;
    }

    if (targetEditor != null) this._preserveEditorOnDisable(targetEditor);
    this._disableActiveDiff();
    const request = { id: requestId, options: {}, allowGitFallback: false };
    const editorsPromise = this._getEditorsForGitDiff(filePath, gitText, request, targetEditor);
    return this._runDiffRequest(request, editorsPromise);
  },

  // Compares the current in-memory buffer with an independent snapshot of its
  // backing file. A missing backing file is represented by an empty snapshot,
  // which keeps the command useful after an external deletion.
  async diffWithSavedFile(event) {
    const editor1 = this._getTextEditorForEvent(event);
    if (editor1 == null) return null;

    const editorPane = lumine.workspace.paneForItem(editor1);
    if (editorPane == null) {
      lumine.notifications.addWarning("Diff View", {
        detail: "The current editor is not open in a workspace pane.",
        dismissable: false,
        icon: "diff",
      });
      return null;
    }

    const filePath = editor1.getPath();
    if (!filePath) {
      lumine.notifications.addWarning("Diff View", {
        detail: "Save the current buffer before comparing it with the saved file.",
        dismissable: false,
        icon: "diff",
      });
      return null;
    }

    const requestId = ++this.diffRequestId;
    this._preservePendingEditor(editor1);
    this._cancelPendingDiffRequest();
    const encoding = editor1.getEncoding();
    let savedBuffer;
    try {
      savedBuffer = await TextBuffer.load(new SavedFileSnapshot(filePath), {
        encoding,
        mustExist: true,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        savedBuffer = new TextBuffer({ encoding });
      } else {
        if (requestId === this.diffRequestId) {
          lumine.notifications.addWarning("Diff View", {
            detail: `Could not read the saved file: ${error.message}`,
            dismissable: false,
            icon: "diff",
          });
        }
        return null;
      }
    }

    try {
      await savedBuffer.getFileWatchStartPromise();
    } catch (error) {
      savedBuffer.destroy();
      if (requestId === this.diffRequestId) this._reportDiffError(error);
      return null;
    }

    if (
      requestId !== this.diffRequestId ||
      editor1.isDestroyed() ||
      editor1.getPath() !== filePath ||
      editor1.getEncoding() !== encoding
    ) {
      savedBuffer.destroy();
      return null;
    }

    // The loaded buffer is a snapshot, not another live owner of the path.
    // Detaching it prevents Save from overwriting the file being compared.
    try {
      savedBuffer.setPath(null);
      savedBuffer.setFileState(FileState.UNMODIFIED);
      const grammar = editor1.getGrammar();
      if (grammar?.scopeName) {
        lumine.grammars.assignLanguageMode(savedBuffer, grammar.scopeName);
      }
    } catch (error) {
      savedBuffer.destroy();
      if (requestId === this.diffRequestId) this._reportDiffError(error);
      return null;
    }

    this._preserveEditorOnDisable(editor1);
    this._disableActiveDiff();
    let editors;
    try {
      editors = this._getEditorsForSavedFile(editor1, savedBuffer);
    } catch (error) {
      if (!savedBuffer.isDestroyed()) savedBuffer.destroy();
      if (requestId === this.diffRequestId) this._reportDiffError(error);
      return null;
    }

    return this._runDiffRequest(
      { id: requestId, options: {}, allowGitFallback: false },
      Promise.resolve(editors),
    );
  },

  _getEditorsForSavedFile(editor1, savedBuffer) {
    const sourcePane = lumine.workspace.paneForItem(editor1);
    if (sourcePane == null) {
      throw new Error("The current editor is no longer open in a workspace pane.");
    }

    let editor2 = null;
    let rightPane = null;
    let createdRightPane = false;
    try {
      editor2 = lumine.workspace.buildTextEditor({ autoHeight: false, buffer: savedBuffer });
      editor2.setEncoding(editor1.getEncoding());
      const panes = lumine.workspace.getCenter().getPanes();
      const rightPaneIndex = panes.indexOf(sourcePane) + 1;
      createdRightPane = panes[rightPaneIndex] == null;
      rightPane = panes[rightPaneIndex] || sourcePane.splitRight();
      rightPane.addItem(editor2);
      rightPane.activateItem(editor2);
    } catch (error) {
      if (editor2 != null && !editor2.isDestroyed()) editor2.destroy();
      if (createdRightPane && rightPane?.getItems().length === 0) rightPane.destroy();
      throw error;
    }

    return {
      editor1,
      editor2,
      createdEditor2: true,
      ownedPane2: createdRightPane ? rightPane : null,
      editor2Encoding: editor1.getEncoding(),
    };
  },

  _preserveEditorOnDisable(editor) {
    if (this.diffView == null) return;
    if (this.diffView._editorDiffExtender1?.getEditor() === editor) {
      this.wasEditor1Created = false;
      this.ownedEditor1Pane = null;
    }
    if (this.diffView._editorDiffExtender2?.getEditor() === editor) {
      this.wasEditor2Created = false;
      this.ownedEditor2Pane = null;
    }
  },

  _preservePendingEditor(editor) {
    const editors = this.pendingDiffRequest?.editors;
    if (editors == null) return;
    if (editors.editor1 === editor) {
      editors.createdEditor1 = false;
      editors.cleanupEditor1 = false;
      editors.ownedPane1 = null;
    }
    if (editors.editor2 === editor) {
      editors.createdEditor2 = false;
      editors.cleanupEditor2 = false;
      editors.ownedPane2 = null;
    }
  },

  // Gets editors for git diff - current file on left, HEAD on right
  async _getEditorsForGitDiff(filePath, gitHeadText, request, targetEditor = null) {
    const center = lumine.workspace.getCenter();
    const editorsBeforeOpen = new Set(lumine.workspace.getTextEditors());
    const panesBeforeOpen = new Set(center.getPanes());
    const editor1 =
      targetEditor != null
        ? targetEditor
        : await lumine.workspace.open(filePath, {
            split: "left",
            activateItem: false,
            activatePane: false,
          });
    // An open can decline — an unreadable path, a full workspace center — and
    // there is nothing to diff against a file that never opened.
    if (!editor1) return null;
    const createdEditor1 = !editorsBeforeOpen.has(editor1);
    const editor1Pane = lumine.workspace.paneForItem(editor1);
    const ownedPane1 =
      editor1Pane != null && !panesBeforeOpen.has(editor1Pane) ? editor1Pane : null;
    if (!this._isCurrentDiffRequest(request)) {
      return {
        editor1,
        editor2: null,
        cleanupEditor1: createdEditor1,
        ownedPane1,
      };
    }
    if (editor1Pane == null) {
      if (createdEditor1) editor1.destroy();
      throw new Error("The file did not open in a workspace pane.");
    }
    let editor2 = null;
    let rightPane = null;
    let createdRightPane = false;

    try {
      editor1Pane.activateItem(editor1);
      editor2 = lumine.workspace.buildTextEditor({ autoHeight: false });
      // Normalize line endings to match editor1
      const BufferExtender = require("./buffer-extender");
      const buffer1LineEnding = new BufferExtender(editor1.getBuffer()).getLineEnding();
      if (["\n", "\r\n", "\r"].includes(buffer1LineEnding)) {
        editor2.getBuffer().setPreferredLineEnding(buffer1LineEnding);
        // Normalize git HEAD text line endings
        const normalizedText = gitHeadText.replace(/\r\n|\r|\n/g, buffer1LineEnding);
        editor2.setText(normalizedText);
      } else {
        editor2.setText(gitHeadText);
      }

      // Set grammar to match the original file (after text is set)
      const grammar = editor1.getGrammar();
      if (grammar && grammar.scopeName) {
        lumine.grammars.assignLanguageMode(editor2.getBuffer(), grammar.scopeName);
      }

      // Add to pane to the right
      const panes = lumine.workspace.getCenter().getPanes();
      const sourcePane = lumine.workspace.paneForItem(editor1);
      if (sourcePane == null) throw new Error("The file is no longer open in a workspace pane.");
      const rightPaneIndex = panes.indexOf(sourcePane) + 1;
      createdRightPane = panes[rightPaneIndex] == null;
      rightPane = panes[rightPaneIndex] || sourcePane.splitRight();
      rightPane.addItem(editor2);
      rightPane.activateItem(editor2);

      return {
        editor1,
        editor2,
        createdEditor2: true,
        ownedPane2: createdRightPane ? rightPane : null,
        cleanupEditor1: createdEditor1,
        ownedPane1,
      };
    } catch (error) {
      if (editor2 != null) editor2.destroy();
      if (createdRightPane && rightPane?.getItems().length === 0) rightPane.destroy();
      if (createdEditor1) this._destroyCreatedEditor(editor1, ownedPane1);
      throw error;
    }
  },

  // called by "Disable" command
  // removes diff and sync scroll, disposes of subscriptions
  disable() {
    this.diffRequestId++;
    this._cancelPendingDiffRequest();
    this._disableActiveDiff();
  },

  _disableActiveDiff() {
    this.isEnabled = false;

    // remove listeners
    if (this.editorSubscriptions != null) {
      this.editorSubscriptions.dispose();
      this.editorSubscriptions = null;
    }
    if (this.contextMenuSubscriptions != null) {
      this.contextMenuSubscriptions.dispose();
      this.contextMenuSubscriptions = null;
    }
    if (this.lineEndingSubscription != null) {
      this.lineEndingSubscription.dispose();
      this.lineEndingSubscription = null;
    }

    if (this.diffView != null) {
      // Remove center line elements before cleanup
      this._removeCenterLineElements();

      const editor1 =
        this.diffView._editorDiffExtender1 != null
          ? this.diffView._editorDiffExtender1.getEditor()
          : null;
      const editor2 =
        this.diffView._editorDiffExtender2 != null
          ? this.diffView._editorDiffExtender2.getEditor()
          : null;

      // Clean up editors (with safety checks for already-destroyed editors)
      if (this.wasEditor1Created) {
        try {
          this._destroyCreatedEditor(editor1, this.ownedEditor1Pane);
        } catch {
          /* editor may be destroyed */
        }
      } else {
        // Restore original soft wrap state for editor1
        try {
          if (editor1 != null && !editor1.isDestroyed() && this.originalEditor1SoftWrap != null) {
            editor1.setSoftWrapped(this.originalEditor1SoftWrap);
          }
        } catch {
          /* editor may be destroyed */
        }
      }
      if (this.wasEditor2Created) {
        try {
          this._destroyCreatedEditor(editor2, this.ownedEditor2Pane);
        } catch {
          /* editor may be destroyed */
        }
      } else {
        // Restore original soft wrap state for editor2
        try {
          if (editor2 != null && !editor2.isDestroyed() && this.originalEditor2SoftWrap != null) {
            editor2.setSoftWrapped(this.originalEditor2SoftWrap);
          }
        } catch {
          /* editor may be destroyed */
        }
      }
      this.diffView.destroy();
      this.diffView = null;
    }

    // remove views
    if (this.footerView != null) {
      this.footerView.destroy();
      this.footerView = null;
    }

    if (this.syncScroll != null) {
      this.syncScroll.dispose();
      this.syncScroll = null;
    }

    // auto hide tree view while diffing #82
    const hideDocks =
      this.options.hideDocks != null ? this.options.hideDocks : this._getConfig("hideDocks");
    if (hideDocks) {
      if (this.docksToReopen.left) {
        lumine.workspace.getLeftDock().show();
      }
      if (this.docksToReopen.right) {
        lumine.workspace.getRightDock().show();
      }
      if (this.docksToReopen.bottom) {
        lumine.workspace.getBottomDock().show();
      }
    }

    // reset all variables
    this.docksToReopen = { left: false, right: false, bottom: false };
    this.wasEditor1Created = false;
    this.wasEditor2Created = false;
    this.ownedEditor1Pane = null;
    this.ownedEditor2Pane = null;
    this.originalEditor1SoftWrap = null;
    this.originalEditor2SoftWrap = null;
    this.options = {};
    // Clear scroll-map layers
    this._updateScrollMapLayers();
  },

  // called by "ignore whitespace toggle" command
  toggleIgnoreWhitespace() {
    // if ignoreWhitespace is not being overridden
    if (this.options.ignoreWhitespace == null) {
      const ignoreWhitespace = this._getConfig("ignoreWhitespace");
      this._setConfig("ignoreWhitespace", !ignoreWhitespace);
      if (this.footerView != null) {
        this.footerView.setIgnoreWhitespace(!ignoreWhitespace);
      }
    }
  },

  // called by "auto diff toggle" command
  toggleAutoDiff() {
    // if autoDiff is not being overridden
    if (this.options.autoDiff == null) {
      const autoDiff = this._getConfig("autoDiff");
      this._setConfig("autoDiff", !autoDiff);
      if (this.footerView != null) {
        this.footerView.setAutoDiff(!autoDiff);
      }
    }
  },

  // called by "toggle soft-wrap" command
  toggleSoftWrap() {
    if (this.isEnabled && this.diffView != null) {
      const editor1 =
        this.diffView._editorDiffExtender1 != null
          ? this.diffView._editorDiffExtender1.getEditor()
          : null;
      const editor2 =
        this.diffView._editorDiffExtender2 != null
          ? this.diffView._editorDiffExtender2.getEditor()
          : null;
      if (editor1 != null || editor2 != null) {
        const isSoftWrapped =
          (editor1 != null && editor1.isSoftWrapped()) ||
          (editor2 != null && editor2.isSoftWrapped());
        const newValue = !isSoftWrapped;
        if (editor1 != null) {
          editor1.setSoftWrapped(newValue);
        }
        if (editor2 != null) {
          editor2.setSoftWrapped(newValue);
        }
        if (this.footerView != null) {
          this.footerView.setSoftWrap(newValue);
        }
      }
    }
  },

  // called by "equalize widths" command
  equalizeWidths() {
    if (this.isEnabled && this.diffView != null) {
      const editor1 =
        this.diffView._editorDiffExtender1 != null
          ? this.diffView._editorDiffExtender1.getEditor()
          : null;
      const editor2 =
        this.diffView._editorDiffExtender2 != null
          ? this.diffView._editorDiffExtender2.getEditor()
          : null;
      if (editor1 != null && editor2 != null) {
        const pane1 = lumine.workspace.paneForItem(editor1);
        const pane2 = lumine.workspace.paneForItem(editor2);
        // Through the model rather than the element's style: the pane writes
        // its own flex-grow from the model, so a style set behind its back
        // holds only until the next thing that asks the model — a divider
        // drag, a deserialized layout — and the panes spring back.
        if (pane1 != null && pane2 != null && pane1 !== pane2) {
          pane1.setFlexScale(1);
          pane2.setFlexScale(1);
        }
      }
    }
  },

  // called by "toggle center line" command
  toggleCenterLine() {
    if (this.isEnabled && this.diffView != null) {
      const isEnabled = this.centerLineElements.length > 0;
      if (isEnabled) {
        this._removeCenterLineElements();
        if (this.footerView != null) {
          this.footerView.setCenterLine(false);
        }
      } else {
        this._addCenterLineElement();
        if (this.footerView != null) {
          this.footerView.setCenterLine(true);
        }
      }
    }
  },

  _getCenterContainer() {
    const workspaceView = lumine.views.getView(lumine.workspace);
    if (workspaceView == null) return null;
    // Each dock has its own lumine-pane-container; find the one outside any dock
    const containers = workspaceView.querySelectorAll("lumine-pane-container");
    for (const container of containers) {
      if (container.closest("lumine-dock") == null) {
        return container;
      }
    }
    return null;
  },

  _addCenterLineElement() {
    const workspaceView = lumine.views.getView(lumine.workspace);
    if (workspaceView == null) return;
    const el = document.createElement("div");
    el.className = "diff-view-center-line";
    workspaceView.appendChild(el);
    this.centerLineElements.push(el);
    this._updateCenterLinePositions();
    el.addEventListener("mousedown", (e) => this._onCenterLineDragStart(e));
    // Observe the center container for size/position changes
    const container = this._getCenterContainer();
    if (container != null) {
      this._centerLineResizeObserver = new ResizeObserver(() => this._updateCenterLinePositions());
      this._centerLineResizeObserver.observe(container);
    }
  },

  _updateCenterLinePositions() {
    // centerLinePosition is a fraction (0–1) of the center container height.
    // Recompute absolute top/left/right from the current container rect each time.
    const container = this._getCenterContainer();
    const rect = container != null ? container.getBoundingClientRect() : null;
    for (const el of this.centerLineElements) {
      if (rect != null) {
        el.style.top = `${rect.top + rect.height * this.centerLinePosition}px`;
        el.style.left = `${rect.left}px`;
        el.style.right = `${window.innerWidth - rect.right}px`;
      }
    }
  },

  _removeCenterLineElements() {
    if (this._centerLineDragCleanup != null) {
      this._centerLineDragCleanup();
      this._centerLineDragCleanup = null;
    }
    if (this._centerLineResizeObserver != null) {
      this._centerLineResizeObserver.disconnect();
      this._centerLineResizeObserver = null;
    }
    for (const el of this.centerLineElements) {
      if (el.parentNode != null) {
        el.parentNode.removeChild(el);
      }
    }
    this.centerLineElements = [];
  },

  _onCenterLineDragStart(e) {
    e.preventDefault();
    e.stopPropagation();

    const onMouseMove = (moveEvent) => {
      if (this.centerLineElements.length === 0) return;
      const container = this._getCenterContainer();
      if (container == null) return;
      const rect = container.getBoundingClientRect();
      const fraction = (moveEvent.clientY - rect.top) / rect.height;
      this.centerLinePosition = Math.max(0, Math.min(1, fraction));
      this._updateCenterLinePositions();
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      this._centerLineDragCleanup = null;
    };

    this._centerLineDragCleanup = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  },

  // called by "Move to next diff" command
  nextDiff() {
    if (this.diffView != null) {
      let isSyncScrollEnabled = false;
      const scrollSyncType =
        this.options.scrollSyncType != null
          ? this.options.scrollSyncType
          : this._getConfig("scrollSyncType");
      if (scrollSyncType === "Vertical + Horizontal" || scrollSyncType === "Vertical") {
        isSyncScrollEnabled = true;
      }
      const selectedIndex = this.diffView.nextDiff(isSyncScrollEnabled);
      if (this.footerView != null) {
        this.footerView.showSelectionCount(selectedIndex + 1);
      }
    }
  },

  // called by "Move to previous diff" command
  prevDiff() {
    if (this.diffView != null) {
      let isSyncScrollEnabled = false;
      const scrollSyncType =
        this.options.scrollSyncType != null
          ? this.options.scrollSyncType
          : this._getConfig("scrollSyncType");
      if (scrollSyncType === "Vertical + Horizontal" || scrollSyncType === "Vertical") {
        isSyncScrollEnabled = true;
      }
      const selectedIndex = this.diffView.prevDiff(isSyncScrollEnabled);
      if (this.footerView != null) {
        this.footerView.showSelectionCount(selectedIndex + 1);
      }
    }
  },

  // called by "Copy to right" command
  copyToRight() {
    if (this.diffView != null) {
      this.diffView.copyToRight();
      if (this.footerView != null) {
        this.footerView.hideSelectionCount();
      }
    }
  },

  // called by "Copy to left" command
  copyToLeft() {
    if (this.diffView != null) {
      this.diffView.copyToLeft();
      if (this.footerView != null) {
        this.footerView.hideSelectionCount();
      }
    }
  },

  // called by the commands enable/toggle to do initial diff
  // sets up subscriptions for auto diff and disabling when a pane is destroyed
  // event is an optional argument of a file path to diff with current
  // editorsPromise is an optional argument of a promise that returns with 2 editors
  // options is an optional argument with optional properties that are used to override user's settings
  diffPanes(event, editorsPromise, options = {}) {
    const hasExplicitEditors = editorsPromise != null;
    const params = {};
    let hasFileTarget = false;
    let targetEditor = null;

    if (!hasExplicitEditors) {
      try {
        const target = event?.target;
        const tab = target?.closest?.(".tab.texteditor");
        const treeEntry = target?.closest?.(".tree-view .file");

        if (tab) {
          hasFileTarget = true;
          targetEditor = tab.item ?? null;
          params.path = tab.querySelector("[data-path]")?.dataset.path;
          if (!params.path && typeof tab.item?.copy === "function") {
            params.editorToCopy = tab.item;
          }
        } else if (treeEntry) {
          hasFileTarget = true;
          params.path =
            treeEntry.dataset?.path ?? treeEntry.querySelector("[data-path]")?.dataset.path;
        }
      } catch (error) {
        this._reportDiffError(error);
        return Promise.resolve(null);
      }
    }

    const activeEditor = lumine.workspace.getCenter().getActiveTextEditor();
    params.activeEditor = activeEditor;
    const allowGitFallback =
      !hasExplicitEditors &&
      (!hasFileTarget || (params.path != null && params.path === activeEditor?.getPath()));
    const request = {
      id: ++this.diffRequestId,
      options,
      allowGitFallback,
    };
    if (targetEditor != null) {
      this._preservePendingEditor(targetEditor);
      this._preserveEditorOnDisable(targetEditor);
    }
    if (hasFileTarget && activeEditor != null) {
      this._preservePendingEditor(activeEditor);
      this._preserveEditorOnDisable(activeEditor);
    }
    this._cancelPendingDiffRequest();
    this._disableActiveDiff();

    if (!hasExplicitEditors) {
      try {
        if (hasFileTarget && params.path) {
          editorsPromise = this._getEditorsForDiffWithActive(params, request);
        } else if (hasFileTarget && params.editorToCopy) {
          editorsPromise = this._getEditorsForDiffWithActive(params, request);
        } else {
          editorsPromise = this._getEditorsForQuickDiff();
        }
      } catch (error) {
        editorsPromise = Promise.reject(error);
      }
    }

    return this._runDiffRequest(request, editorsPromise);
  },

  async _runDiffRequest(request, editorsPromise) {
    let editors = null;
    let prepared = null;
    let stateAdopted = false;
    let cleanupPerformed = false;
    let committed = false;
    if (editorsPromise != null && typeof editorsPromise.then !== "function") {
      request.editors = editorsPromise;
    }
    this.pendingDiffRequest = request;

    try {
      editors = await Promise.resolve(editorsPromise);
      request.editors = editors;
      if (editors == null) return null;
      if (!this._isCurrentDiffRequest(request) || this._editorsAreDestroyed(editors)) return null;
      if (editors.editor2Encoding != null) {
        editors.editor2.setEncoding(editors.editor2Encoding);
      }

      prepared = await this._setupVisibleEditors(editors, request);
      if (!this._isCurrentDiffRequest(request) || this._editorsAreDestroyed(editors)) return null;

      this.options = request.options;
      this.wasEditor1Created = Boolean(editors.createdEditor1);
      this.wasEditor2Created = Boolean(editors.createdEditor2);
      this.ownedEditor1Pane = editors.ownedPane1 ?? null;
      this.ownedEditor2Pane = editors.ownedPane2 ?? null;
      this.originalEditor1SoftWrap = prepared.originalEditor1SoftWrap;
      this.originalEditor2SoftWrap = prepared.originalEditor2SoftWrap;
      this.lineEndingSubscription = prepared.lineEndingSubscription;
      prepared.lineEndingSubscription = null;
      stateAdopted = true;

      this.diffView = new DiffView(editors);

      // add listeners
      this._setupEditorSubscriptions(editors);

      // add the bottom UI panel
      if (this.footerView == null) {
        const ignoreWhitespace =
          this.options.ignoreWhitespace != null
            ? this.options.ignoreWhitespace
            : this._getConfig("ignoreWhitespace");
        const autoDiff =
          this.options.autoDiff != null ? this.options.autoDiff : this._getConfig("autoDiff");
        const softWrapEnabled =
          (editors.editor1 != null && editors.editor1.isSoftWrapped()) ||
          (editors.editor2 != null && editors.editor2.isSoftWrapped());
        this.footerView = new FooterView(
          ignoreWhitespace,
          this.options.ignoreWhitespace != null,
          autoDiff,
          this.options.autoDiff != null,
          softWrapEnabled,
        );
        this.footerView.createPanel();
      }
      this.footerView.show();

      // auto hide tree view while diffing #82
      const hideDocks =
        this.options.hideDocks != null ? this.options.hideDocks : this._getConfig("hideDocks");
      if (hideDocks) {
        this.docksToReopen.left = lumine.workspace.getLeftDock().isVisible();
        this.docksToReopen.right = lumine.workspace.getRightDock().isVisible();
        this.docksToReopen.bottom = lumine.workspace.getBottomDock().isVisible();
        lumine.workspace.getLeftDock().hide();
        lumine.workspace.getRightDock().hide();
        lumine.workspace.getBottomDock().hide();
      }

      // add context menu items for active diff (shows diff commands in editor context menu)
      this.contextMenuSubscriptions = new CompositeDisposable();
      this.contextMenuSubscriptions.add(
        lumine.contextMenu.add({
          "lumine-text-editor.diff-view": [
            { type: "separator" },
            {
              label: "Diff View",
              submenu: [
                { label: "Ignore Whitespace", command: "diff-view:set-ignore-whitespace" },
                { label: "Move to Next Diff", command: "diff-view:next-diff" },
                { label: "Move to Previous Diff", command: "diff-view:prev-diff" },
                { label: "Copy to Right", command: "diff-view:copy-to-right" },
                { label: "Copy to Left", command: "diff-view:copy-to-left" },
              ],
            },
            { type: "separator" },
          ],
        }),
      );
      committed = true;
      request.committed = true;

      // Always compute the initial state. In particular, Git fallback inserts
      // its text before the change subscriptions exist, and autoDiff may be off.
      this.updateDiff(editors);
      if (!this._isCurrentDiffRequest(request)) return null;
      return editors;
    } catch (error) {
      if (this._isCurrentDiffRequest(request)) {
        if (stateAdopted && this.diffView != null) {
          this._disableActiveDiff();
          cleanupPerformed = true;
        }
        this._reportDiffError(error);
      }
      return null;
    } finally {
      if (!committed && !cleanupPerformed && !request.resourcesCleaned) {
        prepared ??= request.prepared;
        this._cleanUpPreparedEditors(editors, prepared);
        this._cleanUpCreatedEditors(editors);
        if (stateAdopted && this._isCurrentDiffRequest(request)) {
          if (this.lineEndingSubscription != null) {
            this.lineEndingSubscription.dispose();
          }
          this.lineEndingSubscription = null;
          this.wasEditor1Created = false;
          this.wasEditor2Created = false;
          this.ownedEditor1Pane = null;
          this.ownedEditor2Pane = null;
          this.originalEditor1SoftWrap = null;
          this.originalEditor2SoftWrap = null;
          this.options = {};
        }
      }
      if (this.pendingDiffRequest === request) this.pendingDiffRequest = null;
    }
  },

  _cancelPendingDiffRequest() {
    const request = this.pendingDiffRequest;
    this.pendingDiffRequest = null;
    if (request == null || request.committed || request.resourcesCleaned) return;

    request.cancelled = true;
    if (request.editors != null) {
      this._cleanUpPreparedEditors(request.editors, request.prepared);
      this._cleanUpCreatedEditors(request.editors);
      request.resourcesCleaned = true;
    }
  },

  _isCurrentDiffRequest(request) {
    return request.id === this.diffRequestId;
  },

  _editorsAreDestroyed(editors) {
    return editors.editor1?.isDestroyed?.() || editors.editor2?.isDestroyed?.();
  },

  _reportDiffError(error) {
    lumine.notifications.addError("Diff View", {
      detail: error?.message || String(error),
      dismissable: true,
      icon: "diff",
    });
  },

  // called by both diffPanes and the editor subscription to update the diff
  updateDiff(editors) {
    this.isEnabled = true;

    // force softwrap to be off if it somehow turned back on #143
    const turnOffSoftWrap =
      this.options.turnOffSoftWrap != null
        ? this.options.turnOffSoftWrap
        : this._getConfig("turnOffSoftWrap");
    if (turnOffSoftWrap) {
      if (editors.editor1.isSoftWrapped()) {
        editors.editor1.setSoftWrapped(false);
      }
      if (editors.editor2.isSoftWrapped()) {
        editors.editor2.setSoftWrapped(false);
      }
    }

    const ignoreWhitespace =
      this.options.ignoreWhitespace != null
        ? this.options.ignoreWhitespace
        : this._getConfig("ignoreWhitespace");

    // The diff is computed here rather than in a spawned process. An ordinary
    // pair of files costs a few milliseconds, well under what the spawn and the
    // JSON round trip did, and computeTimeout is what keeps the pathological
    // pair — thousands of differences, seconds of work — from stalling the
    // window: over budget it returns null and we say so instead of drawing.
    const computeTimeout =
      this.options.computeTimeout != null
        ? this.options.computeTimeout
        : this._getConfig("computeTimeout");
    const computedDiff = computeDiff(
      editors.editor1.getText(),
      editors.editor2.getText(),
      ignoreWhitespace,
      computeTimeout,
    );

    if (computedDiff == null) {
      this._reportDiffTooLarge(computeTimeout);
      return;
    }

    this._resumeUpdateDiff(editors, computedDiff);
  },

  // the diff ran out of budget before it finished; say why nothing was drawn
  _reportDiffTooLarge(computeTimeout) {
    if (this.diffView != null) {
      this.diffView.clearDiff();
    }
    if (this.syncScroll != null) {
      this.syncScroll.dispose();
      this.syncScroll = null;
    }
    if (this.footerView != null) {
      this.footerView.setTooManyDifferences();
    }

    // A consumer awaiting the layers gets the empty ones rather than a promise
    // that never settles, and the update tells it to clear what it had drawn.
    while (this.splitDiffResolves && this.splitDiffResolves.length) {
      this.splitDiffResolves.pop()(this.diffView != null ? this.diffView.getMarkerLayers() : {});
    }
    this._updateScrollMapLayers();

    const muteNotifications =
      this.options.muteNotifications != null
        ? this.options.muteNotifications
        : this._getConfig("muteNotifications");
    if (!muteNotifications) {
      lumine.notifications.addWarning("Diff View", {
        detail:
          "The files differ too much to diff within " +
          computeTimeout +
          "ms. Raise the Compute Timeout setting to allow a slower diff.",
        dismissable: false,
        icon: "diff",
      });
    }
  },

  // resumes once the diff has been computed
  _resumeUpdateDiff(editors, computedDiff) {
    if (this.diffView == null) {
      return;
    }

    this.diffView.clearDiff();
    if (this.syncScroll != null) {
      this.syncScroll.dispose();
      this.syncScroll = null;
    }

    // grab the settings for the diff
    const addedColorSide =
      this.options.addedColorSide != null
        ? this.options.addedColorSide
        : this._getConfig("addedColorSide");
    const diffWords =
      this.options.diffWords != null ? this.options.diffWords : this._getConfig("diffWords");
    const ignoreWhitespace =
      this.options.ignoreWhitespace != null
        ? this.options.ignoreWhitespace
        : this._getConfig("ignoreWhitespace");
    this.diffView.displayDiff(computedDiff, addedColorSide, diffWords, ignoreWhitespace);

    // give the marker layers to those registered with the service
    while (this.splitDiffResolves && this.splitDiffResolves.length) {
      this.splitDiffResolves.pop()(this.diffView.getMarkerLayers());
    }

    if (this.footerView != null) {
      this.footerView.setNumDifferences(this.diffView.getNumDifferences());
    }

    const scrollSyncType =
      this.options.scrollSyncType != null
        ? this.options.scrollSyncType
        : this._getConfig("scrollSyncType");
    if (scrollSyncType === "Vertical + Horizontal") {
      this.syncScroll = new SyncScroll(editors.editor1, editors.editor2, true);
      this.syncScroll.syncPositions();
    } else if (scrollSyncType === "Vertical") {
      this.syncScroll = new SyncScroll(editors.editor1, editors.editor2, false);
      this.syncScroll.syncPositions();
    }

    // Update scroll-map layers with diff positions
    this._updateScrollMapLayers();
  },

  // Gets the first two visible editors found or creates them as needed.
  // Returns a Promise which yields a value of {editor1: TextEditor, editor2: TextEditor}
  _getEditorsForQuickDiff() {
    let editor1 = null;
    let editor2 = null;
    let createdEditor1 = false;
    let createdEditor2 = false;
    let ownedPane1 = null;
    let ownedPane2 = null;

    try {
      // try to find the first two editors
      const panes = lumine.workspace.getCenter().getPanes();
      for (const p of panes) {
        const activeItem = p.getActiveItem();
        if (lumine.workspace.isTextEditor(activeItem)) {
          if (editor1 === null) {
            editor1 = activeItem;
          } else if (editor2 === null) {
            editor2 = activeItem;
            break;
          }
        }
      }

      // auto open editor panes so we have two to diff with
      if (editor1 === null) {
        editor1 = lumine.workspace.buildTextEditor({ autoHeight: false });
        createdEditor1 = true;
        // add first editor to the first pane
        panes[0].addItem(editor1);
        panes[0].activateItem(editor1);
      }
      if (editor2 === null) {
        editor2 = lumine.workspace.buildTextEditor({ autoHeight: false });
        createdEditor2 = true;
        const rightPaneIndex = panes.indexOf(lumine.workspace.paneForItem(editor1)) + 1;
        if (panes[rightPaneIndex]) {
          // add second editor to existing pane to the right of first editor
          panes[rightPaneIndex].addItem(editor2);
          panes[rightPaneIndex].activateItem(editor2);
        } else {
          // no existing pane so split right
          ownedPane2 = lumine.workspace.paneForItem(editor1).splitRight({ items: [editor2] });
        }
        editor2
          .getBuffer()
          .setLanguageMode(
            lumine.grammars.languageModeForGrammarAndBuffer(
              editor1.getGrammar(),
              editor2.getBuffer(),
            ),
          );
      }

      return {
        editor1,
        editor2,
        createdEditor1,
        createdEditor2,
        ownedPane1,
        ownedPane2,
      };
    } catch (error) {
      if (createdEditor1) this._destroyCreatedEditor(editor1, ownedPane1);
      if (createdEditor2) this._destroyCreatedEditor(editor2, ownedPane2);
      throw error;
    }
  },

  // Gets the active editor and opens the specified file to the right of it
  // Returns a Promise which yields a value of {editor1: TextEditor, editor2: TextEditor}
  async _getEditorsForDiffWithActive(params, request) {
    let filePath;
    let editorWithoutPath = null;
    const editorToCopy = params.editorToCopy;
    const activeEditor = params.activeEditor ?? lumine.workspace.getCenter().getActiveTextEditor();

    if (activeEditor != null) {
      const editor1 = activeEditor;
      const panes = lumine.workspace.getCenter().getPanes();
      const sourcePane = lumine.workspace.paneForItem(editor1);
      if (sourcePane == null) {
        throw new Error("The active editor is no longer open in a workspace pane.");
      }
      // get index of pane following active editor pane
      const rightPaneIndex = panes.indexOf(sourcePane) + 1;
      // pane is created if there is not one to the right of the active editor
      const createdRightPane = panes[rightPaneIndex] == null;
      const rightPane = panes[rightPaneIndex] || sourcePane.splitRight();
      const itemsBeforeOpen = new Set(rightPane.getItems());
      let openedEditor = null;

      try {
        if (params.path) {
          filePath = params.path;
          if (editor1.getPath() === filePath) {
            // if diffing with itself, set filePath to null so an empty editor is
            // opened, which will cause a git diff
            filePath = null;
          }
          openedEditor = await lumine.workspace.open(filePath, {
            pane: rightPane,
            activateItem: false,
            activatePane: false,
          });
          if (openedEditor == null) {
            if (createdRightPane && rightPane.getItems().length === 0) rightPane.destroy();
            if (this._isCurrentDiffRequest(request)) {
              lumine.notifications.addWarning("Diff View", {
                detail: "The selected file could not be opened for comparison.",
                dismissable: false,
                icon: "diff",
              });
            }
            return null;
          }
          const createdEditor2 = !itemsBeforeOpen.has(openedEditor);
          if (!this._isCurrentDiffRequest(request)) {
            return {
              editor1,
              editor2: openedEditor,
              createdEditor2,
              ownedPane2: createdEditor2 && createdRightPane ? rightPane : null,
            };
          }
          if (createdEditor2) {
            openedEditor
              .getBuffer()
              .setLanguageMode(
                lumine.grammars.languageModeForGrammarAndBuffer(
                  editor1.getGrammar(),
                  openedEditor.getBuffer(),
                ),
              );
          }
          rightPane.activateItem(openedEditor);
          rightPane.activate();
          return {
            editor1,
            editor2: openedEditor,
            createdEditor2,
            ownedPane2: createdEditor2 && createdRightPane ? rightPane : null,
          };
        } else if (editorToCopy) {
          editorWithoutPath = editorToCopy.copy();
          rightPane.addItem(editorWithoutPath);
          return {
            editor1,
            editor2: editorWithoutPath,
            createdEditor2: true,
            ownedPane2: createdRightPane ? rightPane : null,
          };
        }
      } catch (error) {
        if (openedEditor != null && !itemsBeforeOpen.has(openedEditor)) {
          this._destroyCreatedEditor(openedEditor, createdRightPane ? rightPane : null);
        } else if (editorWithoutPath != null) {
          this._destroyCreatedEditor(editorWithoutPath, createdRightPane ? rightPane : null);
        } else if (createdRightPane && rightPane.getItems().length === 0) {
          rightPane.destroy();
        }
        throw error;
      }
    } else {
      const noActiveEditorMsg = "No active file found! (Try focusing a text editor)";
      lumine.notifications.addWarning("Diff View", {
        detail: noActiveEditorMsg,
        dismissable: false,
        icon: "diff",
      });
      return null;
    }

    return null;
  },

  _cleanUpPreparedEditors(editors, prepared) {
    if (prepared?.lineEndingSubscription != null) {
      prepared.lineEndingSubscription.dispose();
      prepared.lineEndingSubscription = null;
    }
    if (editors == null || prepared == null) return;

    if (prepared.changedEditor1SoftWrap && !editors.editor1?.isDestroyed?.()) {
      editors.editor1.setSoftWrapped(prepared.originalEditor1SoftWrap);
    }
    if (prepared.changedEditor2SoftWrap && !editors.editor2?.isDestroyed?.()) {
      editors.editor2.setSoftWrapped(prepared.originalEditor2SoftWrap);
    }
  },

  _cleanUpCreatedEditors(editors) {
    if (editors == null) return;
    if (editors.cleanupEditor1 ?? editors.createdEditor1) {
      this._destroyCreatedEditor(editors.editor1, editors.ownedPane1);
    }
    if (editors.cleanupEditor2 ?? editors.createdEditor2) {
      this._destroyCreatedEditor(editors.editor2, editors.ownedPane2);
    }
  },

  _destroyCreatedEditor(editor, ownedPane = null) {
    const editorIsAlive = editor != null && !editor.isDestroyed();
    const currentPane = editorIsAlive ? lumine.workspace.paneForItem(editor) : null;
    if (
      editorIsAlive &&
      ownedPane != null &&
      currentPane === ownedPane &&
      ownedPane.getItems().length === 1
    ) {
      ownedPane.destroy();
    } else if (editorIsAlive) {
      editor.destroy();
    }
    if (
      ownedPane != null &&
      lumine.workspace.getCenter().getPanes().includes(ownedPane) &&
      ownedPane.getItems().length === 0
    ) {
      ownedPane.destroy();
    }
  },

  // sets up any editor listeners
  _setupEditorSubscriptions(editors) {
    if (this.editorSubscriptions != null) {
      this.editorSubscriptions.dispose();
    }
    this.editorSubscriptions = null;
    this.editorSubscriptions = new CompositeDisposable();

    // add listeners
    const autoDiff =
      this.options.autoDiff != null ? this.options.autoDiff : this._getConfig("autoDiff");
    if (autoDiff) {
      this.editorSubscriptions.add(
        editors.editor1.onDidStopChanging(() => {
          this.updateDiff(editors);
        }),
      );
      this.editorSubscriptions.add(
        editors.editor2.onDidStopChanging(() => {
          this.updateDiff(editors);
        }),
      );
    }
    this.editorSubscriptions.add(
      editors.editor1.onDidDestroy(() => {
        this.disable();
      }),
    );
    this.editorSubscriptions.add(
      editors.editor2.onDidDestroy(() => {
        this.disable();
      }),
    );
    this.editorSubscriptions.add(
      lumine.config.onDidChange("diff-view", (event) => {
        // need to redo editor subscriptions because some settings affect the listeners themselves
        this._setupEditorSubscriptions(editors);

        // update footer view ignore whitespace checkbox if setting has changed
        if (event.newValue.ignoreWhitespace !== event.oldValue.ignoreWhitespace) {
          if (this.footerView != null) {
            this.footerView.setIgnoreWhitespace(event.newValue.ignoreWhitespace);
          }
        }
        if (event.newValue.autoDiff !== event.oldValue.autoDiff) {
          if (this.footerView != null) {
            this.footerView.setAutoDiff(event.newValue.autoDiff);
          }
        }

        this.updateDiff(editors);
      }),
    );
    this.editorSubscriptions.add(
      editors.editor1.onDidChangeCursorPosition((event) => {
        this.diffView.handleCursorChange(
          event.cursor,
          event.oldBufferPosition,
          event.newBufferPosition,
        );
      }),
    );
    this.editorSubscriptions.add(
      editors.editor2.onDidChangeCursorPosition((event) => {
        this.diffView.handleCursorChange(
          event.cursor,
          event.oldBufferPosition,
          event.newBufferPosition,
        );
      }),
    );
    this.editorSubscriptions.add(
      editors.editor1.onDidAddCursor((cursor) => {
        this.diffView.handleCursorChange(cursor, -1, cursor.getBufferPosition());
      }),
    );
    this.editorSubscriptions.add(
      editors.editor2.onDidAddCursor((cursor) => {
        this.diffView.handleCursorChange(cursor, -1, cursor.getBufferPosition());
      }),
    );
  },

  async _setupVisibleEditors(editors, request) {
    const BufferExtender = require("./buffer-extender");
    const buffer1LineEnding = new BufferExtender(editors.editor1.getBuffer()).getLineEnding();
    const prepared = {
      originalEditor1SoftWrap: editors.editor1.isSoftWrapped(),
      originalEditor2SoftWrap: editors.editor2.isSoftWrapped(),
      changedEditor1SoftWrap: false,
      changedEditor2SoftWrap: false,
      lineEndingSubscription: null,
    };
    request.prepared = prepared;

    if (editors.createdEditor2) {
      if (["\n", "\r\n", "\r"].includes(buffer1LineEnding)) {
        editors.editor2.getBuffer().setPreferredLineEnding(buffer1LineEnding);
      }
    }

    if (request.allowGitFallback) {
      await this._setupGitRepo(editors, request);
    }
    if (!this._isCurrentDiffRequest(request) || this._editorsAreDestroyed(editors)) {
      return prepared;
    }

    if (editors.createdEditor2) {
      // want to scroll a newly created editor to the first editor's position
      lumine.views.getView(editors.editor1).focus();
    }

    // unfold all lines so diffs properly align
    editors.editor1.unfoldAll();
    editors.editor2.unfoldAll();

    const muteNotifications =
      request.options.muteNotifications != null
        ? request.options.muteNotifications
        : this._getConfig("muteNotifications");
    const turnOffSoftWrap =
      request.options.turnOffSoftWrap != null
        ? request.options.turnOffSoftWrap
        : this._getConfig("turnOffSoftWrap");
    if (turnOffSoftWrap) {
      let shouldNotify = false;
      if (editors.editor1.isSoftWrapped()) {
        editors.editor1.setSoftWrapped(false);
        prepared.changedEditor1SoftWrap = true;
        shouldNotify = true;
      }
      if (editors.editor2.isSoftWrapped()) {
        editors.editor2.setSoftWrapped(false);
        prepared.changedEditor2SoftWrap = true;
        shouldNotify = true;
      }
      if (shouldNotify && !muteNotifications) {
        const softWrapMsg = "Soft wrap automatically disabled for this diff.";
        lumine.notifications.addInfo("Diff View", {
          detail: softWrapMsg,
          dismissable: false,
          icon: "diff",
        });
      }
    }

    const buffer2LineEnding = new BufferExtender(editors.editor2.getBuffer()).getLineEnding();
    if (
      buffer2LineEnding !== "" &&
      buffer1LineEnding !== buffer2LineEnding &&
      editors.editor1.getLineCount() !== 1 &&
      editors.editor2.getLineCount() !== 1 &&
      !muteNotifications
    ) {
      // pop warning if the line endings differ and we haven't done anything about it
      const lineEndingMsg = "Warning: Line endings differ!";
      lumine.notifications.addWarning("Diff View", {
        detail: lineEndingMsg,
        dismissable: false,
        icon: "diff",
      });
    }
    // Preserve the source line ending in any edits made after setup (#39).
    if (editors.createdEditor2 && ["\n", "\r\n", "\r"].includes(buffer1LineEnding)) {
      prepared.lineEndingSubscription = editors.editor2.onWillInsertText(() => {
        editors.editor2.getBuffer().setPreferredLineEnding(buffer1LineEnding);
      });
    }
    return prepared;
  },

  async _setupGitRepo(editors, request) {
    const editor1Path = editors.editor1.getPath();
    // only show git changes if the right editor is empty
    if (
      editor1Path != null &&
      editors.editor2.getLineCount() === 1 &&
      editors.editor2.lineTextForBufferRow(0) === ""
    ) {
      const projectRepo = await lumine.project.repositoryForPath(editor1Path);
      if (!this._isCurrentDiffRequest(request) || this._editorsAreDestroyed(editors)) return;
      if (projectRepo != null) {
        let gitHeadText;
        try {
          gitHeadText = await projectRepo.getFileAtRevision(editor1Path, "HEAD");
        } catch {
          gitHeadText = null;
        }
        if (
          gitHeadText != null &&
          this._isCurrentDiffRequest(request) &&
          !this._editorsAreDestroyed(editors)
        ) {
          editors.editor2.selectAll();
          editors.editor2.insertText(gitHeadText);
        }
      }
    }
  },

  _getConfig(config) {
    return lumine.config.get(`diff-view.${config}`);
  },

  _setConfig(config, value) {
    lumine.config.set(`diff-view.${config}`, value);
  },

  // --- SERVICE API ---
  getMarkerLayers() {
    return new Promise((resolve) => {
      this.splitDiffResolves.push(resolve);
    });
  },

  diffEditors(editor1, editor2, options) {
    return this.diffPanes(null, Promise.resolve({ editor1, editor2 }), options);
  },

  /**
   * Provides the diff-view service: the control API plus the diff-data
   * surface used by scrollbar-marker integrations.
   * @returns {Object} Service object
   */
  provideDiffView() {
    return {
      getMarkerLayers: this.getMarkerLayers.bind(this.contextForService),
      diffEditors: this.diffEditors.bind(this.contextForService),
      disable: this.disable.bind(this.contextForService),
      getDiffView: () => {
        if (!this.diffView) {
          return null;
        }
        return {
          chunks: this.diffView._chunks,
          editor1: this.diffView._editorDiffExtender1?.getEditor(),
          editor2: this.diffView._editorDiffExtender2?.getEditor(),
          addedColorSide: this.diffView._addedColorSide,
        };
      },
      onDidUpdate: (callback) => {
        return this.emitter.on("did-update-diff", callback);
      },
    };
  },

  provideMarkerLayer() {
    return markerLayer.provideMarkerLayer();
  },

  markerLayer,

  // Update scroll-map layers when diff changes
  _updateScrollMapLayers() {
    const data = this.diffView
      ? {
          chunks: this.diffView._chunks,
          editor1: this.diffView._editorDiffExtender1?.getEditor(),
          editor2: this.diffView._editorDiffExtender2?.getEditor(),
          addedColorSide: this.diffView._addedColorSide,
        }
      : null;
    this.emitter.emit("did-update-diff", data);
  },
};
