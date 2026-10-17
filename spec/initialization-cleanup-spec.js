describe("diff-view initialization cleanup", () => {
  let pack;

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("diff-view"))
      await lumine.packages.unloadPackage("diff-view", { serialize: false });
    pack = lumine.packages.loadPackage("diff-view");
    pack.initializeForExternalUse("workspace restoration");
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("diff-view"))
      await lumine.packages.unloadPackage("diff-view", { serialize: false });
  });

  it("deactivates before activation and can activate again", async () => {
    const scope = pack.lifecycleContext.subscriptions;
    expect(pack.mainActivationStarted).toBe(false);
    await expectAsync(pack.deactivate()).toBeResolved();
    expect(scope.disposed).toBe(true);
    pack = await lumine.packages.activatePackage("diff-view");
    expect(pack.mainActivated).toBe(true);
    expect(pack.lifecycleContext.subscriptions).not.toBe(scope);
  });

  it("unloads before activation starts", async () => {
    expect(pack.mainInitialized).toBe(true);
    expect(pack.mainActivationStarted).toBe(false);
    await expectAsync(
      lumine.packages.unloadPackage("diff-view", { serialize: false }),
    ).toBeResolved();
    expect(lumine.packages.isPackageLoaded("diff-view")).toBe(false);
  });
});
