const { CompositeDisposable, Emitter } = require("lumine");

describe("diff-view marker layer", () => {
  let editor1, editor2, mainModule, provider, layer1, layer2, layers, service, consumerDisposable;

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

  // Fake service mirroring the object returned by provideDiffView():
  // onDidUpdate callbacks receive { chunks, editor1, editor2, addedColorSide }
  // or null.
  function makeFakeService() {
    const emitter = new Emitter();
    return {
      emitter,
      getDiffView: () => null,
      onDidUpdate: (callback) => emitter.on("did-update-diff", callback),
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
  });

  it("activates and provides a marker layer descriptor", () => {
    expect(lumine.packages.isPackageActive("diff-view")).toBe(true);
    expect(provider.name).toBe("diff-view");
    expect(typeof provider.description).toBe("string");
    expect(provider.timer).toBe(100);
    expect(provider.merge).toBe(true);
    expect(provider.enabled).toBe("diff-view.marker.enabled");
    expect(provider.threshold).toBe("diff-view.marker.threshold");
    expect(typeof provider.initialize).toBe("function");
    expect(typeof provider.getItems).toBe("function");
  });

  it("marks the chunks of both diff editors with added and removed classes", () => {
    service.emitter.emit("did-update-diff", {
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 3 }],
      editor1,
      editor2,
    });
    expect(layer1.items).toEqual([{ row: 2, end: 3, cls: "added" }]);
    expect(layer2.items).toEqual([{ row: 2, end: 2, cls: "removed" }]);
  });

  it("swaps the classes when the diff puts the added color on the right", () => {
    service.emitter.emit("did-update-diff", {
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
    service.emitter.emit("did-update-diff", {
      chunks: [{ oldLineStart: 5, oldLineEnd: 5, newLineStart: 5, newLineEnd: 7 }],
      editor1,
      editor2,
    });
    expect(layer1.items).toEqual([]);
    expect(layer2.items).toEqual([{ row: 5, end: 6, cls: "removed" }]);
  });

  it("returns one raw item per two-sided chunk and leaves merging to the host", () => {
    service.emitter.emit("did-update-diff", {
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
    service.emitter.emit("did-update-diff", {
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 4 }],
      editor1,
      editor2: editor3,
    });

    const late = makeLayer(editor3);
    late.updateSync();
    expect(late.items).toEqual([{ row: 2, end: 3, cls: "removed" }]);
  });

  it("covers every screen row of a chunk whose lines wrap", () => {
    // Screen rows, not buffer rows: a marker that ended at the first screen row
    // of the chunk's last line covered a fraction of what the chunk spans.
    editor1.setText(Array(50).fill("word ".repeat(40)).join("\n"));
    editor1.setSoftWrapped(true);
    editor1.displayLayer.reset({ softWrapColumn: 20 });

    service.emitter.emit("did-update-diff", {
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
    service.emitter.emit("did-update-diff", {
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

  it("keeps the previous items when an edit has outdated the chunks", () => {
    service.emitter.emit("did-update-diff", {
      chunks: [{ oldLineStart: 40, oldLineEnd: 42, newLineStart: 40, newLineEnd: 42 }],
      editor1,
      editor2,
    });
    const before = layer1.items;
    expect(before.length).toBe(1);

    // The buffer shrinks below the chunk before the next diff lands. Rows past
    // the end clip to the last line, which would pile every marker at the
    // bottom of the map, so the layer holds what it had.
    editor1.setText("one line\n");
    layer1.updateSync();

    expect(layer1.items).toBe(before);
  });

  it("clears the previous editors when the diff view is closed", () => {
    service.emitter.emit("did-update-diff", {
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 4 }],
      editor1,
      editor2,
    });
    expect(layer1.items.length).toBe(1);
    expect(layer2.items.length).toBe(1);

    service.emitter.emit("did-update-diff", null);
    expect(layer1.items).toEqual([]);
    expect(layer2.items).toEqual([]);
  });

  it("clears the layers when the consumer is disposed", () => {
    service.emitter.emit("did-update-diff", {
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
    service.emitter.emit("did-update-diff", {
      chunks: [{ oldLineStart: 2, oldLineEnd: 4, newLineStart: 2, newLineEnd: 4 }],
      editor1,
      editor2,
    });
    expect(layer1.updateSync).not.toHaveBeenCalled();
  });
});
