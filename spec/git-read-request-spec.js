const path = require("path");
const { Disposable } = require("lumine");

function deferred() {
  let resolve, reject;
  const promise = new Promise((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("diff-view Git read requests", () => {
  let main, editor, repository, resolver, releases;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("diff-view")).mainModule;
    editor = await lumine.workspace.open(__filename);
    repository = {
      getFileAtRevision: jasmine.createSpy("getFileAtRevision").and.resolveTo("from Git\n"),
    };
    resolver = spyOn(lumine.repositories, "resolveForPath").and.resolveTo(repository);
    releases = [];
    spyOn(lumine.repositories, "retain").and.callFake(() => {
      const release = jasmine.createSpy("release read lease");
      releases.push(release);
      return new Disposable(release);
    });
  });
  afterEach(() => {
    main.disable();
    if (!editor.isDestroyed()) editor.destroy();
  });

  it("resolves the dispatch target authoritatively and holds its repository until the read finishes", async () => {
    const read = deferred();
    repository.getFileAtRevision.and.returnValue(read.promise);
    const comparing = main.diffGit({ target: lumine.views.getView(editor) });
    await conditionPromise(() => repository.getFileAtRevision.calls.count() > 0);
    expect(resolver).toHaveBeenCalledWith(editor.getPath());
    expect(releases[0]).not.toHaveBeenCalled();
    expect(repository.getFileAtRevision.calls.mostRecent().args[2].signal.aborted).toBe(false);
    read.resolve("from Git\n");
    await comparing;
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(main.diffView._editorDiffExtender2.getEditor().getText()).toBe("from Git\n");
  });

  it("aborts a disabled Git comparison and ignores its late read failure", async () => {
    const read = deferred();
    repository.getFileAtRevision.and.returnValue(read.promise);
    const error = spyOn(lumine.notifications, "addError");
    const warning = spyOn(lumine.notifications, "addWarning");
    const comparing = main.diffGit();
    await conditionPromise(() => repository.getFileAtRevision.calls.count() > 0);
    const signal = repository.getFileAtRevision.calls.mostRecent().args[2].signal;
    main.disable();
    expect(signal.aborted).toBe(true);
    read.reject(new Error("late Git failure"));
    await comparing;
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(main.diffView).toBeNull();
    expect(error).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("cancels discovery before retaining or reading an obsolete editor path", async () => {
    const discovery = deferred();
    resolver.and.returnValue(discovery.promise);
    const comparing = main.diffGit();
    editor.getBuffer().setPath(path.join(path.dirname(__filename), "renamed.js"));
    discovery.resolve(repository);
    await comparing;
    expect(repository.getFileAtRevision).not.toHaveBeenCalled();
    expect(releases.length).toBe(0);
    expect(main.diffView).toBeNull();
  });

  it("supersedes an in-flight Git read with a newer comparison without applying stale text", async () => {
    const read = deferred();
    repository.getFileAtRevision.and.returnValues(read.promise, Promise.resolve("new Git text\n"));
    const first = main.diffGit();
    await conditionPromise(() => repository.getFileAtRevision.calls.count() > 0);
    const signal = repository.getFileAtRevision.calls.first().args[2].signal;
    await main.diffGit();
    const current = main.diffView;
    expect(signal.aborted).toBe(true);
    read.resolve("obsolete Git text\n");
    await first;
    expect(main.diffView).toBe(current);
    expect(current._editorDiffExtender2.getEditor().getText()).toBe("new Git text\n");
    expect(releases.every((release) => release.calls.count() === 1)).toBe(true);
  });

  it("reports a real Git read error with its diagnostic instead of claiming the version is absent", async () => {
    repository.getFileAtRevision.and.rejectWith(new Error("Git executable could not be started"));
    const errors = spyOn(lumine.notifications, "addError");
    const warnings = spyOn(lumine.notifications, "addWarning");
    await main.diffGit();
    expect(errors.calls.mostRecent().args[0]).toBe("Diff View");
    expect(errors.calls.mostRecent().args[1].detail).toBe("Git executable could not be started");
    expect(warnings).not.toHaveBeenCalled();
    expect(main.diffView).toBeNull();
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });

  it("aborts a quick Git fallback when its pending comparison is disabled", async () => {
    const read = deferred();
    repository.getFileAtRevision.and.callFake((_file, _revision, { signal }) => {
      signal.addEventListener("abort", () => read.reject(new Error("aborted")), { once: true });
      return read.promise;
    });
    const comparing = main.diffPanes(null, null, { autoDiff: false, muteNotifications: true });
    await conditionPromise(() => repository.getFileAtRevision.calls.count() > 0);
    const scratch = main.pendingDiffRequest.editors.editor2;
    const signal = repository.getFileAtRevision.calls.mostRecent().args[2].signal;
    main.disable();
    await comparing;
    expect(signal.aborted).toBe(true);
    expect(scratch.isDestroyed()).toBe(true);
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });

  it("aborts a repository read when its editor changes path", async () => {
    const read = deferred();
    repository.getFileAtRevision.and.returnValue(read.promise);
    const comparing = main.diffGit();
    await conditionPromise(() => repository.getFileAtRevision.calls.count() > 0);
    const signal = repository.getFileAtRevision.calls.mostRecent().args[2].signal;
    editor.getBuffer().setPath(path.join(path.dirname(__filename), "different.js"));
    expect(signal.aborted).toBe(true);
    read.resolve("old path's Git text\n");
    await comparing;
    expect(main.diffView).toBeNull();
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });

  it("does not reopen a comparison when a Git read completes after package deactivation", async () => {
    const read = deferred();
    repository.getFileAtRevision.and.returnValue(read.promise);
    const comparing = main.diffGit();
    await conditionPromise(() => repository.getFileAtRevision.calls.count() > 0);
    const signal = repository.getFileAtRevision.calls.mostRecent().args[2].signal;
    await lumine.packages.deactivatePackage("diff-view");
    expect(signal.aborted).toBe(true);
    read.resolve("old generation's Git text\n");
    await comparing;
    expect(main.diffView).toBeNull();
    expect(main.isEnabled).toBe(false);
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });

  it("keeps text entered into the blank side while its Git fallback is loading", async () => {
    const read = deferred();
    repository.getFileAtRevision.and.returnValue(read.promise);
    const comparing = main.diffPanes(null, null, { autoDiff: false, muteNotifications: true });
    await conditionPromise(() => repository.getFileAtRevision.calls.count() > 0);
    const scratch = main.pendingDiffRequest.editors.editor2;
    scratch.setText("typed while Git was loading\n");
    read.resolve("from Git\n");
    await comparing;
    expect(main.diffView._editorDiffExtender2.getEditor()).toBe(scratch);
    expect(scratch.getText()).toBe("typed while Git was loading\n");
  });
});
