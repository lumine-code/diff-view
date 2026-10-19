describe("diff-view live marker projection", () => {
  let mainModule, service, provider, editor1, editor2;

  beforeEach(async () => {
    const workspaceElement = lumine.views.getView(lumine.workspace);
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "600px";
    jasmine.attachToDOM(workspaceElement);
    const pack = await lumine.packages.activatePackage("diff-view");
    mainModule = pack.mainModule;
    service = mainModule.provideDiffView();
    provider = mainModule.provideMarkerLayer();
    editor1 = await lumine.workspace.open();
    lumine.workspace.getActivePane().splitRight();
    editor2 = await lumine.workspace.open();
  });

  afterEach(() => mainModule.disable());

  async function startDiff() {
    await service.diffEditors(editor1, editor2, {
      autoDiff: true,
      diffWords: false,
      muteNotifications: true,
      scrollSyncType: "None",
      turnOffSoftWrap: false,
    });
  }

  it("moves existing diff markers on every Enter before another comparison is published", async () => {
    editor1.setText("header\nsame\nold\nfooter\n");
    editor2.setText("header\nsame\nnew\nfooter\n");
    await startDiff();
    const initial = service.getDiffView();
    expect(initial.markerLayers.editor2.lineMarkerLayer.getMarkerCount()).toBe(1);
    expect(provider.getItems({ editor: editor2 })).toEqual([{ row: 2, end: 2, cls: "removed" }]);
    const update = spyOn(mainModule, "updateDiff").and.callThrough();
    const published = jasmine.createSpy("published");
    const subscription = service.onDidUpdate(published);

    try {
      editor2.setCursorBufferPosition([0, 0]);
      for (let entered = 1; entered <= 3; entered++) {
        editor2.insertText("\n");
        expect(provider.getItems({ editor: editor2 })).toEqual([
          { row: 2 + entered, end: 2 + entered, cls: "removed" },
        ]);
      }

      expect(update).not.toHaveBeenCalled();
      expect(published).not.toHaveBeenCalled();
      expect(service.getDiffView().chunks).toBe(initial.chunks);
      expect(initial.chunks[0].newLineStart).toBe(2);
    } finally {
      subscription.dispose();
    }
  });

  it("includes the final wrapped screen row of a live diff range ending at EOF", async () => {
    editor1.setText("same\nold");
    editor2.setText(`same\n${"word ".repeat(12)}new`);
    await startDiff();
    editor2.setSoftWrapped(true);
    editor2.displayLayer.reset({ softWrapColumn: 20 });

    const [item] = provider.getItems({ editor: editor2 });

    expect(item.row).toBe(editor2.screenRowForBufferRow(1));
    expect(item.end).toBe(editor2.getLastScreenRow());
    expect(item.end).toBeGreaterThan(item.row);
    expect(item.cls).toBe("removed");
  });
});
