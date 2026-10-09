describe("Copying a difference at end of file", () => {
  let main, left, right, service;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("diff-view")).mainModule;
    service = main.provideDiffView();
    left = await lumine.workspace.open();
    right = await lumine.workspace.open(null, { split: "right" });
  });

  afterEach(() => {
    service.disable();
    left?.destroy();
    right?.destroy();
    main = left = right = service = null;
  });

  async function compare(leftText, rightText) {
    left.setText(leftText);
    right.setText(rightText);
    await service.diffEditors(left, right, { autoDiff: false, muteNotifications: true });
    expect(service.getDiffView().chunks.length).toBe(1);
    lumine.commands.dispatch(lumine.workspace.getElement(), "diff-view:next-diff");
  }

  it("appends the left chunk after the right editor's existing final text", async () => {
    await compare("same\nadded", "same");
    lumine.commands.dispatch(lumine.workspace.getElement(), "diff-view:copy-to-right");
    expect(right.getText()).toBe("same\nadded");
  });

  it("appends the right chunk after the left editor's existing final text", async () => {
    await compare("same", "same\nadded");
    lumine.commands.dispatch(lumine.workspace.getElement(), "diff-view:copy-to-left");
    expect(left.getText()).toBe("same\nadded");
  });

  it("uses an existing final newline without inserting another one", async () => {
    await compare("same\nadded\n", "same\n");
    lumine.commands.dispatch(lumine.workspace.getElement(), "diff-view:copy-to-right");
    expect(right.getText()).toBe("same\nadded\n");
  });

  it("aligns the rendered content heights when the changed final line has no newline", async () => {
    await compare("same\nadded", "same");
    for (let frame = 0; frame < 3; frame++) {
      left.getElement().getComponent().updateSync();
      right.getElement().getComponent().updateSync();
      await new Promise(requestAnimationFrame);
    }
    const leftHeight = left.getElement().getComponent().getContentHeight();
    const rightHeight = right.getElement().getComponent().getContentHeight();
    expect(leftHeight).toBeGreaterThan(0);
    expect(rightHeight).toBe(leftHeight);
  });
});
