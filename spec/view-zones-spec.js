const EditorDiffExtender = require("../lib/editor-diff-extender");

describe("view zones", () => {
  let editor, extender;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    editor = await lumine.workspace.open();
    editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
    extender = new EditorDiffExtender(editor);
  });

  afterEach(() => {
    extender.destroy();
  });

  function zoneAt(lineNumber) {
    return extender.getViewZones().find((zone) => zone.lineNumber === lineNumber);
  }

  describe("syncViewZones", () => {
    it("places a leading zone before the first screen row of a wrapped line", () => {
      editor.setText(`${"group ".repeat(12)}\nbody\nend`);
      lumine.config.set("editor.softWrapAtPreferredLineLength", true);
      lumine.config.set("editor.preferredLineLength", 20);
      editor.setSoftWrapped(true);
      editor.component.updateSync();
      expect(editor.screenRowForBufferRow(1)).toBeGreaterThan(1);
      const view = lumine.views.getView(editor);
      const firstLineTop = view.pixelPositionForBufferPosition([0, 0]).top;

      extender.syncViewZones(new Map([[-1, 40]]));
      editor.component.updateSync();

      const zone = zoneAt(-1);
      expect(extender.getViewZones().length).toBe(1);
      expect(zone.marker.getStartBufferPosition().toArray()).toEqual([0, 0]);
      expect(zone.decoration.getProperties().position).toBe("before");
      expect(zone.element.isConnected).toBe(true);
      expect(view.pixelPositionForBufferPosition([0, 0]).top).toBe(firstLineTop + 40);
    });

    it("keeps and resizes the leading zone in place", () => {
      extender.syncViewZones(new Map([[-1, 20]]));
      editor.component.updateSync();
      const original = zoneAt(-1);
      const originalElement = original.element;
      const firstLineTop = lumine.views.getView(editor).pixelPositionForBufferPosition([0, 0]).top;

      extender.syncViewZones(new Map([[-1, 20]]));
      expect(zoneAt(-1)).toBe(original);
      expect(zoneAt(-1).element).toBe(originalElement);

      extender.syncViewZones(new Map([[-1, 55]]));
      editor.component.updateSync();

      expect(zoneAt(-1)).toBe(original);
      expect(zoneAt(-1).element).toBe(originalElement);
      expect(original.element.style.minHeight).toBe("55px");
      expect(original.pixelHeight).toBe(55);
      expect(original.marker.getStartBufferPosition().toArray()).toEqual([0, 0]);
      expect(lumine.views.getView(editor).pixelPositionForBufferPosition([0, 0]).top).toBe(
        firstLineTop + 35,
      );
    });

    it("removes the leading zone while keeping a zone after the first line", () => {
      extender.syncViewZones(
        new Map([
          [-1, 20],
          [0, 40],
        ]),
      );
      editor.component.updateSync();
      const removed = zoneAt(-1);
      const kept = zoneAt(0);

      extender.syncViewZones(new Map([[0, 40]]));
      editor.component.updateSync();

      expect(extender.getViewZones().length).toBe(1);
      expect(zoneAt(-1)).toBeUndefined();
      expect(zoneAt(0)).toBe(kept);
      expect(removed.marker.isDestroyed()).toBe(true);
      expect(removed.element.isConnected).toBe(false);
      expect(lumine.views.getView(editor).pixelPositionForBufferPosition([0, 0]).top).toBe(0);
    });

    it("ignores positions before the leading zone", () => {
      expect(() => extender.syncViewZones(new Map([[-2, 20]]))).not.toThrow();
      expect(extender.getViewZones().length).toBe(0);
    });

    it("places a zone for each requested line", () => {
      extender.syncViewZones(
        new Map([
          [3, 20],
          [8, 40],
        ]),
      );

      expect(extender.getViewZones().length).toBe(2);
      expect(zoneAt(3).element.style.minHeight).toBe("20px");
      expect(zoneAt(8).element.style.minHeight).toBe("40px");
    });

    it("keeps the very same zone when nothing about it changed", () => {
      extender.syncViewZones(new Map([[3, 20]]));
      const original = zoneAt(3);
      const originalElement = original.element;

      extender.syncViewZones(new Map([[3, 20]]));

      // Identity, not just equality: recreating the zone would drop the
      // editor's content height for a frame, which is what pulled the two
      // editors out of alignment on every re-diff.
      expect(zoneAt(3)).toBe(original);
      expect(zoneAt(3).element).toBe(originalElement);
      expect(originalElement.isConnected).toBe(true);
    });

    it("resizes a zone in place rather than replacing it", () => {
      extender.syncViewZones(new Map([[3, 20]]));
      const original = zoneAt(3);

      extender.syncViewZones(new Map([[3, 55]]));

      expect(zoneAt(3)).toBe(original);
      expect(zoneAt(3).element.style.minHeight).toBe("55px");
      expect(extender.getViewZones().length).toBe(1);
    });

    it("removes the zones that are no longer wanted and keeps the rest", () => {
      extender.syncViewZones(
        new Map([
          [3, 20],
          [8, 40],
        ]),
      );
      const kept = zoneAt(8);

      extender.syncViewZones(new Map([[8, 40]]));

      expect(extender.getViewZones().length).toBe(1);
      expect(zoneAt(3)).toBeUndefined();
      expect(zoneAt(8)).toBe(kept);
    });

    it("ignores a line the buffer does not have", () => {
      // Chunks describe the buffer as it was when the diff ran, so an edit can
      // leave a line number past the end before the next diff lands.
      expect(() => extender.syncViewZones(new Map([[500, 20]]))).not.toThrow();
      expect(extender.getViewZones().length).toBe(0);
    });

    it("ignores a zero or negative height", () => {
      extender.syncViewZones(
        new Map([
          [3, 0],
          [4, -10],
        ]),
      );
      expect(extender.getViewZones().length).toBe(0);
    });
  });

  describe("destroyMarkers", () => {
    it("leaves the view zones standing", () => {
      extender.syncViewZones(new Map([[3, 20]]));
      const zone = zoneAt(3);

      // A re-diff clears the highlights and then reconciles the zones; taking
      // the zones down here is what made the editors jump between the two.
      extender.destroyMarkers();

      expect(extender.getViewZones().length).toBe(1);
      expect(zoneAt(3)).toBe(zone);
      expect(zone.element.isConnected).toBe(true);
    });
  });

  describe("getBufferRangeScreenRowCount", () => {
    it("counts one row per line when nothing wraps", () => {
      expect(extender.getBufferRangeScreenRowCount(0, 5)).toBe(5);
    });

    it("counts the last line when the range runs past the end of the buffer", () => {
      const lineCount = editor.getLineCount();
      expect(extender.getBufferRangeScreenRowCount(0, lineCount)).toBe(lineCount);
    });

    it("is zero for an empty range", () => {
      expect(extender.getBufferRangeScreenRowCount(4, 4)).toBe(0);
      expect(extender.getBufferRangeScreenRowCount(6, 2)).toBe(0);
    });
  });
});
