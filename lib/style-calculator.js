const { CompositeDisposable, Disposable } = require("lumine");

module.exports = class StyleCalculator {
  constructor(styles, config) {
    this.styles = styles;
    this.config = config;
    this.stylesheetDisposable = null;
  }

  startWatching(sourcePath, configsToWatch, getStylesheetFn) {
    const subscriptions = new CompositeDisposable();
    const updateStyles = () => {
      this.updateStyles(sourcePath, getStylesheetFn);
    };
    configsToWatch.forEach((configToWatch) => {
      subscriptions.add(this.config.onDidChange(configToWatch, updateStyles));
    });
    updateStyles();
    // The style manager reuses one element per sourcePath, so disposing the
    // latest add removes the stylesheet from the workspace.
    subscriptions.add(
      new Disposable(() => {
        if (this.stylesheetDisposable) {
          this.stylesheetDisposable.dispose();
          this.stylesheetDisposable = null;
        }
      }),
    );
    return subscriptions;
  }

  updateStyles(sourcePath, getStylesheetFn) {
    const stylesheet = getStylesheetFn(this.config);
    this.stylesheetDisposable = this.styles.addStyleSheet(stylesheet, { sourcePath });
  }
};
