const { computeWordDiff } = require("../lib/compute-word-diff");

function changedRanges(parts) {
  const ranges = [];
  let column = 0;
  for (const part of parts) {
    if (part.changed) {
      ranges.push([column, column + part.value.length]);
    }
    column += part.value.length;
  }
  return ranges;
}

function interleavedWords(count) {
  const oldWords = [];
  const newWords = [];
  for (let i = 0; i < count; i++) {
    oldWords.push(`old${i}`, `same${i}`);
    newWords.push(`new${i}`, `same${i}`);
  }
  return [oldWords.join(" "), newWords.join(" ")];
}

describe("compute-word-diff", () => {
  it("preserves each side's text and UTF-16 columns when whitespace lengths differ", () => {
    const oldText = "😀\tfoo = 1;";
    const newText = "😀  foo = 2;";
    const result = computeWordDiff(oldText, newText);

    expect(result.removedWords.map((part) => part.value).join("")).toBe(oldText);
    expect(result.addedWords.map((part) => part.value).join("")).toBe(newText);
    expect(changedRanges(result.removedWords)).toEqual([
      [2, 3],
      [9, 10],
    ]);
    expect(changedRanges(result.addedWords)).toEqual([
      [2, 4],
      [10, 11],
    ]);
  });

  it("keeps an unchanged prefix out of an appended suffix's highlight", () => {
    const prefix = "\\par\\addvspace{\\medskipamount} PN-EN~15528~\\cite{pn-en_15528:2015}";
    const suffix = " + Id-16-A1 v2.0~\\cite{rym_kol_id16_a1-2.0}";
    const result = computeWordDiff(prefix, prefix + suffix);

    expect(changedRanges(result.removedWords)).toEqual([]);
    expect(changedRanges(result.addedWords)).toEqual([
      [prefix.length, prefix.length + suffix.length],
    ]);
  });

  it("does not split an astral character's UTF-16 surrogate pair", () => {
    const result = computeWordDiff("😀", "😃");
    expect(changedRanges(result.removedWords)).toEqual([[0, 2]]);
    expect(changedRanges(result.addedWords)).toEqual([[0, 2]]);
  });

  it("highlights the populated side of an empty-line replacement", () => {
    const addition = computeWordDiff("", "text");
    expect(addition.removedWords).toEqual([]);
    expect(changedRanges(addition.addedWords)).toEqual([[0, 4]]);

    const deletion = computeWordDiff("text", "");
    expect(deletion.addedWords).toEqual([]);
    expect(changedRanges(deletion.removedWords)).toEqual([[0, 4]]);
    expect(computeWordDiff("", "")).toEqual({ addedWords: [], removedWords: [] });
  });

  describe("the compute budget", () => {
    // jsdiff measures its budget with Date.now, which the spec harness freezes.
    beforeEach(() => jasmine.useRealClock());

    it("returns null when a long changed line spends its budget", () => {
      const [oldText, newText] = interleavedWords(1000);
      expect(computeWordDiff(oldText, newText, 1)).toBe(null);
    });

    it("takes zero as no limit", () => {
      const [oldText, newText] = interleavedWords(100);
      const result = computeWordDiff(oldText, newText, 0);
      expect(result).not.toBe(null);
      expect(result.addedWords.filter((part) => part.changed).length).toBe(100);
      expect(result.removedWords.filter((part) => part.changed).length).toBe(100);
    });

    it("leaves the budget off when none is given", () => {
      const [oldText, newText] = interleavedWords(100);
      expect(computeWordDiff(oldText, newText)).toEqual(computeWordDiff(oldText, newText, 0));
    });
  });
});
