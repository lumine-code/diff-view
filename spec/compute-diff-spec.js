const path = require("path");
const { BufferedNodeProcess } = require("lumine");
const computeDiffModule = require("../lib/compute-diff");

// The spec runner freezes setTimeout, so the child process is awaited by
// polling on animation frames instead of timers.
function pollUntil(condition, timeoutMs = 15000) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) {
        resolve();
      } else if (performance.now() - start > timeoutMs) {
        reject(new Error("Timed out waiting for the diff process"));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  });
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

    it("accepts the whitespace flag as a string, as a spawned process receives it", () => {
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

  describe("the child-process protocol", () => {
    // The window hands the text over on stdin and parses one JSON line back.
    // Spawned exactly as the package does, so the transport itself is what is
    // under test — including the cmd.exe wrapper BufferedProcess uses on
    // Windows, which the payload has to pass through.
    async function runComputeDiff(payload) {
      const chunks = [];
      let exitCode = null;
      let stderrOutput = "";

      const child = new BufferedNodeProcess({
        command: path.resolve(__dirname, "../lib/compute-diff.js"),
        stdout: (output) => chunks.push(output),
        stderr: (output) => (stderrOutput += output),
        exit: (code) => (exitCode = code),
      });
      child.process.stdin.end(JSON.stringify(payload));

      await pollUntil(() => exitCode !== null);
      expect(stderrOutput).toBe("");
      expect(exitCode).toBe(0);
      return chunks;
    }

    it("reads the payload from stdin and delivers the diff in one callback", async () => {
      const chunks = await runComputeDiff({
        oldText: "a\nb\nc\n",
        newText: "a\nx\nc\n",
        ignoreWhitespace: false,
      });

      // The window parses the output in one go, so it has to arrive whole.
      expect(chunks.length).toBe(1);
      const parsed = JSON.parse(chunks[0]);
      expect(parsed.chunks).toEqual(
        computeDiffModule.computeDiff("a\nb\nc\n", "a\nx\nc\n", false).chunks,
      );
    });

    it("carries a payload larger than a pipe buffer", async () => {
      const oldText = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n") + "\n";
      const newText = oldText.replace("line 19999", "line 19999 changed");

      const chunks = await runComputeDiff({ oldText, newText, ignoreWhitespace: false });

      expect(chunks.length).toBe(1);
      const parsed = JSON.parse(chunks[0]);
      expect(parsed.chunks.length).toBe(1);
      expect(parsed.chunks[0].oldLineStart).toBe(19999);
    });
  });
});
