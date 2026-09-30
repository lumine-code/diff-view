describe("word highlights", () => {
  let mainModule;
  let editor1;
  let editor2;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const pkg = await lumine.packages.activatePackage("diff-view");
    mainModule = pkg.mainModule;
    lumine.config.set("diff-view.diffWords", true);
    editor1 = await lumine.workspace.open();
    editor1.setText("prefix old suffix\n");
    lumine.workspace.getActivePane().splitRight();
    editor2 = await lumine.workspace.open();
    editor2.setText("prefix new suffix\n");
  });

  afterEach(() => {
    mainModule.disable();
  });

  function wordDecorations(editor) {
    return editor
      .getDecorations({ type: "highlight" })
      .filter((decoration) => /^diff-view-word-/.test(decoration.getProperties().class));
  }

  function wordMarkers() {
    return [...wordDecorations(editor1), ...wordDecorations(editor2)].map((decoration) =>
      decoration.getMarker(),
    );
  }

  async function startDiff(options = {}) {
    await mainModule.diffEditors(editor1, editor2, {
      autoDiff: false,
      muteNotifications: true,
      scrollSyncType: "None",
      ...options,
    });
    expect(wordDecorations(editor1).length).toBe(1);
    expect(wordDecorations(editor2).length).toBe(1);
  }

  it("highlights the changed words at their buffer columns", async () => {
    await startDiff();

    expect(wordDecorations(editor1)[0].getMarker().getBufferRange().serialize()).toEqual([
      [0, 7],
      [0, 10],
    ]);
    expect(wordDecorations(editor2)[0].getMarker().getBufferRange().serialize()).toEqual([
      [0, 7],
      [0, 10],
    ]);
  });

  it("replaces the previous word markers before publishing a recomputed diff", async () => {
    await startDiff();
    const oldMarkers = wordMarkers();

    mainModule.updateDiff({ editor1, editor2 });

    expect(oldMarkers.every((marker) => marker.isDestroyed())).toBe(true);
    expect(wordDecorations(editor1).length).toBe(1);
    expect(wordDecorations(editor2).length).toBe(1);
  });

  it("removes word highlights immediately when Show Word Diff is turned off", async () => {
    await startDiff();
    const oldMarkers = wordMarkers();

    lumine.config.set("diff-view.diffWords", false);

    expect(oldMarkers.every((marker) => marker.isDestroyed())).toBe(true);
    expect(wordDecorations(editor1)).toEqual([]);
    expect(wordDecorations(editor2)).toEqual([]);
    expect(mainModule.diffView.getNumDifferences()).toBe(1);
  });

  it("removes word markers synchronously when the diff is disabled", async () => {
    await startDiff();
    const oldMarkers = wordMarkers();
    const extenders = [
      mainModule.diffView._editorDiffExtender1,
      mainModule.diffView._editorDiffExtender2,
    ];
    const ownedLayers = extenders.flatMap((extender) => [
      extender.getLineMarkerLayer(),
      extender._wordMarkerLayer,
      extender.getSelectionMarkerLayer(),
    ]);

    mainModule.disable();

    expect(oldMarkers.every((marker) => marker.isDestroyed())).toBe(true);
    expect(ownedLayers.every((layer) => layer.isDestroyed())).toBe(true);
    expect(wordDecorations(editor1)).toEqual([]);
    expect(wordDecorations(editor2)).toEqual([]);
  });

  it("keeps diff markers out of the default layer and preserves another consumer's markers", async () => {
    const defaultMarker = editor1.markBufferRange([
      [0, 0],
      [0, 6],
    ]);
    const otherLayer = editor2.addMarkerLayer();
    const otherMarker = otherLayer.markBufferRange([
      [0, 0],
      [0, 6],
    ]);
    editor1.decorateMarker(defaultMarker, { type: "highlight", class: "another-consumer" });
    editor2.decorateMarker(otherMarker, { type: "highlight", class: "another-consumer" });

    await startDiff();
    expect(editor1.getMarkers()).toEqual([defaultMarker]);
    expect(editor2.getMarkers()).toEqual([]);
    const ownedMarkers = wordMarkers();

    mainModule.disable();

    expect(ownedMarkers.every((marker) => marker.isDestroyed())).toBe(true);
    expect(defaultMarker.isDestroyed()).toBe(false);
    expect(otherMarker.isDestroyed()).toBe(false);
    expect(otherLayer.isDestroyed()).toBe(false);
    expect(editor1.getDecorations({ class: "another-consumer" }).length).toBe(1);
    expect(editor2.getDecorations({ class: "another-consumer" }).length).toBe(1);
    defaultMarker.destroy();
    otherLayer.destroy();
  });

  it("clears stale highlights on both sides before automatic recomputation", async () => {
    await startDiff({ autoDiff: true });
    const oldMarkers = wordMarkers();
    const update = spyOn(mainModule, "updateDiff").and.callThrough();

    editor2.setText(editor1.getText());

    // onDidStopChanging has not fired yet. The old word markers describe
    // different text, so none of them may decorate the edited buffers.
    expect(update).not.toHaveBeenCalled();
    expect(oldMarkers.every((marker) => marker.isDestroyed())).toBe(true);
    expect(wordDecorations(editor1)).toEqual([]);
    expect(wordDecorations(editor2)).toEqual([]);

    mainModule.updateDiff({ editor1, editor2 });
    expect(mainModule.diffView.getNumDifferences()).toBe(0);
  });

  it("clears stale word highlights after an edit with Auto Diff disabled", async () => {
    await startDiff();
    const oldMarkers = wordMarkers();

    editor1.setText("a completely different buffer\n");

    expect(oldMarkers.every((marker) => marker.isDestroyed())).toBe(true);
    expect(wordDecorations(editor1)).toEqual([]);
    expect(wordDecorations(editor2)).toEqual([]);
  });

  it("cleans up word markers when the package is deactivated and uses the new generation", async () => {
    await startDiff();
    const oldMarkers = wordMarkers();

    await lumine.packages.deactivatePackage("diff-view");

    expect(oldMarkers.every((marker) => marker.isDestroyed())).toBe(true);
    expect(wordDecorations(editor1)).toEqual([]);
    expect(wordDecorations(editor2)).toEqual([]);

    const pkg = await lumine.packages.activatePackage("diff-view");
    mainModule = pkg.mainModule;
    await startDiff();
    expect(wordMarkers().every((marker) => !oldMarkers.includes(marker))).toBe(true);
  });
});
