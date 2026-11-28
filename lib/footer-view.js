const { CompositeDisposable } = require("lumine");

module.exports = class FooterView {
  constructor(
    isWhitespaceIgnored,
    disableIgnoreWhitespace,
    isAutoDiffEnabled,
    disableAutoDiff,
    isSoftWrapEnabled,
  ) {
    this._subscriptions = new CompositeDisposable();

    // create root UI element
    this.element = document.createElement("div");
    this.element.classList.add("diff-view-ui");

    // ------------
    // LEFT COLUMN |
    // ------------

    const prevDiffButton = this.createButton("prev-diff", "chevron-up", "Previous Diff");
    const nextDiffButton = this.createButton("next-diff", "chevron-down", "Next Diff");

    // create selection counter
    this.selectionCountValue = document.createElement("span");
    this.selectionCountValue.classList.add("selection-count-value");
    this.element.appendChild(this.selectionCountValue);

    // create selection divider
    const selectionDivider = document.createElement("span");
    selectionDivider.textContent = "/";
    selectionDivider.classList.add("selection-divider");
    this.element.appendChild(selectionDivider);

    // create selection count container
    this.selectionCount = document.createElement("div");
    this.selectionCount.classList.add("selection-count", "hidden");
    this.selectionCount.appendChild(this.selectionCountValue);
    this.selectionCount.appendChild(selectionDivider);

    // create number of differences value
    this.numDifferencesValue = document.createElement("span");
    this.numDifferencesValue.classList.add("num-diff-value", "diff-view-loading-icon");

    // create number of differences text
    this.numDifferencesText = document.createElement("span");
    this.numDifferencesText.textContent = "differences";
    this.numDifferencesText.classList.add("num-diff-text");

    // create number of differences container
    const numDifferences = document.createElement("div");
    numDifferences.classList.add("num-diff");
    numDifferences.appendChild(this.numDifferencesValue);
    numDifferences.appendChild(this.numDifferencesText);

    // create left column
    const left = document.createElement("div");
    left.classList.add("left");
    left.appendChild(prevDiffButton);
    left.appendChild(nextDiffButton);
    left.appendChild(this.selectionCount);
    left.appendChild(numDifferences);
    this.element.appendChild(left);

    // -----------
    // MID COLUMN |
    // -----------

    const copyToLeftButton = this.createButton("copy-to-left", "clippy", "Copy to Left");
    const copyToRightButton = this.createButton("copy-to-right", "clippy", "Copy to Right");

    // create mid column
    const mid = document.createElement("div");
    mid.classList.add("mid");
    mid.appendChild(copyToLeftButton);
    mid.appendChild(copyToRightButton);
    this.element.appendChild(mid);

    // -------------
    // RIGHT COLUMN |
    // -------------

    this.ignoreWhitespaceBtn = this.createButton(
      "ignore-whitespace",
      "eye",
      "Ignore Whitespace",
      "set-ignore-whitespace",
    );
    this.ignoreWhitespaceBtn.disabled = Boolean(disableIgnoreWhitespace);
    this.setIgnoreWhitespace(Boolean(isWhitespaceIgnored));

    this.autoDiffBtn = this.createButton("auto-diff", "sync", "Auto Diff", "set-auto-diff");
    this.autoDiffBtn.disabled = Boolean(disableAutoDiff);
    this.setAutoDiff(Boolean(isAutoDiffEnabled));

    this.softWrapBtn = this.createButton("soft-wrap", "unfold", "Soft Wrap", "toggle-soft-wrap");
    this.setSoftWrap(Boolean(isSoftWrapEnabled));

    const equalizeWidthsButton = this.createButton("equalize-widths", "mirror", "Equalize Widths");

    this.centerLineBtn = this.createButton(
      "center-line",
      "horizontal-rule",
      "Show Center Line",
      "toggle-center-line",
    );
    this.setCenterLine(false);

    const closeButton = this.createButton("close-diff", "x", "Close Diff View", "close");

    // create right column
    const right = document.createElement("div");
    right.classList.add("right");
    right.appendChild(this.ignoreWhitespaceBtn);
    right.appendChild(this.autoDiffBtn);
    right.appendChild(this.softWrapBtn);
    right.appendChild(equalizeWidthsButton);
    right.appendChild(this.centerLineBtn);
    right.appendChild(closeButton);
    this.element.appendChild(right);
  }

  createButton(className, icon, label, command = className) {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("btn", "btn-md", `icon-${icon}`, className);
    button.setAttribute("aria-label", label);
    button.onclick = () => {
      lumine.commands.dispatch(lumine.views.getView(lumine.workspace), `diff-view:${command}`);
    };
    this._subscriptions.add(lumine.tooltips.add(button, { title: label }));
    return button;
  }

  destroy() {
    document.body.classList.remove("diff-view-visible");
    if (this._subscriptions) {
      this._subscriptions.dispose();
      this._subscriptions = null;
    }
    this.element.remove();
    this.footerPanel.destroy();
  }

  getElement() {
    return this.element;
  }

  createPanel() {
    this.footerPanel = lumine.workspace.addBottomPanel({ item: this.element });
  }

  show() {
    this.footerPanel.show();
    document.body.classList.add("diff-view-visible");
  }

  hide() {
    this.footerPanel.hide();
    document.body.classList.remove("diff-view-visible");
  }

  // Clear the loading indicator when the line comparison is ready. Word
  // details can continue in the background while the line count is visible.
  setNumDifferences(num) {
    this.numDifferencesValue.classList.remove("diff-view-loading-icon");
    if (num === 1) {
      this.numDifferencesText.textContent = "difference";
    } else {
      this.numDifferencesText.textContent = "differences";
    }
    this.numDifferencesValue.textContent = num;
  }

  setPending() {
    this.numDifferencesValue.classList.add("diff-view-loading-icon");
    this.numDifferencesValue.textContent = "";
    this.numDifferencesText.textContent = "comparing";
  }

  setGroupedDifferences() {
    this.numDifferencesText.textContent =
      "grouped difference (detailed comparison budget exceeded)";
  }

  // the diff ran out of its compute budget, so there is no count to show
  setTooManyDifferences() {
    this.numDifferencesValue.classList.remove("diff-view-loading-icon");
    this.numDifferencesValue.textContent = null;
    this.numDifferencesText.textContent = "too many differences";
  }

  showSelectionCount(count) {
    this.selectionCountValue.textContent = count;
    this.selectionCount.classList.remove("hidden");
  }

  hideSelectionCount() {
    this.selectionCount.classList.add("hidden");
  }

  setIgnoreWhitespace(isWhitespaceIgnored) {
    this.ignoreWhitespaceBtn.classList.toggle("selected", isWhitespaceIgnored);
    this.ignoreWhitespaceBtn.setAttribute("aria-pressed", String(isWhitespaceIgnored));
  }

  setAutoDiff(isAutoDiffEnabled) {
    this.autoDiffBtn.classList.toggle("selected", isAutoDiffEnabled);
    this.autoDiffBtn.setAttribute("aria-pressed", String(isAutoDiffEnabled));
  }

  setSoftWrap(isSoftWrapEnabled) {
    this.softWrapBtn.classList.toggle("selected", isSoftWrapEnabled);
    this.softWrapBtn.setAttribute("aria-pressed", String(isSoftWrapEnabled));
  }

  setCenterLine(isCenterLineEnabled) {
    this.centerLineBtn.classList.toggle("selected", isCenterLineEnabled);
    this.centerLineBtn.setAttribute("aria-pressed", String(isCenterLineEnabled));
  }
};
