describe("comparison guides in editor windows", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("diff-view");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("diff-view");
    await lumine.workspace.discardEditorWindows();
  });
  it("creates local guide geometry and pointer listeners in future windows", async () => {
    const main = lumine.packages.getActivePackage("diff-view").mainModule;
    main._addCenterLineElement();
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const line = extra.getElement().querySelector(".diff-view-center-line");
    expect(line).not.toBeNull();
    expect(line.ownerDocument).toBe(extra.getDocument());
    const moved = spyOn(main, "_updateCenterLinePositions").and.callThrough();
    const nativeWindow = extra.getDocument().defaultView;
    line.dispatchEvent(new nativeWindow.MouseEvent("mousedown", { bubbles: true }));
    extra.getDocument().dispatchEvent(new nativeWindow.MouseEvent("mousemove", { clientY: 100 }));
    expect(moved).toHaveBeenCalled();
    extra.getDocument().dispatchEvent(new nativeWindow.MouseEvent("mouseup"));
    await lumine.workspace.attachWindow(extra);
    expect(line.isConnected).toBe(false);
  });
});
