const { computeNormalizedDiff } = require("./compute-diff");

const NATIVE_UNITS = 256 * 1024;
const NATIVE_ROWS = 8192;

function small(source) {
  return source.length <= NATIVE_UNITS && source.lineCount <= NATIVE_ROWS;
}

async function computeSourceDiff(left, right, ignoreWhitespace, timeoutMs, isCurrent = () => true) {
  const stopAt = timeoutMs > 0 ? performance.now() + timeoutMs : Infinity;
  let nextYield = performance.now() + 4;
  const check = () => {
    if (!isCurrent())
      throw Object.assign(new Error("Comparison was superseded"), { name: "AbortError" });
    if (performance.now() > stopAt)
      throw Object.assign(new Error("Comparison exceeded its time budget"), {
        code: "ERR_DIFF_TIMEOUT",
      });
    if (performance.now() >= nextYield) {
      return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
        nextYield = performance.now() + 4;
        if (!isCurrent())
          throw Object.assign(new Error("Comparison was superseded"), { name: "AbortError" });
      });
    }
  };
  try {
    const a = await normalize(left, ignoreWhitespace, check);
    const b = await normalize(right, ignoreWhitespace, check);
    const limit = Math.min(a.length, b.length);
    let prefix = 0;
    while (prefix < limit) {
      const size = Math.min(1024 * 1024, limit - prefix);
      const count = a
        .subtext(prefix, prefix + size)
        .commonPrefixLength(b.subtext(prefix, prefix + size));
      prefix += count;
      {
        const pending = check();
        if (pending) await pending;
      }
      if (count !== size) break;
    }
    if (prefix === a.length && prefix === b.length)
      return { chunks: [], oldLineOffsets: {}, newLineOffsets: {} };
    // Bare CR creates virtual comparison rows, but never buffer rows. A grouped
    // buffer range keeps copying exact instead of exposing invalid row numbers.
    if (left.hasLoneCarriageReturn || right.hasLoneCarriageReturn)
      return grouped(0, left.lineCount, 0, right.lineCount);
    let suffix = 0;
    while (suffix < limit - prefix) {
      const size = Math.min(1024 * 1024, limit - prefix - suffix);
      const count = a
        .subtext(a.length - suffix - size, a.length - suffix)
        .commonSuffixLength(b.subtext(b.length - suffix - size, b.length - suffix));
      suffix += count;
      {
        const pending = check();
        if (pending) await pending;
      }
      if (count !== size) break;
    }
    const start = a.positionAt(prefix).row;
    const oldPoint = a.positionAt(a.length - suffix),
      newPoint = b.positionAt(b.length - suffix);
    // The shared suffix can begin at a line start on just one side (for
    // example an indentation-only change). Advance both offsets by the same
    // suffix length so the two retained tails contain identical whole lines.
    const advance =
      oldPoint.column || newPoint.column ? a.lineStart(oldPoint.row + 1) - (a.length - suffix) : 0;
    const oldEnd = a.positionAt(a.length - suffix + advance).row,
      newEnd = b.positionAt(b.length - suffix + advance).row;
    const oldPart = a.subtext(a.lineStart(start), a.lineStart(oldEnd));
    const newPart = b.subtext(b.lineStart(start), b.lineStart(newEnd));
    if (!small(oldPart) || !small(newPart)) return grouped(start, oldEnd, start, newEnd);
    // This final native refinement is deliberately a single short slice. The
    // complete changed region is already known, so an expensive alignment can
    // safely fall back to that region without omitting any changed text.
    const remaining = Math.min(4, Math.max(1, stopAt - performance.now()));
    const result = computeNormalizedDiff(oldPart.toString(), newPart.toString(), remaining);
    {
      const pending = check();
      if (pending) await pending;
    }
    if (!result) return grouped(start, oldEnd, start, newEnd);
    for (const chunk of result.chunks)
      for (const key of ["oldLineStart", "oldLineEnd", "newLineStart", "newLineEnd"])
        chunk[key] += start;
    for (const key of ["oldLineOffsets", "newLineOffsets"])
      result[key] = Object.fromEntries(
        Object.entries(result[key]).map(([row, value]) => [Number(row) + start, value]),
      );
    return result;
  } catch (error) {
    if (error.code === "ERR_DIFF_TIMEOUT") return null;
    throw error;
  }
}

function grouped(oldLineStart, oldLineEnd, newLineStart, newLineEnd) {
  return {
    grouped: true,
    chunks: [{ oldLineStart, oldLineEnd, newLineStart, newLineEnd }],
    oldLineOffsets: {},
    newLineOffsets: {},
  };
}

async function normalize(source, trim, check) {
  let normalized = source;
  if (source.hasLoneCarriageReturn || source.getLineEndings().has("\r\n")) {
    normalized = source.subtext(0, 0);
    let previousCR = false;
    for (const original of source.chunks()) {
      let text = original;
      if (previousCR && text[0] === "\n") text = text.slice(1);
      previousCR = original.endsWith("\r");
      text = text.replace(/\r\n?/g, "\n");
      normalized = normalized.replace(normalized.length, normalized.length, text);
      {
        const pending = check();
        if (pending) await pending;
      }
    }
  }
  let end = normalized.length;
  while (end) {
    const start = Math.max(0, end - 65536);
    const value = normalized.slice(start, end),
      trailing = /\n+$/.exec(value)?.[0].length ?? 0;
    end -= trailing;
    {
      const pending = check();
      if (pending) await pending;
    }
    if (trailing !== value.length) break;
  }
  normalized = normalized.subtext(0, end).replace(end, end, "\n");
  if (trim !== true && trim !== "true") return normalized;
  let result = source.subtext(0, 0);
  for (let row = 0; row < normalized.lineCount - 1; row++) {
    let start = normalized.lineStart(row),
      end = normalized.lineStart(row + 1) - 1;
    while (start < end) {
      const value = normalized.slice(start, Math.min(end, start + 65536));
      const width = /^\s*/u.exec(value)[0].length;
      start += width;
      {
        const pending = check();
        if (pending) await pending;
      }
      if (width !== value.length) break;
    }
    while (end > start) {
      const value = normalized.slice(Math.max(start, end - 65536), end);
      const width = /\s*$/u.exec(value)[0].length;
      end -= width;
      {
        const pending = check();
        if (pending) await pending;
      }
      if (width !== value.length) break;
    }
    result = result.replace(result.length, result.length, normalized.subtext(start, end));
    result = result.replace(result.length, result.length, "\n");
    {
      const pending = check();
      if (pending) await pending;
    }
  }
  return result;
}

module.exports = { computeSourceDiff, small, normalize };
