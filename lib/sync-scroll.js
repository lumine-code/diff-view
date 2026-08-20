const { CompositeDisposable } = require("lumine");

/**
 * Synchronizes scrolling between two editors with soft-wrap and view zone support.
 * Uses direct scrollTop positioning since view zones ensure both editors have
 * equal total content heights.
 */
class SyncScroll {
  constructor(editor1, editor2, syncHorizontalScroll) {
    this._syncHorizontalScroll = syncHorizontalScroll;
    this._subscriptions = new CompositeDisposable();
    this._syncInfo = [
      {
        editor: editor1,
        editorView: lumine.views.getView(editor1),
        scrolling: false,
      },
      {
        editor: editor2,
        editorView: lumine.views.getView(editor2),
        scrolling: false,
      },
    ];

    this._syncInfo.forEach((editorInfo, i) => {
      // Note that 'onDidChangeScrollTop' isn't technically in the public API.
      this._subscriptions.add(
        editorInfo.editorView.onDidChangeScrollTop(() => this._scrollPositionChanged(i)),
      );
      // Note that 'onDidChangeScrollLeft' isn't technically in the public API.
      if (this._syncHorizontalScroll) {
        this._subscriptions.add(
          editorInfo.editorView.onDidChangeScrollLeft(() => this._horizontalScrollChanged(i)),
        );
      }
    });
  }

  /**
   * Handles vertical scroll synchronization using direct scrollTop positioning.
   * Since view zones ensure both editors have equal total content heights,
   * we simply copy the scrollTop value directly.
   *
   * The follower goes through the component rather than the element: the
   * element's setScrollTop defers rendering to the scheduler's next animation
   * frame, which trails the scrolled editor's own synchronous paint by one
   * frame for the whole glide. component.setScrollTop + updateSync is the
   * same path the wheel and animator use, so both editors paint in the same
   * frame.
   */
  _scrollPositionChanged(changeScrollIndex) {
    var thisInfo = this._syncInfo[changeScrollIndex];
    var otherInfo = this._syncInfo[1 - changeScrollIndex];

    if (thisInfo.scrolling) {
      return;
    }

    otherInfo.scrolling = true;
    try {
      var component = otherInfo.editorView.getComponent();
      if (component.setScrollTop(thisInfo.editorView.getScrollTop())) {
        component.updateSync();
      }
    } catch {
      // Ignore errors
    }
    otherInfo.scrolling = false;
  }

  /**
   * Handles horizontal scroll synchronization.
   * This remains pixel-based since horizontal scrolling is not affected by soft-wrap.
   */
  _horizontalScrollChanged(changeScrollIndex) {
    var thisInfo = this._syncInfo[changeScrollIndex];
    var otherInfo = this._syncInfo[1 - changeScrollIndex];

    if (thisInfo.scrolling) {
      return;
    }

    otherInfo.scrolling = true;
    try {
      var component = otherInfo.editorView.getComponent();
      if (component.setScrollLeft(thisInfo.editorView.getScrollLeft())) {
        component.updateSync();
      }
    } catch {
      // Ignore errors
    }
    otherInfo.scrolling = false;
  }

  dispose() {
    if (this._subscriptions) {
      this._subscriptions.dispose();
      this._subscriptions = null;
    }
  }

  syncPositions() {
    var activeTextEditor = lumine.workspace.getActiveTextEditor();
    var leaderIndex = this._syncInfo.findIndex((info) => info.editor === activeTextEditor);
    // When neither diff editor is active (diff launched from the tree view),
    // align from the left editor rather than not at all.
    if (leaderIndex === -1) {
      leaderIndex = 0;
    }
    this._scrollPositionChanged(leaderIndex);
  }
}

module.exports = SyncScroll;
