module.exports = class ComparisonWorkerClient {
  constructor() {
    const entry = require.resolve("./comparison-worker");
    this.url = URL.createObjectURL(
      new Blob([`require(${JSON.stringify(entry)})(self);`], { type: "text/javascript" }),
    );
    try {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Chromium Worker in the renderer.
      this.worker = new globalThis.Worker(this.url);
    } catch (error) {
      URL.revokeObjectURL(this.url);
      throw error;
    }
    this.closed = false;
    this.pending = null;
    this.worker.onmessage = ({ data }) => {
      const pending = this.takePending();
      if (!pending) return;
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.close(new Error(event.message || "Comparison worker failed"));
    };
    this.worker.onmessageerror = () =>
      this.close(new Error("Unable to decode a comparison result"));
  }

  request(message, signal) {
    signal.throwIfAborted();
    if (this.closed || this.pending) throw new Error("Comparison worker is unavailable");
    return new Promise((resolve, reject) => {
      // The worker cannot receive a cancel message during synchronous jsdiff
      // work. Termination frees the worker immediately for the next revision.
      const abort = () => this.close(signal.reason);
      this.pending = { resolve, reject, signal, abort };
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.worker.postMessage(message);
      } catch (error) {
        this.close(error);
      }
    });
  }

  takePending() {
    const pending = this.pending;
    this.pending = null;
    pending?.signal.removeEventListener("abort", pending.abort);
    return pending;
  }

  close(error = new DOMException("Comparison was cancelled", "AbortError")) {
    if (this.closed) return;
    this.closed = true;
    this.takePending()?.reject(error);
    this.worker.terminate();
    URL.revokeObjectURL(this.url);
  }
};
