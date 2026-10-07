const path = require("path");

describe("diff toggle theme colors", () => {
  it("pairs the selected button foreground with its filled background", () => {
    const stylesheet = lumine.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "diff-view.css"),
    );
    const container = document.createElement("div");
    container.className = "diff-view-ui";
    container.style.cssText =
      "--button-background-color-selected: rgb(10,20,30); --button-text-color-selected: rgb(240,230,220); --text-color-selected: rgb(100,110,120);";
    container.innerHTML =
      '<button class="btn ignore-whitespace selected">Ignore Whitespace</button>';
    jasmine.attachToDOM(container);
    try {
      const style = getComputedStyle(container.firstElementChild);
      expect(style.backgroundColor).toBe("rgb(10, 20, 30)");
      expect(style.color).toBe("rgb(240, 230, 220)");
    } finally {
      container.remove();
      stylesheet.dispose();
    }
  });
});
