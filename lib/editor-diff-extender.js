module.exports = class EditorDiffExtender {
  _destroyed = false;

  constructor(editor) {
    this._editor = editor;
    this._lineMarkerLayer = this._editor.addMarkerLayer();
    // Highlight markers only. The view zones are held by _viewZones and
    // outlive a re-diff, so they must not be swept up with the highlights.
    this._miscMarkers = [];
    this._selectionMarkerLayer = this._editor.addMarkerLayer();
    this._viewZones = [];
    this._oldPlaceholderText = editor.getPlaceholderText();
    editor.setPlaceholderText("Paste what you want to diff here!");
    // add diff-view css selector to editors for keybindings #73
    lumine.views.getView(this._editor).classList.add("diff-view");
  }

  /**
   * Creates marker for line highlight.
   *
   * @param startIndex The start index of the line chunk to highlight.
   * @param endIndex The end index of the line chunk to highlight.
   * @param highlightType The type of highlight to be applied to the line.
   */
  highlightLines(startIndex, endIndex, highlightType) {
    if (startIndex != endIndex) {
      var highlightClass = "diff-view-line diff-view-" + highlightType;
      this._createLineMarker(this._lineMarkerLayer, startIndex, endIndex, highlightClass);
    }
  }

  /**
   * The line marker layer holds all added/removed line markers.
   *
   * @return The line marker layer.
   */
  getLineMarkerLayer() {
    return this._lineMarkerLayer;
  }

  /**
   * The selection marker layer holds all line highlight selection markers.
   *
   * @return The selection marker layer.
   */
  getSelectionMarkerLayer() {
    return this._selectionMarkerLayer;
  }

  /**
   * Highlights words in a given line.
   *
   * @param lineNumber The line number to highlight words on.
   * @param wordDiff An array of objects which look like...
   *    added: boolean (not used)
   *    count: number (not used)
   *    removed: boolean (not used)
   *    value: string
   *    changed: boolean
   * @param type The type of highlight to be applied to the words.
   */
  setWordHighlights(lineNumber, wordDiff = [], type, isWhitespaceIgnored) {
    var klass = "diff-view-word-" + type;
    var count = 0;

    for (var i = 0; i < wordDiff.length; i++) {
      if (wordDiff[i].value) {
        // fix for #49
        // if there was a change
        // AND one of these is true:
        // if the string is not spaces, highlight
        // OR
        // if the string is spaces and whitespace not ignored, highlight
        if (
          wordDiff[i].changed &&
          (/\S/.test(wordDiff[i].value) || (!/\S/.test(wordDiff[i].value) && !isWhitespaceIgnored))
        ) {
          var marker = this._editor.markBufferRange(
            [
              [lineNumber, count],
              [lineNumber, count + wordDiff[i].value.length],
            ],
            { invalidate: "never" },
          );
          this._editor.decorateMarker(marker, { type: "highlight", class: klass });
          this._miscMarkers.push(marker);
        }
        count += wordDiff[i].value.length;
      }
    }
  }

  /**
   * Destroys the highlight markers added to this editor by diff-view.
   *
   * The view zones are deliberately left alone: a re-diff clears the
   * highlights and then reconciles the zones, and destroying them here would
   * drop the editor's content height until the new ones land.
   */
  destroyMarkers() {
    // Note: Don't check _destroyed here - this is called from destroy() after flag is set

    // Clear references immediately to prevent race conditions
    var miscMarkers = this._miscMarkers;
    this._miscMarkers = [];

    // Defer destruction to avoid race conditions with the editor's render cycle
    requestAnimationFrame(() => {
      miscMarkers.forEach(function (marker) {
        try {
          marker.destroy();
        } catch {
          /* marker may be invalid if editor is destroyed */
        }
      });
    });

    // Safely clear marker layers (may fail if editor is destroyed)
    try {
      this._lineMarkerLayer.clear();
    } catch {
      /* editor may be destroyed */
    }
    try {
      this._selectionMarkerLayer.clear();
    } catch {
      /* editor may be destroyed */
    }
  }

  /**
   * Destroys the instance of the EditorDiffExtender and cleans up after itself.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    this.destroyMarkers();
    this.destroyViewZones();

    // Safely destroy marker layer (may fail if editor is already destroyed)
    try {
      this._lineMarkerLayer.destroy();
    } catch {
      /* editor may be destroyed */
    }

    // Only restore placeholder and remove CSS if editor still exists
    try {
      if (this._editor && !this._editor.isDestroyed()) {
        this._editor.setPlaceholderText(this._oldPlaceholderText);
        var editorView = lumine.views.getView(this._editor);
        if (editorView) {
          editorView.classList.remove("diff-view");
        }
      }
    } catch {
      /* editor may be destroyed */
    }
  }

  /**
   * Selects lines.
   *
   * @param startLine The line number that the selection starts at.
   * @param endLine The line number that the selection ends at (non-inclusive).
   */
  selectLines(startLine, endLine) {
    // don't want to highlight if they are the same (same numbers means chunk is
    // just pointing to a location to copy-to-right/copy-to-left)
    if (startLine < endLine) {
      var selectionMarker = this._selectionMarkerLayer.findMarkers({
        startBufferRow: startLine,
        endBufferRow: endLine,
      })[0];
      if (!selectionMarker) {
        this._createLineMarker(
          this._selectionMarkerLayer,
          startLine,
          endLine,
          "diff-view-selected",
        );
      }
    }
  }

  deselectLines(startLine, endLine) {
    var selectionMarker = this._selectionMarkerLayer.findMarkers({
      startBufferRow: startLine,
      endBufferRow: endLine,
    })[0];
    if (selectionMarker) {
      selectionMarker.destroy();
    }
  }

  /**
   * Destroy the selection markers.
   */
  deselectAllLines() {
    this._selectionMarkerLayer.clear();
  }

  /**
   * Used to test whether there is currently an active selection highlight in
   * the editor.
   *
   * @return A boolean signifying whether there is an active selection highlight.
   */
  hasSelection() {
    if (this._selectionMarkerLayer.getMarkerCount() > 0) {
      return true;
    }
    return false;
  }

  /**
   * Enable soft wrap for this editor.
   */
  enableSoftWrap() {
    try {
      this._editor.setSoftWrapped(true);
    } catch {
      //console.log('Soft wrap was enabled on a text editor that does not exist.');
    }
  }

  /**
   * Removes the text editor without prompting a save.
   */
  cleanUp() {
    // if the pane that this editor was in is now empty, we will destroy it
    var editorPane = lumine.workspace.paneForItem(this._editor);
    if (
      typeof editorPane !== "undefined" &&
      editorPane != null &&
      editorPane.getItems().length == 1
    ) {
      editorPane.destroy();
    } else {
      this._editor.destroy();
    }
  }

  /**
   * Used to get the Text Editor object for this view. Helpful for calling basic
   * Text editor functions.
   *
   * @return The Text Editor object for this view.
   */
  getEditor() {
    return this._editor;
  }

  // ----------------------------------------------------------------------- //
  // --------------------------- PRIVATE METHODS --------------------------- //
  // ----------------------------------------------------------------------- //

  /**
   * Creates a marker and decorates its line and line number.
   *
   * @param markerLayer The marker layer to put the marker in.
   * @param startLineNumber A buffer line number to start highlighting at.
   * @param endLineNumber A buffer line number to end highlighting at.
   * @param highlightClass The type of highlight to be applied to the line.
   *    Could be a value of: ['diff-view-insert', 'diff-view-delete',
   *    'diff-view-select'].
   * @return The created line marker.
   */
  _createLineMarker(markerLayer, startLineNumber, endLineNumber, highlightClass) {
    var marker = markerLayer.markBufferRange(
      [
        [startLineNumber, 0],
        [endLineNumber, 0],
      ],
      { invalidate: "never" },
    );

    this._editor.decorateMarker(marker, { type: "line-number", class: highlightClass });
    this._editor.decorateMarker(marker, { type: "line", class: highlightClass });

    return marker;
  }

  /**
   * Gets the pixel height of a single buffer line, accounting for soft-wrap.
   * When soft-wrap is enabled, a single buffer line may span multiple screen rows.
   *
   * @param bufferRow The buffer row to get the height for.
   * @return The height in pixels.
   */
  getWrappedLineHeight(bufferRow) {
    var firstScreenRow = this._editor.screenRowForBufferRow(bufferRow);
    var nextBufferRow = Math.min(bufferRow + 1, this._editor.getLastBufferRow());
    var nextScreenRow = this._editor.screenRowForBufferRow(nextBufferRow);

    // Handle last line edge case
    var screenRowCount;
    if (bufferRow === this._editor.getLastBufferRow()) {
      screenRowCount = this._editor.getLastScreenRow() - firstScreenRow + 1;
    } else {
      screenRowCount = nextScreenRow - firstScreenRow;
    }

    return screenRowCount * this._editor.getLineHeightInPixels();
  }

  /**
   * Gets the total pixel height of a range of buffer lines, accounting for soft-wrap.
   *
   * @param startRow The starting buffer row (inclusive).
   * @param endRow The ending buffer row (exclusive).
   * @return The total height in pixels.
   */
  getBufferRangeHeight(startRow, endRow) {
    if (startRow >= endRow) {
      return 0;
    }

    var startScreenRow = this._editor.screenRowForBufferRow(startRow);
    var endScreenRow = this._editor.screenRowForBufferRow(endRow);
    var screenRowCount = endScreenRow - startScreenRow;

    return screenRowCount * this._editor.getLineHeightInPixels();
  }

  /**
   * Counts the screen rows spanned by a range of buffer lines. Equals the
   * number of buffer lines exactly when nothing in the range wraps.
   *
   * Unlike getBufferRangeHeight this clamps at the end of the buffer:
   * screenRowForBufferRow of a row past the last one clips to the last screen
   * row rather than one past it, which would undercount the final line.
   *
   * @param startRow The starting buffer row (inclusive).
   * @param endRow The ending buffer row (exclusive).
   * @return The number of screen rows.
   */
  getBufferRangeScreenRowCount(startRow, endRow) {
    if (startRow >= endRow) {
      return 0;
    }

    var startScreenRow = this._editor.screenRowForBufferRow(startRow);
    var lastBufferRow = this._editor.getLastBufferRow();
    var endScreenRow =
      endRow > lastBufferRow
        ? this._editor.getLastScreenRow() + 1
        : this._editor.screenRowForBufferRow(endRow);

    return endScreenRow - startScreenRow;
  }

  /**
   * Brings the view zones in line with a desired set, keyed by the buffer line
   * each one sits after.
   *
   * Reconciled rather than rebuilt, and this is the whole point of the method:
   * destroying every zone and creating it again drops the editor's content
   * height for as long as it takes the new ones to land, and both editors
   * re-anchor their scroll position independently while it is short. They
   * re-anchor onto different rows, so a rebuild on each re-diff walked the two
   * sides apart. A zone that is already the right height is now left untouched.
   *
   * @param desired A Map of buffer line number to height in pixels.
   */
  syncViewZones(desired) {
    var kept = [];

    for (var zone of this._viewZones) {
      var wantedHeight = desired.get(zone.lineNumber);
      if (wantedHeight === undefined) {
        this._destroyViewZone(zone);
        continue;
      }
      if (wantedHeight !== zone.pixelHeight) {
        zone.element.style.minHeight = wantedHeight + "px";
        zone.pixelHeight = wantedHeight;
      }
      // Claimed, so the creation pass below does not add a second one here.
      desired.delete(zone.lineNumber);
      kept.push(zone);
    }
    this._viewZones = kept;

    for (var [lineNumber, height] of desired) {
      this._createViewZone(lineNumber, height);
    }
  }

  /**
   * Destroys every view zone in this editor.
   */
  destroyViewZones() {
    for (var zone of this._viewZones) {
      this._destroyViewZone(zone);
    }
    this._viewZones = [];
  }

  /**
   * The view zones currently placed, for specs and cross-editor checks.
   * @return Array of view zone info objects.
   */
  getViewZones() {
    return this._viewZones;
  }

  _createViewZone(lineNumber, heightInPixels) {
    if (!(heightInPixels > 0)) {
      return;
    }

    // A line the buffer no longer has cannot carry a spacer: callers work from
    // diff chunks, which an edit can outdate before the next diff arrives.
    var lineText = this._editor.lineTextForBufferRow(lineNumber);
    if (lineText == null) {
      return;
    }

    var element = document.createElement("div");
    element.className = "diff-view-offset";
    element.style.minHeight = heightInPixels + "px";

    // Mark at the END of the line content so the view zone appears after the
    // last screen row of a wrapped line, not after the first.
    var marker = this._editor.markBufferPosition([lineNumber, lineText.length], {
      invalidate: "never",
    });
    var decoration = this._editor.decorateMarker(marker, {
      type: "block",
      position: "after",
      item: element,
    });

    this._viewZones.push({
      element: element,
      lineNumber: lineNumber,
      pixelHeight: heightInPixels,
      marker: marker,
      decoration: decoration,
    });
  }

  _destroyViewZone(zone) {
    try {
      if (zone.decoration) {
        zone.decoration.destroy();
      }
      if (zone.marker) {
        zone.marker.destroy();
      }
    } catch {
      /* editor may be destroyed */
    }
  }
};
