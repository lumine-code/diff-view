const computeDiffModule = require("../lib/compute-diff");

// A pair whose every other line differs, which is the shape the diff costs the
// most on: the algorithm is O(ND) in the number of differences, so this is what
// the compute budget exists to bound.
function interleavedPair(differences) {
  const oldLines = [];
  const newLines = [];
  for (let i = 0; i < differences; i++) {
    oldLines.push(`old ${i}`, `same ${i}`);
    newLines.push(`new ${i}`, `same ${i}`);
  }
  return [oldLines.join("\n") + "\n", newLines.join("\n") + "\n"];
}

describe("compute-diff", () => {
  describe("computeDiff", () => {
    it("reports no chunks for identical text", () => {
      const result = computeDiffModule.computeDiff("a\nb\nc\n", "a\nb\nc\n", false);
      expect(result.chunks).toEqual([]);
    });

    it("pairs a changed line as one chunk on both sides", () => {
      const result = computeDiffModule.computeDiff("a\nb\nc\n", "a\nx\nc\n", false);
      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0]).toEqual({
        newLineStart: 1,
        newLineEnd: 2,
        oldLineStart: 1,
        oldLineEnd: 2,
      });
    });

    it("gives an addition an empty range on the side it is missing from", () => {
      const result = computeDiffModule.computeDiff("a\nb\n", "a\nb\nc\n", false);
      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0].newLineStart).toBe(2);
      expect(result.chunks[0].newLineEnd).toBe(3);
      expect(result.chunks[0].oldLineStart).toBe(result.chunks[0].oldLineEnd);
    });

    it("gives a deletion an empty range on the side it is missing from", () => {
      const result = computeDiffModule.computeDiff("a\nb\nc\n", "a\nb\n", false);
      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0].oldLineStart).toBe(2);
      expect(result.chunks[0].oldLineEnd).toBe(3);
      expect(result.chunks[0].newLineStart).toBe(result.chunks[0].newLineEnd);
    });

    it("offsets the shorter side so the two line up", () => {
      const result = computeDiffModule.computeDiff("a\nc\n", "a\nb\nc\n", false);
      expect(result.oldLineOffsets).toEqual({ 1: 1 });
      expect(result.newLineOffsets).toEqual({});
    });

    it("ignores whitespace when asked to", () => {
      const withWhitespace = computeDiffModule.computeDiff("a\n    b\n", "a\nb\n", true);
      expect(withWhitespace.chunks).toEqual([]);

      const withoutIgnoring = computeDiffModule.computeDiff("a\n    b\n", "a\nb\n", false);
      expect(withoutIgnoring.chunks.length).toBe(1);
    });

    it("accepts the whitespace flag as a string, as a service consumer may pass it", () => {
      const result = computeDiffModule.computeDiff("a\n    b\n", "a\nb\n", "true");
      expect(result.chunks).toEqual([]);
    });

    it("does not report a difference for a trailing newline alone", () => {
      const result = computeDiffModule.computeDiff("a\nb", "a\nb\n\n", false);
      expect(result.chunks).toEqual([]);
    });

    it("handles an empty side", () => {
      const added = computeDiffModule.computeDiff("", "a\nb\n", false);
      expect(added.chunks.length).toBeGreaterThan(0);

      const removed = computeDiffModule.computeDiff("a\nb\n", "", false);
      expect(removed.chunks.length).toBeGreaterThan(0);
    });
  });

  describe("the compute budget", () => {
    // The diff runs in the window, so the budget is what stands between a
    // pathological pair and a frozen window. Both cases use the same fixture so
    // the only variable is the budget itself.

    // jsdiff spends the budget against Date.now, which the harness freezes.
    beforeEach(() => jasmine.useRealClock());

    it("returns null rather than running past the budget", () => {
      const [oldText, newText] = interleavedPair(500);
      expect(computeDiffModule.computeDiff(oldText, newText, false, 1)).toBe(null);
    });

    it("takes zero as no limit and finishes the same pair", () => {
      const [oldText, newText] = interleavedPair(500);
      const result = computeDiffModule.computeDiff(oldText, newText, false, 0);
      expect(result).not.toBe(null);
      expect(result.chunks.length).toBe(500);
    });

    it("leaves the budget off when none is given", () => {
      const [oldText, newText] = interleavedPair(500);
      const result = computeDiffModule.computeDiff(oldText, newText, false);
      expect(result).not.toBe(null);
      expect(result.chunks.length).toBe(500);
    });

    it("diffs a large pair well inside the default budget", () => {
      const oldText = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n") + "\n";
      const newText = oldText.replace("line 19999", "line 19999 changed");

      const start = performance.now();
      const result = computeDiffModule.computeDiff(oldText, newText, false, 250);
      const elapsed = performance.now() - start;

      expect(result).not.toBe(null);
      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0].oldLineStart).toBe(19999);
      expect(elapsed).toBeLessThan(250);
    });
  });
});
