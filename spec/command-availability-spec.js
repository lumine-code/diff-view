describe("active comparison command availability", () => {
  it("requires a comparison and a writable copy destination while preserving mode toggles", async () => {
    const main = (await lumine.packages.activatePackage("diff-view")).mainModule;
    const available = (action) =>
      lumine.commands.canDispatch(lumine.workspace.getElement(), "diff-view:" + action);
    try {
      expect(available("copy-to-right")).toBe(false);
      expect(available("toggle-soft-wrap")).toBe(false);
      expect(available("set-auto-diff")).toBe(true);
      const left = await lumine.workspace.open();
      left.setText("left");
      lumine.workspace.getActivePane().splitRight();
      const right = await lumine.workspace.open();
      right.setText("right");
      await main.diffPanes(null, null, { autoDiff: false, muteNotifications: true });
      expect(available("copy-to-right")).toBe(true);
      expect(available("toggle-soft-wrap")).toBe(true);
      right.setReadOnly(true);
      expect(available("copy-to-right")).toBe(false);
      expect(available("copy-to-left")).toBe(true);
      main.close();
      expect(available("copy-to-left")).toBe(false);
    } finally {
      main.disable();
      await lumine.packages.deactivatePackage("diff-view");
    }
  });
});
