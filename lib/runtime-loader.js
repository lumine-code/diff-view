module.exports = class RuntimeLoader {
  importRuntime() {
    return import("./runtime.js");
  }

  load() {
    this.pending ??= Promise.resolve()
      .then(() => this.importRuntime())
      .then((namespace) => namespace.default ?? namespace)
      .catch((error) => {
        this.pending = null;
        throw error;
      });
    return this.pending;
  }
};
