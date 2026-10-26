module.exports = class BufferExtender {
  constructor(buffer) {
    this._buffer = buffer;
  }

  /**
   * Gets the line ending for the buffer.
   *
   * @return The line ending as a string.
   */
  getLineEnding() {
    const lineEndings = this._buffer.getLineEndings();

    if (lineEndings.size > 1) {
      return "Mixed";
    } else if (lineEndings.has("\n")) {
      return "\n";
    } else if (lineEndings.has("\r\n")) {
      return "\r\n";
    } else if (lineEndings.has("\r")) {
      return "\r";
    } else {
      return "";
    }
  }
};
