const { computeDiff } = require("./compute-diff");
const { computeWordDiff } = require("./compute-word-diff");

module.exports = function connect(port) {
  port.onmessage = ({ data }) => {
    try {
      const { type, left, right, ignoreWhitespace, timeout, pairs } = data;
      const result =
        type === "words"
          ? compareWords(pairs, timeout)
          : computeDiff(left, right, ignoreWhitespace, timeout);
      port.postMessage({ result });
    } catch (error) {
      port.postMessage({ error: error.message });
    }
  };
};

function compareWords(pairs, timeout) {
  const deadline = timeout > 0 ? Date.now() + timeout : Infinity;
  const results = [];
  for (const [left, right] of pairs) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    results.push(computeWordDiff(left, right, Number.isFinite(remaining) ? remaining : 0));
  }
  return results;
}
