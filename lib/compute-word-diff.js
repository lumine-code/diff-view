function computeWordDiff(oldText, newText, timeoutMs) {
  var addedWords = [];
  var removedWords = [];

  if (oldText || newText) {
    var JsDiff = require("diff");
    var options = timeoutMs > 0 ? { timeout: timeoutMs } : {};
    var wordDiff = JsDiff.diffWordsWithSpace(oldText || "", newText || "", options);

    // Long changed lines can cost much more than the line diff. Let the caller
    // retain its line highlights when the inline diff spends its budget.
    if (wordDiff == null) {
      return null;
    }

    // split into two lists: added + removed
    wordDiff.forEach((part) => {
      if (part.added) {
        part.changed = true;
        addedWords.push(part);
      } else if (part.removed) {
        part.changed = true;
        removedWords.push(part);
      } else {
        addedWords.push(part);
        removedWords.push(part);
      }
    });
  }

  return {
    addedWords,
    removedWords,
  };
}

module.exports = {
  computeWordDiff,
};
