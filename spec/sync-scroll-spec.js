const { Emitter } = require("lumine");
const SyncScroll = require("../lib/sync-scroll");

// A stand-in for a text editor element and its component. The component records
// what it was told and whether it was asked to render, which is what the
// same-frame guarantee is made of: setScrollTop reports whether the value
// moved, and only a move may schedule a render.
function buildFakeEditor(name) {
  const emitter = new Emitter();
  const component = {
    scrollTop: 0,
    scrollLeft: 0,
    updateSyncCount: 0,
    setScrollTop(value) {
      if (value === this.scrollTop) return false;
      this.scrollTop = value;
      emitter.emit("did-change-scroll-top", value);
      return true;
    },
    setScrollLeft(value) {
      if (value === this.scrollLeft) return false;
      this.scrollLeft = value;
      emitter.emit("did-change-scroll-left", value);
      return true;
    },
    updateSync() {
      this.updateSyncCount++;
    },
  };
  const editorView = {
    name,
    getComponent: () => component,
    getScrollTop: () => component.scrollTop,
    getScrollLeft: () => component.scrollLeft,
    setScrollTop(value) {
      // The element path a real editor exposes: state now, render later.
      component.setScrollTop(value);
    },
    onDidChangeScrollTop: (callback) => emitter.on("did-change-scroll-top", callback),
    onDidChangeScrollLeft: (callback) => emitter.on("did-change-scroll-left", callback),
  };
  return { editor: { name }, editorView, component };
}

describe("SyncScroll", () => {
  let left, right, syncScroll;

  beforeEach(() => {
    left = buildFakeEditor("left");
    right = buildFakeEditor("right");
    const viewsByEditor = new Map([
      [left.editor, left.editorView],
      [right.editor, right.editorView],
    ]);
    spyOn(lumine.views, "getView").and.callFake((object) => viewsByEditor.get(object));
  });

  afterEach(() => {
    if (syncScroll != null) {
      syncScroll.dispose();
      syncScroll = null;
    }
  });

  describe("vertical scrolling", () => {
    beforeEach(() => {
      syncScroll = new SyncScroll(left.editor, right.editor, false);
    });

    it("moves and renders the other editor in the same tick", () => {
      left.component.setScrollTop(120);

      // Synchronously, with no frame or timer awaited in between.
      expect(right.component.scrollTop).toBe(120);
      expect(right.component.updateSyncCount).toBe(1);
    });

    it("syncs in both directions", () => {
      right.component.setScrollTop(80);
      expect(left.component.scrollTop).toBe(80);

      left.component.setScrollTop(200);
      expect(right.component.scrollTop).toBe(200);
    });

    it("does not render the other editor when the position did not move", () => {
      left.component.setScrollTop(50);
      expect(right.component.updateSyncCount).toBe(1);

      // The follower is already there, so the echo must not schedule a render.
      right.component.updateSyncCount = 0;
      left.component.setScrollTop(50);
      expect(right.component.updateSyncCount).toBe(0);
    });

    it("does not bounce the scroll back and forth", () => {
      left.component.setScrollTop(300);

      expect(left.component.scrollTop).toBe(300);
      expect(right.component.scrollTop).toBe(300);
      // One hop only: the guard stops the follower's own event re-entering.
      expect(left.component.updateSyncCount).toBe(0);
      expect(right.component.updateSyncCount).toBe(1);
    });

    it("leaves horizontal scrolling alone when it was not requested", () => {
      left.component.setScrollLeft(40);
      expect(right.component.scrollLeft).toBe(0);
    });

    it("stops syncing once disposed", () => {
      syncScroll.dispose();
      syncScroll = null;

      left.component.setScrollTop(90);
      expect(right.component.scrollTop).toBe(0);
    });
  });

  describe("horizontal scrolling", () => {
    beforeEach(() => {
      syncScroll = new SyncScroll(left.editor, right.editor, true);
    });

    it("moves and renders the other editor in the same tick", () => {
      left.component.setScrollLeft(75);

      expect(right.component.scrollLeft).toBe(75);
      expect(right.component.updateSyncCount).toBe(1);
    });

    it("does not render the other editor when the position did not move", () => {
      left.component.setScrollLeft(75);
      right.component.updateSyncCount = 0;
      left.component.setScrollLeft(75);
      expect(right.component.updateSyncCount).toBe(0);
    });
  });

  describe("syncPositions", () => {
    beforeEach(() => {
      syncScroll = new SyncScroll(left.editor, right.editor, false);
    });

    it("aligns from the active editor", () => {
      right.component.scrollTop = 140;
      spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(right.editor);

      syncScroll.syncPositions();

      expect(left.component.scrollTop).toBe(140);
    });

    it("aligns from the left editor when neither one is active", () => {
      left.component.scrollTop = 60;
      spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(null);

      syncScroll.syncPositions();

      expect(right.component.scrollTop).toBe(60);
    });
  });
});
