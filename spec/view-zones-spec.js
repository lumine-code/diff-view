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
