const { CompositeDisposable, Emitter } = require("lumine");

describe("diff-view marker layer", () => {
  let editor1, editor2, mainModule, provider, layer1, layer2, layers, service, consumerDisposable;
  let sourceLayers;

  // Minimal stand-in for the layer object a renderer's host passes to
  // `initialize` and `getItems` (see lib/layer.js in the marker package).
  function makeLayer(targetEditor) {
    const fake = {
      editor: targetEditor,
      props: provider,
      cache: new Map(),
      items: [],
      disposables: new CompositeDisposable(),
    };
    fake.updateSync = jasmine.createSpy("updateSync").and.callFake(() => {
      const items = provider.getItems(fake);
      if (items) {
        fake.items = items;
      }
    });
    fake.update = fake.updateSync;
    provider.initialize(fake);
    layers.push(fake);
    return fake;
  }

  // Build native source markers from the fixture's chunk coordinates, just as
  // the diff display does. The adapter receives only the resulting snapshot.
  function makeState(data) {
    if (!data) return null;
    const makeSource = (editor, startKey, endKey, highlightType) => {
      const lineMarkerLayer = editor.addMarkerLayer();
      const selectionMarkerLayer = editor.addMarkerLayer();
      sourceLayers.push(lineMarkerLayer, selectionMarkerLayer);
      for (const chunk of data.chunks) {
        if (chunk[startKey] !== chunk[endKey]) {
          lineMarkerLayer.markBufferRange(
            [
              [chunk[startKey], 0],
              [chunk[endKey], 0],
            ],
            { invalidate: "never" },
          );
        }
      }
      return { id: editor.id, lineMarkerLayer, selectionMarkerLayer, highlightType };
    };
    const addedOnRight = data.addedColorSide === "right";
    return {
      ...data,
      markerLayers: {
        editor1: makeSource(
          data.editor1,
          "oldLineStart",
          "oldLineEnd",
          addedOnRight ? "removed" : "added",
        ),
        editor2: makeSource(
          data.editor2,
          "newLineStart",
          "newLineEnd",
          addedOnRight ? "added" : "removed",
        ),
      },
    };
  }

  function makeFakeService() {
    const emitter = new Emitter();
    let current = null;
    return {
      getDiffView: () => current,
      onDidUpdate: (callback) => emitter.on("did-update-diff", callback),
      publish(data) {
        current = makeState(data);
        emitter.emit("did-update-diff", current);
        return current;
      },
    };
  }

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const pack = await lumine.packages.activatePackage("diff-view");
    mainModule = pack.mainModule;
    // The package wires the layer to its own service at activation; the specs
    // drive the layer through a fake service instead.
    mainModule.markerLayerConnection.dispose();
    provider = mainModule.provideMarkerLayer();
    layers = [];
    sourceLayers = [];
    editor1 = await lumine.workspace.open();
    editor1.setText(Array(50).fill("old text").join("\n"));
    editor2 = await lumine.workspace.open();
    editor2.setText(Array(50).fill("new text").join("\n"));
    layer1 = makeLayer(editor1);
    layer2 = makeLayer(editor2);
    service = makeFakeService();
    consumerDisposable = mainModule.markerLayer.connect(service);
  });

  afterEach(() => {
    consumerDisposable.dispose();
    for (const layer of layers) {
      layer.disposables.dispose();
    }
    for (const sourceLayer of sourceLayers) sourceLayer.destroy();
  });

  it("activates and provides a marker layer descriptor", () => {
    expect(lumine.packages.isPackageActive("diff-view")).toBe(true);
    expect(provider.name).toBe("diff-view");
    expect(typeof provider.description).toBe("string");
    expect(provider.timer).toBeUndefined();
    expect(provider.merge).toBe(true);
    expect(provider.enabled).toBe("diff-view.marker.enabled");
    expect(provider.threshold).toBe("diff-view.marker.threshold");
    expect(typeof provider.initialize).toBe("function");
    expect(typeof provider.getItems).toBe("function");
  });

  it("marks the chunks of both diff editors with added and removed classes", () => {
    service.publish({
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 3 }],
      editor1,
      editor2,
    });
    expect(layer1.items).toEqual([{ row: 2, end: 3, cls: "added" }]);
    expect(layer2.items).toEqual([{ row: 2, end: 2, cls: "removed" }]);
  });

  it("swaps the classes when the diff puts the added color on the right", () => {
    service.publish({
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 3 }],
      editor1,
      editor2,
      addedColorSide: "right",
    });
    expect(layer1.items).toEqual([{ row: 2, end: 3, cls: "removed" }]);
    expect(layer2.items).toEqual([{ row: 2, end: 2, cls: "added" }]);
  });

  it("skips one-sided chunks on the editor they cover no lines of", () => {
    // A pure insertion: no rows in the old file, two rows in the new one.
    service.publish({
      chunks: [{ oldLineStart: 5, oldLineEnd: 5, newLineStart: 5, newLineEnd: 7 }],
      editor1,
      editor2,
    });
    expect(layer1.items).toEqual([]);
    expect(layer2.items).toEqual([{ row: 5, end: 6, cls: "removed" }]);
  });

  it("returns one raw item per two-sided chunk and leaves merging to the host", () => {
    service.publish({
      chunks: [
        { oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 4 },
        { oldLineStart: 4, oldLineEnd: 7, newLineStart: 4, newLineEnd: 7 },
      ],
      editor1,
      editor2,
    });
    expect(layer1.items).toEqual([
      { row: 2, end: 3, cls: "added" },
      { row: 4, end: 6, cls: "added" },
    ]);
  });

  it("draws a diff that is already running on a layer attached afterwards", async () => {
    // Chunks are cached per editor even when that editor has no layer yet: a
    // layer built after the diff started must draw it without waiting for the
    // next update.
    const editor3 = await lumine.workspace.open();
    editor3.setText(Array(50).fill("new text").join("\n"));
    service.publish({
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 4 }],
      editor1,
      editor2: editor3,
    });

    const late = makeLayer(editor3);
    late.updateSync();
    expect(late.items).toEqual([{ row: 2, end: 3, cls: "removed" }]);
  });

  it("keeps the current diff when its marker layer detaches and reattaches", () => {
    service.publish({
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 3 }],
      editor1,
      editor2,
    });
    layer1.disposables.dispose();

    const replacement = makeLayer(editor1);
    replacement.updateSync();

    expect(replacement.items).toEqual([{ row: 2, end: 3, cls: "added" }]);
  });

  it("seeds the current comparison when the diff service reconnects", () => {
    const data = {
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 3 }],
      editor1,
      editor2,
    };
    consumerDisposable.dispose();
    service.publish(data);

    consumerDisposable = mainModule.markerLayer.connect(service);

    expect(layer1.items).toEqual([{ row: 2, end: 3, cls: "added" }]);
    expect(layer2.items).toEqual([{ row: 2, end: 2, cls: "removed" }]);
  });

  it("ignores old callbacks and cleanup when reconnecting to the same service", () => {
    consumerDisposable.dispose();
    const callbacks = [];
    const onDidUpdate = service.onDidUpdate;
    spyOn(service, "onDidUpdate").and.callFake((callback) => {
      callbacks.push(callback);
      return onDidUpdate(callback);
    });
    const previous = mainModule.markerLayer.connect(service);
    consumerDisposable = mainModule.markerLayer.connect(service);
    const data = {
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 3 }],
      editor1,
      editor2,
    };
    const state = service.publish(data);
    layer1.updateSync.calls.reset();

    callbacks[0](null);
    previous.dispose();

    expect(layer1.updateSync).not.toHaveBeenCalled();
    expect(layer1.items).toEqual([{ row: 2, end: 3, cls: "added" }]);
    consumerDisposable.dispose();
    layer1.updateSync.calls.reset();
    callbacks[1](state);
    expect(layer1.updateSync).not.toHaveBeenCalled();
    expect(layer1.items).toEqual([]);
  });

  it("covers every screen row of a chunk whose lines wrap", () => {
    // Screen rows, not buffer rows: a marker that ended at the first screen row
    // of the chunk's last line covered a fraction of what the chunk spans.
    editor1.setText(Array(50).fill("word ".repeat(40)).join("\n"));
    editor1.setSoftWrapped(true);
    editor1.displayLayer.reset({ softWrapColumn: 20 });

    service.publish({
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 4 }],
      editor1,
      editor2,
    });

    const [item] = layer1.items;
    expect(item.row).toBe(editor1.screenRowForBufferRow(2));
    // The last screen row of buffer line 3 is the row before line 4 starts.
    expect(item.end).toBe(editor1.screenRowForBufferRow(4) - 1);
    expect(item.end).toBeGreaterThan(item.row + 1);
  });

  it("marks the last chunk of the file without running past the end", () => {
    const lastRow = editor1.getLastBufferRow();
    service.publish({
      chunks: [
        {
          oldLineStart: lastRow,
          oldLineEnd: lastRow + 1,
          newLineStart: lastRow,
          newLineEnd: lastRow + 1,
        },
      ],
      editor1,
      editor2,
    });

    expect(layer1.items).toEqual([
      {
        row: editor1.screenRowForBufferRow(lastRow),
        end: editor1.getLastScreenRow(),
        cls: "added",
      },
    ]);
  });

  it("projects the live clipped source range after the buffer shrinks", () => {
    service.publish({
      chunks: [{ oldLineStart: 40, oldLineEnd: 42, newLineStart: 40, newLineEnd: 42 }],
      editor1,
      editor2,
    });
    const before = layer1.items;
    expect(before.length).toBe(1);

    // Follow the same anchor as the source decoration before another
    // comparison has supplied new markers.
    editor1.getBuffer().delete([[1, 0], editor1.getBuffer().getEndPosition()]);
    layer1.updateSync();

    expect(layer1.items).toEqual([{ row: 1, end: 1, cls: "added" }]);
  });

  it("clears its items when the source marker layer is destroyed", () => {
    service.publish({
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 3 }],
      editor1,
      editor2,
    });
    service.getDiffView().markerLayers.editor1.lineMarkerLayer.destroy();

    layer1.updateSync();

    expect(layer1.items).toEqual([]);
  });

  it("clears the previous editors when the diff view is closed", () => {
    service.publish({
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 4 }],
      editor1,
      editor2,
    });
    expect(layer1.items.length).toBe(1);
    expect(layer2.items.length).toBe(1);

    service.publish(null);
    expect(layer1.items).toEqual([]);
    expect(layer2.items).toEqual([]);
  });

  it("clears the layers when the consumer is disposed", () => {
    service.publish({
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 4 }],
      editor1,
      editor2,
    });
    expect(layer1.items.length).toBe(1);

    consumerDisposable.dispose();
    expect(layer1.items).toEqual([]);
    expect(layer2.items).toEqual([]);
    expect(mainModule.markerLayer.diffService).toBeNull();

    layer1.updateSync.calls.reset();
    service.publish({
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 4 }],
      editor1,
      editor2,
    });
    expect(layer1.updateSync).not.toHaveBeenCalled();
  });
});
