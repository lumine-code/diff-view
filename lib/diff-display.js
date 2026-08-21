const { CompositeDisposable } = require("lumine");
const EditorDiffExtender = require("./editor-diff-extender");
const ComputeWordDiff = require("./compute-word-diff");

module.exports = class DiffView {
  /*
   * @param editors Array of editors being diffed.
   */
  constructor(editors) {
    this._editorDiffExtender1 = new EditorDiffExtender(editors.editor1);
    this._editorDiffExtender2 = new EditorDiffExtender(editors.editor2);
    this._chunks = [];
    this._destroyed = false;
    this._syncTimeout = null;
    this._addedColorSide = "left";
    this._isSelectionActive = false;
    this._selectedChunkIndex = 0;
    this._COPY_HELP_MESSAGE = "No differences selected.";
    this._markerLayers = {};
    this._subscriptions = new CompositeDisposable();

    // Set up soft-wrap change listeners for dynamic updates
    this._setupSoftWrapListeners(editors.editor1, editors.editor2);
  }

  /**
   * Sets up listeners for soft-wrap changes and resize events on both editors.
   * When soft-wrap settings or editor widths change, we recalculate view zone heights.
   * Note: We always recalculate because long lines can wrap even without
   * explicit soft-wrap when they exceed the editor width.
   */
  _setupSoftWrapListeners(editor1, editor2) {
    // Explicit soft-wrap toggle
    this._subscriptions.add(
      editor1.onDidChangeSoftWrapped(() => this._onSoftWrapChanged()),
      editor2.onDidChangeSoftWrapped(() => this._onSoftWrapChanged()),
    );

    // Patch updateModelSoftWrapColumn on both editors.
    // By comparing softWrapColumn before/after the call we know exactly when
    // the wrap layout changed and can sync with guaranteed-fresh screen rows.
    // This works with scroll-keeper (which gates the same function) because
    // we only schedule a sync when the column value actually differs.
    var self = this;
    var scheduleSync = function () {
      if (self._syncTimeout) clearTimeout(self._syncTimeout);
      self._syncTimeout = setTimeout(function () {
        self._syncTimeout = null;
        self._syncViewZoneHeights();
      }, 50);
    };

    this._patchSoftWrapColumn(editor1, scheduleSync);
    this._patchSoftWrapColumn(editor2, scheduleSync);

    // No ResizeObserver on the editors. Watching them for width changes
    // duplicated the patch above — a width change re-wraps only by moving the
    // soft-wrap column, and with soft wrap off that column is a constant, so
    // the wrapping and the heights cannot change with the width at all. What
    // it did add was the browser's "ResizeObserver loop completed with
    // undelivered notifications", raised whenever the editor re-laid itself
    // out while the observer still had notifications pending. Chrome reports
    // that through window.onerror, and the editor's uncaught-error reporter
    // opens the dev tools for it with nothing in the console to say why —
    // which is what a resize, Equalize Widths included, did to a diff.
    //
    // The font size is the one thing left that changes a line's height without
    // touching the wrap column, and the spacers are measured in pixels.
    this._subscriptions.add(lumine.config.onDidChange("editor.fontSize", scheduleSync));
  }

  _patchSoftWrapColumn(editor, scheduleSync) {
    var component = editor.component;
    if (!component || !component.updateModelSoftWrapColumn) return;

    var original = component.updateModelSoftWrapColumn.bind(component);
    var wrapper = function () {
      var before = editor.displayLayer ? editor.displayLayer.softWrapColumn : undefined;
      original();
      var after = editor.displayLayer ? editor.displayLayer.softWrapColumn : undefined;
      if (before !== after) {
        scheduleSync();
      }
    };
    component.updateModelSoftWrapColumn = wrapper;

    if (!this._softWrapPatches) this._softWrapPatches = [];
    this._softWrapPatches.push({ component, original, wrapper });
  }

  /**
   * Called when soft-wrap settings change on either editor.
   * Recalculates view zone heights to maintain proper alignment.
   */
  _onSoftWrapChanged() {
    requestAnimationFrame(() => {
      this._syncViewZoneHeights();
    });
  }

  /**
   * Synchronizes view zone heights between the two editors using VS Code-style
   * line-by-line alignment. For each corresponding buffer line, if the screen
   * heights differ (due to wrapping), a view zone is added to the shorter side.
   *
   * This handles both explicit soft-wrap and implicit wrapping when long lines
   * exceed the editor width.
   */
  _syncViewZoneHeights() {
    // The 50 ms debounce and the soft-wrap rAF both outlive destroy(); the
    // extenders they would measure are gone by then.
    if (this._destroyed) {
      return;
    }

    var editor1 = this._editorDiffExtender1.getEditor();
    var editor2 = this._editorDiffExtender2.getEditor();

    // The chunks describe the buffers as they were when the diff was computed,
    // and a resize or a soft-wrap change can land in the window between an edit
    // and the diff that follows it. Measuring lines that no longer exist places
    // spacers at the wrong rows, so leave the current ones alone and wait for
    // the diff already on its way.
    if (!this._chunksFitBuffers()) {
      return;
    }

    // Collected first and applied at the end, so the extenders can leave the
    // zones that are already right in place instead of rebuilding all of them.
    this._desiredZones1 = new Map();
    this._desiredZones2 = new Map();
    // One line can be owed height twice — the per-line walk for its own extra
    // wrap, and a chunk for the gap that follows it — so heights accumulate.
    // Overwriting dropped one of the two and the sides came apart by exactly
    // that zone whenever the panes were unequal.
    this._addDesiredZone = (map, lineNumber, height) => {
      map.set(lineNumber, (map.get(lineNumber) || 0) + height);
    };

    // Current position in each editor (buffer line numbers)
    var pos1 = 0;
    var pos2 = 0;

    // Track cumulative height difference
    // Track cumulative height difference (positive = editor1 taller, negative = editor2 taller)

    // Process chunks and unchanged regions
    var chunks = this._chunks || [];

    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i];

      // === Process unchanged region before this chunk (line by line) ===
      this._syncUnchangedRegion(pos1, chunk.oldLineStart, pos2, chunk.newLineStart);

      // === Process the chunk itself ===
      // For changed regions, compare total heights and add a single view zone,
      // which covers both the line-count difference and any wrapping inside it
      var chunkHeight1 = this._editorDiffExtender1.getBufferRangeHeight(
        chunk.oldLineStart,
        chunk.oldLineEnd,
      );
      var chunkHeight2 = this._editorDiffExtender2.getBufferRangeHeight(
        chunk.newLineStart,
        chunk.newLineEnd,
      );

      var chunkDiff = chunkHeight1 - chunkHeight2;
      if (chunkDiff > 0) {
        // Editor 1 chunk is taller (or has more wrapped content), add spacer to editor 2
        // For non-empty chunks: place after the last line of content
        // For empty chunks (pure deletion): place before chunk position (matching static offset)
        var position =
          chunk.newLineEnd > chunk.newLineStart ? chunk.newLineEnd - 1 : chunk.newLineStart - 1;
        if (position >= 0) {
          this._addDesiredZone(this._desiredZones2, position, chunkDiff);
        }
      } else if (chunkDiff < 0) {
        // Editor 2 chunk is taller, add spacer to editor 1
        // For non-empty chunks: place after the last line of content
        // For empty chunks (pure addition): place before chunk position (matching static offset)
        position =
          chunk.oldLineEnd > chunk.oldLineStart ? chunk.oldLineEnd - 1 : chunk.oldLineStart - 1;
        if (position >= 0) {
          this._addDesiredZone(this._desiredZones1, position, -chunkDiff);
        }
      }

      // Update positions to end of this chunk
      pos1 = chunk.oldLineEnd;
      pos2 = chunk.newLineEnd;
    }

    // === Process remaining unchanged lines after last chunk ===
    var lastLine1 = editor1.getLastBufferRow() + 1;
    var lastLine2 = editor2.getLastBufferRow() + 1;

    this._syncUnchangedRegion(pos1, lastLine1, pos2, lastLine2);

    this._editorDiffExtender1.syncViewZones(this._desiredZones1);
    this._editorDiffExtender2.syncViewZones(this._desiredZones2);
    this._desiredZones1 = null;
    this._desiredZones2 = null;
  }

  /**
   * Whether the chunks still describe the buffers in front of us. The chunks
   * are ordered, so the last one's end lines bound every line number the sync
   * derives from them.
   *
   * @return Whether the chunk line numbers are within both buffers.
   */
  _chunksFitBuffers() {
    var chunks = this._chunks || [];
    if (chunks.length === 0) {
      return true;
    }

    var lastChunk = chunks[chunks.length - 1];
    return (
      lastChunk.oldLineEnd <= this._editorDiffExtender1.getEditor().getLineCount() &&
      lastChunk.newLineEnd <= this._editorDiffExtender2.getEditor().getLineCount()
    );
  }

  /**
   * Synchronizes an unchanged region line by line.
   * For each corresponding buffer line, compares screen heights and adds
   * view zones where they differ.
   *
   * @param start1 Start buffer line in editor 1
   * @param end1 End buffer line in editor 1 (exclusive)
   * @param start2 Start buffer line in editor 2
   * @param end2 End buffer line in editor 2 (exclusive)
   */
  _syncUnchangedRegion(start1, end1, start2, end2) {
    // Never measure past either buffer: the region ends come from chunk
    // boundaries, and the last one runs to a line count taken before the last
    // edit landed.
    var lineCount = Math.min(
      end1 - start1,
      end2 - start2,
      this._editorDiffExtender1.getEditor().getLineCount() - start1,
      this._editorDiffExtender2.getEditor().getLineCount() - start2,
    );
    if (lineCount <= 0) {
      return;
    }

    // A region of n buffer lines spanning exactly n screen rows cannot contain
    // a wrapped line, since every line spans at least one row. When that holds
    // on both sides every line pair already matches, so two range queries
    // settle the whole region instead of two per line — and nothing wrapping
    // is the common case.
    var rows1 = this._editorDiffExtender1.getBufferRangeScreenRowCount(start1, start1 + lineCount);
    var rows2 = this._editorDiffExtender2.getBufferRangeScreenRowCount(start2, start2 + lineCount);
    if (rows1 === lineCount && rows2 === lineCount) {
      return;
    }

    for (var i = 0; i < lineCount; i++) {
      var line1 = start1 + i;
      var line2 = start2 + i;

      var height1 = this._editorDiffExtender1.getWrappedLineHeight(line1);
      var height2 = this._editorDiffExtender2.getWrappedLineHeight(line2);

      var diff = height1 - height2;
      if (diff > 0) {
        // Line in editor 1 is taller (wraps more), add spacer to editor 2
        this._addDesiredZone(this._desiredZones2, line2, diff);
      } else if (diff < 0) {
        // Line in editor 2 is taller (wraps more), add spacer to editor 1
        this._addDesiredZone(this._desiredZones1, line1, -diff);
      }
    }
  }

  /**
   * Adds highlighting to the editors to show the diff.
   *
   * @param diff The diff to highlight.
   * @param addedColorSide The side that the added highlights should be applied to. Either 'left' or 'right'.
   * @param isWordDiffEnabled Whether differences between words per line should be highlighted.
   * @param isWhitespaceIgnored Whether whitespace should be ignored.
   * @param useCustomStyle Whether to use the user's customized highlight colors.
   */
  displayDiff(diff, addedColorSide, isWordDiffEnabled, isWhitespaceIgnored, useCustomStyle) {
    this._chunks = diff.chunks || [];
    this._addedColorSide = addedColorSide;

    var leftHighlightType = "added";
    var rightHighlightType = "removed";
    if (addedColorSide == "right") {
      leftHighlightType = "removed";
      rightHighlightType = "added";
    }
    if (useCustomStyle) {
      leftHighlightType += "-custom";
      rightHighlightType += "-custom";
    }

    for (var chunk of this._chunks) {
      this._editorDiffExtender1.highlightLines(
        chunk.oldLineStart,
        chunk.oldLineEnd,
        leftHighlightType,
      );
      this._editorDiffExtender2.highlightLines(
        chunk.newLineStart,
        chunk.newLineEnd,
        rightHighlightType,
      );

      if (isWordDiffEnabled) {
        this._highlightWordsInChunk(
          chunk,
          leftHighlightType,
          rightHighlightType,
          isWhitespaceIgnored,
        );
      }
    }

    this._markerLayers = {
      editor1: {
        id: this._editorDiffExtender1.getEditor().id,
        lineMarkerLayer: this._editorDiffExtender1.getLineMarkerLayer(),
        highlightType: leftHighlightType,
        selectionMarkerLayer: this._editorDiffExtender1.getSelectionMarkerLayer(),
      },
      editor2: {
        id: this._editorDiffExtender2.getEditor().id,
        lineMarkerLayer: this._editorDiffExtender2.getLineMarkerLayer(),
        highlightType: rightHighlightType,
        selectionMarkerLayer: this._editorDiffExtender2.getSelectionMarkerLayer(),
      },
    };

    // Sync view zone heights for soft-wrap alignment
    requestAnimationFrame(() => {
      this._syncViewZoneHeights();
    });
  }

  /**
   * Clears the diff highlighting and offsets from the editors.
   */
  clearDiff() {
    this._editorDiffExtender1.destroyMarkers();
    this._editorDiffExtender2.destroyMarkers();
    // The chunks describe the markers just destroyed, so they go with them.
    // displayDiff sets them again; a diff that never gets that far leaves
    // nothing behind for a service consumer to draw from.
    this._chunks = [];
    this._isSelectionActive = false;
    this._selectedChunkIndex = 0;
  }

  /**
   * Called to move the current selection highlight to the next diff chunk.
   * @param isSyncScrollEnabled Only autoscroll one editor if sync scroll is enabled or we will get in an infinite loop
   */
  nextDiff(isSyncScrollEnabled) {
    if (this._isSelectionActive) {
      this._selectedChunkIndex++;
      if (this._selectedChunkIndex >= this.getNumDifferences()) {
        this._selectedChunkIndex = 0;
      }
    } else {
      this._isSelectionActive = true;
    }

    var success = this._selectChunk(this._selectedChunkIndex, true, isSyncScrollEnabled);
    if (!success) {
      return -1;
    }

    return this._selectedChunkIndex;
  }

  /**
   * Called to move the current selection highlight to the previous diff chunk.
   * @param isSyncScrollEnabled Only autoscroll one editor if sync scroll is enabled or we will get in an infinite loop
   */
  prevDiff(isSyncScrollEnabled) {
    if (this._isSelectionActive) {
      this._selectedChunkIndex--;
      if (this._selectedChunkIndex < 0) {
        this._selectedChunkIndex = this.getNumDifferences() - 1;
      }
    } else {
      this._isSelectionActive = true;
    }

    var success = this._selectChunk(this._selectedChunkIndex, true, isSyncScrollEnabled);
    if (!success) {
      return -1;
    }

    return this._selectedChunkIndex;
  }

  /**
   * Copies the currently selected diff chunk from the left editor to the right
   * editor.
   */
  copyToRight() {
    var foundSelection = false;
    var offset = 0; // keep track of line offset (used when there are multiple chunks being moved)

    for (var diffChunk of this._chunks) {
      if (diffChunk.isSelected) {
        foundSelection = true;

        var textToCopy = this._editorDiffExtender1.getEditor().getTextInBufferRange([
          [diffChunk.oldLineStart, 0],
          [diffChunk.oldLineEnd, 0],
        ]);
        var lastBufferRow = this._editorDiffExtender2.getEditor().getLastBufferRow();

        // insert new line if the chunk we want to copy will be below the last line of the other editor
        if (diffChunk.newLineStart + offset > lastBufferRow) {
          this._editorDiffExtender2
            .getEditor()
            .setCursorBufferPosition([lastBufferRow, 0], { autoscroll: false });
          this._editorDiffExtender2.getEditor().insertNewline();
        }

        this._editorDiffExtender2.getEditor().setTextInBufferRange(
          [
            [diffChunk.newLineStart + offset, 0],
            [diffChunk.newLineEnd + offset, 0],
          ],
          textToCopy,
        );
        // offset will be the amount of lines to be copied minus the amount of lines overwritten
        offset +=
          diffChunk.oldLineEnd -
          diffChunk.oldLineStart -
          (diffChunk.newLineEnd - diffChunk.newLineStart);
        // move the selection pointer back so the next diff chunk is not skipped
        if (this._editorDiffExtender1.hasSelection() || this._editorDiffExtender2.hasSelection()) {
          this._selectedChunkIndex--;
        }
      }
    }

    if (!foundSelection) {
      lumine.notifications.addWarning("Diff View", {
        detail: this._COPY_HELP_MESSAGE,
        dismissable: false,
        icon: "diff",
      });
    }
  }

  /**
   * Copies the currently selected diff chunk from the right editor to the left
   * editor.
   */
  copyToLeft() {
    var foundSelection = false;
    var offset = 0; // keep track of line offset (used when there are multiple chunks being moved)

    for (var diffChunk of this._chunks) {
      if (diffChunk.isSelected) {
        foundSelection = true;

        var textToCopy = this._editorDiffExtender2.getEditor().getTextInBufferRange([
          [diffChunk.newLineStart, 0],
          [diffChunk.newLineEnd, 0],
        ]);
        var lastBufferRow = this._editorDiffExtender1.getEditor().getLastBufferRow();
        // insert new line if the chunk we want to copy will be below the last line of the other editor
        if (diffChunk.oldLineStart + offset > lastBufferRow) {
          this._editorDiffExtender1
            .getEditor()
            .setCursorBufferPosition([lastBufferRow, 0], { autoscroll: false });
          this._editorDiffExtender1.getEditor().insertNewline();
        }

        this._editorDiffExtender1.getEditor().setTextInBufferRange(
          [
            [diffChunk.oldLineStart + offset, 0],
            [diffChunk.oldLineEnd + offset, 0],
          ],
          textToCopy,
        );
        // offset will be the amount of lines to be copied minus the amount of lines overwritten
        offset +=
          diffChunk.newLineEnd -
          diffChunk.newLineStart -
          (diffChunk.oldLineEnd - diffChunk.oldLineStart);
        // move the selection pointer back so the next diff chunk is not skipped
        if (this._editorDiffExtender1.hasSelection() || this._editorDiffExtender2.hasSelection()) {
          this._selectedChunkIndex--;
        }
      }
    }

    if (!foundSelection) {
      lumine.notifications.addWarning("Diff View", {
        detail: this._COPY_HELP_MESSAGE,
        dismissable: false,
        icon: "diff",
      });
    }
  }

  /**
   * Cleans up the editor indicated by index. A clean up will remove the editor
   * or the pane if necessary. Typically left editor == 1 and right editor == 2.
   *
   * @param editorIndex The index of the editor to clean up.
   */
  cleanUpEditor(editorIndex) {
    if (editorIndex === 1) {
      this._editorDiffExtender1.cleanUp();
    } else if (editorIndex === 2) {
      this._editorDiffExtender2.cleanUp();
    }
  }

  /**
   * Restores soft wrap to the appropriate editor.
   * @param editorIndex The index of the editor to restore soft wrap to.
   */
  restoreEditorSoftWrap(editorIndex) {
    if (editorIndex === 1) {
      this._editorDiffExtender1.getEditor().setSoftWrapped(true);
    } else if (editorIndex === 2) {
      this._editorDiffExtender2.getEditor().setSoftWrapped(true);
    }
  }

  /**
   * Destroys the editor diff extenders and cleans up subscriptions.
   */
  destroy() {
    this._destroyed = true;
    if (this._syncTimeout) {
      clearTimeout(this._syncTimeout);
      this._syncTimeout = null;
    }
    if (this._subscriptions) {
      this._subscriptions.dispose();
      this._subscriptions = null;
    }
    if (this._softWrapPatches) {
      for (var patch of this._softWrapPatches) {
        // Only unwind our own patch: a package that wrapped this function
        // after us owns the current value, and restoring would drop theirs.
        if (patch.component.updateModelSoftWrapColumn === patch.wrapper) {
          patch.component.updateModelSoftWrapColumn = patch.original;
        }
      }
      this._softWrapPatches = null;
    }
    this._editorDiffExtender1.destroy();
    this._editorDiffExtender2.destroy();
  }

  /**
   * Gets the number of differences between the editors.
   *
   * @return int The number of differences between the editors.
   */
  getNumDifferences() {
    return Array.isArray(this._chunks) ? this._chunks.length : 0;
  }

  /**
   * Gets the marker layers in use by the editors.
   * @return An object containing the marker layers and approriate information.
   */
  getMarkerLayers() {
    return this._markerLayers;
  }

  /**
   * Handles when the cursor moves in the editor. Will highlight chunks that have a cursor in them.
   * @param cursor The cursor object from the event.
   * @param oldBufferPosition The old position of the cursor in the buffer.
   * @param newBufferPosition The new position of the cursor in the buffer.
   */
  handleCursorChange(cursor, oldBufferPosition, newBufferPosition) {
    var editorIndex = cursor.editor === this._editorDiffExtender1.getEditor() ? 1 : 2;
    var oldPositionChunkIndex = this._getChunkIndexByLineNumber(editorIndex, oldBufferPosition.row);
    var newPositionChunkIndex = this._getChunkIndexByLineNumber(editorIndex, newBufferPosition.row);

    if (oldPositionChunkIndex >= 0) {
      var diffChunk = this._chunks[oldPositionChunkIndex];
      diffChunk.isSelected = false;
      this._editorDiffExtender1.deselectLines(diffChunk.oldLineStart, diffChunk.oldLineEnd);
      this._editorDiffExtender2.deselectLines(diffChunk.newLineStart, diffChunk.newLineEnd);
    }
    if (newPositionChunkIndex >= 0) {
      this._selectChunk(newPositionChunkIndex, false);
    }
  }

  // ----------------------------------------------------------------------- //
  // --------------------------- PRIVATE METHODS --------------------------- //
  // ----------------------------------------------------------------------- //

  /**
   * Selects and highlights the diff chunk in both editors according to the
   * given index.
   *
   * @param index The index of the diff chunk to highlight in both editors.
   * @param isNextOrPrev Whether we are moving to a direct sibling (if not, this is a click)
   * @param isSyncScrollEnabled Only autoscroll one editor if sync scroll is enabled or we will get in an infinite loop
   */
  _selectChunk(index, isNextOrPrev, isSyncScrollEnabled) {
    var diffChunk = this._chunks[index];
    if (diffChunk != null) {
      diffChunk.isSelected = true;

      if (isNextOrPrev) {
        // deselect previous next/prev highlights
        this._editorDiffExtender1.deselectAllLines();
        this._editorDiffExtender2.deselectAllLines();
        // scroll the editors to position diff at 1/3 of screen height
        this._editorDiffExtender1
          .getEditor()
          .setCursorBufferPosition([diffChunk.oldLineStart, 0], { autoscroll: false });
        this._scrollToPositionAtFraction(
          this._editorDiffExtender1.getEditor(),
          diffChunk.oldLineStart,
          1 / 3,
        );
        this._editorDiffExtender2
          .getEditor()
          .setCursorBufferPosition([diffChunk.newLineStart, 0], { autoscroll: false });
        if (!isSyncScrollEnabled) {
          this._scrollToPositionAtFraction(
            this._editorDiffExtender2.getEditor(),
            diffChunk.newLineStart,
            1 / 3,
          );
        }
      }

      // highlight selection in both editors
      this._editorDiffExtender1.selectLines(diffChunk.oldLineStart, diffChunk.oldLineEnd);
      this._editorDiffExtender2.selectLines(diffChunk.newLineStart, diffChunk.newLineEnd);

      return true;
    }

    return false;
  }

  /**
   * Scrolls the editor so that the given buffer row appears at a specific
   * fraction of the visible height (0 = top, 0.5 = center, 1 = bottom).
   * @param editor The text editor to scroll.
   * @param bufferRow The buffer row to scroll to.
   * @param fraction The fraction of visible height (0.25 = 1/4 from top).
   */
  _scrollToPositionAtFraction(editor, bufferRow, fraction) {
    const editorView = lumine.views.getView(editor);
    if (!editorView) {
      return;
    }
    const visibleHeight = editorView.getHeight();
    // Use pixelPositionForScreenPosition which accounts for block decorations (view zones)
    const screenPosition = editor.screenPositionForBufferPosition([bufferRow, 0]);
    const targetPixelPosition = editorView.pixelPositionForScreenPosition(screenPosition).top;
    const scrollTop = targetPixelPosition - visibleHeight * fraction;
    editorView.setScrollTop(Math.max(0, scrollTop));
  }

  /**
   * Gets the index of a chunk by the line number.
   * @param editorIndex The index of the editor to check.
   * @param lineNumber  The line number to use to check if it is in a chunk.
   * @return The index of the chunk.
   */
  _getChunkIndexByLineNumber(editorIndex, lineNumber) {
    for (var i = 0; i < this._chunks.length; i++) {
      var diffChunk = this._chunks[i];
      if (editorIndex === 1) {
        if (diffChunk.oldLineStart <= lineNumber && diffChunk.oldLineEnd > lineNumber) {
          return i;
        }
      } else if (editorIndex === 2) {
        if (diffChunk.newLineStart <= lineNumber && diffChunk.newLineEnd > lineNumber) {
          return i;
        }
      }
    }

    return -1;
  }

  /**
   * Highlights the word diff of the chunk passed in.
   *
   * @param chunk The chunk that should have its words highlighted.
   */
  _highlightWordsInChunk(chunk, leftHighlightType, rightHighlightType, isWhitespaceIgnored) {
    var leftLineNumber = chunk.oldLineStart;
    var rightLineNumber = chunk.newLineStart;
    // for each line that has a corresponding line
    while (leftLineNumber < chunk.oldLineEnd && rightLineNumber < chunk.newLineEnd) {
      var editor1LineText = this._editorDiffExtender1
        .getEditor()
        .lineTextForBufferRow(leftLineNumber);
      var editor2LineText = this._editorDiffExtender2
        .getEditor()
        .lineTextForBufferRow(rightLineNumber);

      if (editor1LineText == "") {
        // computeWordDiff returns empty for lines that are paired with empty lines
        // need to force a highlight
        this._editorDiffExtender2.setWordHighlights(
          rightLineNumber,
          [{ changed: true, value: editor2LineText }],
          rightHighlightType,
          isWhitespaceIgnored,
        );
      } else if (editor2LineText == "") {
        // computeWordDiff returns empty for lines that are paired with empty lines
        // need to force a highlight
        this._editorDiffExtender1.setWordHighlights(
          leftLineNumber,
          [{ changed: true, value: editor1LineText }],
          leftHighlightType,
          isWhitespaceIgnored,
        );
      } else {
        // perform regular word diff
        var wordDiff = ComputeWordDiff.computeWordDiff(editor1LineText, editor2LineText);
        this._editorDiffExtender1.setWordHighlights(
          leftLineNumber,
          wordDiff.removedWords,
          leftHighlightType,
          isWhitespaceIgnored,
        );
        this._editorDiffExtender2.setWordHighlights(
          rightLineNumber,
          wordDiff.addedWords,
          rightHighlightType,
          isWhitespaceIgnored,
        );
      }

      leftLineNumber++;
      rightLineNumber++;
    }

    // highlight remaining lines in left editor
    while (leftLineNumber < chunk.oldLineEnd) {
      editor1LineText = this._editorDiffExtender1.getEditor().lineTextForBufferRow(leftLineNumber);
      this._editorDiffExtender1.setWordHighlights(
        leftLineNumber,
        [{ changed: true, value: editor1LineText }],
        leftHighlightType,
        isWhitespaceIgnored,
      );
      leftLineNumber++;
    }
    // highlight remaining lines in the right editor
    while (rightLineNumber < chunk.newLineEnd) {
      this._editorDiffExtender2.setWordHighlights(
        rightLineNumber,
        [
          {
            changed: true,
            value: this._editorDiffExtender2.getEditor().lineTextForBufferRow(rightLineNumber),
          },
        ],
        rightHighlightType,
        isWhitespaceIgnored,
      );
      rightLineNumber++;
    }
  }
};
