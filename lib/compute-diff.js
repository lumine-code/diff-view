/**
 * Computes the line diff between two texts.
 *
 * This runs in the window. jsdiff costs a few milliseconds for an ordinary
 * pair of files — far less than spawning a process to keep it out — and
 * `timeoutMs` bounds the one case where that stops holding: the algorithm is
 * O(ND) in the *number of differences* rather than the size, so a pair with
 * thousands of them can run for seconds. Over budget, jsdiff gives up and
 * `computeDiff` returns null instead of stalling the window indefinitely.
 */

function computeDiff(oldText, newText, isWhitespaceIgnored, timeoutMs) {
  var diffChunks = _computeDiffChunks(oldText, newText, isWhitespaceIgnored, timeoutMs);
  if (diffChunks == null) {
    return null;
  }
  var offsets = _computeOffsets(diffChunks);

  return {
    oldLineOffsets: offsets.oldLineOffsets,
    newLineOffsets: offsets.newLineOffsets,
    chunks: _orderDiffChunks(diffChunks),
  };
}

function _computeDiffChunks(oldText, newText, isWhitespaceIgnored, timeoutMs) {
  var JsDiff = require("diff");

  // Normalize trailing newlines to ensure consistent diff results.
  // Strip all trailing newlines and add exactly one to both files.
  // This prevents phantom differences when files have different trailing newline states.
  oldText = oldText.replace(/\n+$/, "") + "\n";
  newText = newText.replace(/\n+$/, "") + "\n";

  // No budget means no limit, matching how the setting documents zero.
  var options = timeoutMs > 0 ? { timeout: timeoutMs } : {};

  var lineDiff;
  if (isWhitespaceIgnored === true || isWhitespaceIgnored === "true") {
    lineDiff = JsDiff.diffTrimmedLines(oldText, newText, options);
  } else {
    lineDiff = JsDiff.diffLines(oldText, newText, options);
  }

  // jsdiff returns undefined rather than a diff once the budget is spent.
  if (lineDiff == null) {
    return null;
  }

  var chunks = [];
  var nextOffset = 0;
  var offset = 0;

  lineDiff.forEach(function (part) {
    var added = part.added,
      removed = part.removed,
      value = part.value;
    var count = part.count; //value.split('\n').length - 1;
    if (!added && !removed) {
      offset = nextOffset;
      nextOffset = 0;
    } else if (added) {
      nextOffset += count;
    } else {
      nextOffset -= count;
    }
    chunks.push({
      added: added,
      removed: removed,
      value: value,
      count: count,
      offset: offset,
    });
    offset = 0;
  });

  return chunks;
}

function _computeOffsets(diffChunks) {
  var newLineOffsets = {};
  var oldLineOffsets = {};
  var oldLineCount = 0;
  var newLineCount = 0;
  for (var _i = 0, diffChunks_1 = diffChunks; _i < diffChunks_1.length; _i++) {
    var chunk = diffChunks_1[_i];
    var added = chunk.added,
      removed = chunk.removed,
      offset = chunk.offset,
      count = chunk.count;
    if (added) {
      newLineCount += count;
    } else if (removed) {
      oldLineCount += count;
    } else {
      if (offset < 0) {
        // Non zero offset implies this block is neither a removal or an addition,
        // and is thus equal in both versions of the document.
        // Sign of offset indicates which version of document requires the offset
        // (negative -> old version, positive -> new version).
        // Magnitude of offset indicates the number of lines of offset required for respective version.
        newLineOffsets[newLineCount] = offset * -1;
      } else if (offset > 0) {
        oldLineOffsets[oldLineCount] = offset;
      }
      newLineCount += count;
      oldLineCount += count;
    }
  }

  return {
    oldLineOffsets: oldLineOffsets,
    newLineOffsets: newLineOffsets,
  };
}

/*
 * puts the chunks into order so nextDiff and prevDiff are in order
 */
function _orderDiffChunks(chunks) {
  var oldLineNumber = 0;
  var newLineNumber = 0;
  var prevChunk = null;
  // mapping of chunks between the two panes
  var diffChunks = [];

  for (var c of chunks) {
    var diffChunk;
    if (c && c.added) {
      if (prevChunk && prevChunk.removed) {
        diffChunk = {
          newLineStart: newLineNumber,
          newLineEnd: newLineNumber + c.count,
          oldLineStart: oldLineNumber - prevChunk.count,
          oldLineEnd: oldLineNumber,
        };
        diffChunks.push(diffChunk);
        prevChunk = null;
      } else {
        prevChunk = c;
      }

      newLineNumber += c.count;
    } else if (c.removed) {
      if (prevChunk && prevChunk.added) {
        diffChunk = {
          newLineStart: newLineNumber - prevChunk.count,
          newLineEnd: newLineNumber,
          oldLineStart: oldLineNumber,
          oldLineEnd: oldLineNumber + c.count,
        };
        diffChunks.push(diffChunk);
        prevChunk = null;
      } else {
        prevChunk = c;
      }

      oldLineNumber += c.count;
    } else {
      if (prevChunk && prevChunk.added) {
        diffChunk = {
          newLineStart: newLineNumber - prevChunk.count,
          newLineEnd: newLineNumber,
          oldLineStart: oldLineNumber,
          oldLineEnd: oldLineNumber,
        };
        diffChunks.push(diffChunk);
      } else if (prevChunk && prevChunk.removed) {
        diffChunk = {
          newLineStart: newLineNumber,
          newLineEnd: newLineNumber,
          oldLineStart: oldLineNumber - prevChunk.count,
          oldLineEnd: oldLineNumber,
        };
        diffChunks.push(diffChunk);
      }

      prevChunk = null;
      oldLineNumber += c.count;
      newLineNumber += c.count;
    }
  }

  // add the prevChunk if the loop finished
  if (prevChunk && prevChunk.added) {
    diffChunk = {
      newLineStart: newLineNumber - prevChunk.count,
      newLineEnd: newLineNumber,
      oldLineStart: oldLineNumber,
      oldLineEnd: oldLineNumber,
    };
    diffChunks.push(diffChunk);
  } else if (prevChunk && prevChunk.removed) {
    diffChunk = {
      newLineStart: newLineNumber,
      newLineEnd: newLineNumber,
      oldLineStart: oldLineNumber - prevChunk.count,
      oldLineEnd: oldLineNumber,
    };
    diffChunks.push(diffChunk);
  }

  return diffChunks;
}

module.exports = {
  computeDiff: computeDiff,
  _computeDiffChunks: _computeDiffChunks,
  _computeOffsets: _computeOffsets,
  _orderDiffChunks: _orderDiffChunks,
};
