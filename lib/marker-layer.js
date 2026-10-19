const { Disposable } = require("lumine");

// The `marker.layer` provider: the diff chunks on the overview maps.
//
// Fed by the package's own diff-view service — main.js connects this module to
// `provideDiffView()` at activation, so this layer sees exactly the updates an
// external consumer of the service would.
module.exports = {
  activate() {
    this.connection = null;
    this.diffService = null;
    this.lastEditor1 = null;
    this.lastEditor2 = null;
    // The hub builds exactly one layer per editor for this provider, so an
    // editor maps straight to its layer.
    this.layers = new Map();
    // The source marker layers, resolved once per editor: an overview layer that
    // attaches while a diff is already running has to draw it without waiting
    // for the next update.
    this.data = new Map();
  },

  deactivate() {
    this.connection = null;
    this.diffService = null;
    this.layers?.clear();
    this.data?.clear();
  },

  setEditorData(editor, data) {
    if (!editor) {
      return;
    }
    if (data) {
      this.data.set(editor, data);
    } else {
      this.data.delete(editor);
    }
    // Sync rather than throttled: the handover when the diff swaps editors has
    // to land in one frame or the old markers flicker through.
    const layer = this.layers.get(editor);
    if (layer) {
      layer.updateSync();
    }
  },

  connect(diffService) {
    const connection = {};
    this.connection = connection;
    this.diffService = diffService;
    const update = (data) => {
      if (this.connection !== connection) return;
      const { editor1, editor2, markerLayers } = data || {};
      if (this.lastEditor1 && this.lastEditor1 !== editor1) {
        this.setEditorData(this.lastEditor1, null);
      }
      if (this.connection !== connection) return;
      if (this.lastEditor2 && this.lastEditor2 !== editor2) {
        this.setEditorData(this.lastEditor2, null);
      }
      if (this.connection !== connection) return;
      this.lastEditor1 = editor1;
      this.lastEditor2 = editor2;
      // The added color follows the diff-view addedColorSide setting; the
      // removed color lands on the opposite editor.
      const addedSide = data?.addedColorSide === "right" ? "right" : "left";
      const firstLayer = markerLayers?.editor1?.lineMarkerLayer;
      const secondLayer = markerLayers?.editor2?.lineMarkerLayer;
      this.setEditorData(
        editor1,
        firstLayer
          ? {
              cls: addedSide === "left" ? "added" : "removed",
              markerLayer: firstLayer,
            }
          : null,
      );
      if (this.connection !== connection) return;
      this.setEditorData(
        editor2,
        secondLayer
          ? {
              cls: addedSide === "left" ? "removed" : "added",
              markerLayer: secondLayer,
            }
          : null,
      );
    };
    const subscription = diffService.onDidUpdate(update);
    update(diffService.getDiffView());
    return new Disposable(() => {
      subscription.dispose();
      if (this.connection !== connection) return;
      this.connection = null;
      this.diffService = null;
      const editors = new Set([this.lastEditor1, this.lastEditor2].filter(Boolean));
      this.lastEditor1 = null;
      this.lastEditor2 = null;
      for (const editor of editors) this.data.delete(editor);
      for (const editor of editors) this.layers.get(editor)?.updateSync();
    });
  },

  provideMarkerLayer() {
    return {
      name: "diff-view",
      description: "Diff-view chunk markers",
      merge: true,
      enabled: "diff-view.marker.enabled",
      threshold: "diff-view.marker.threshold",
      initialize: (layer) => {
        this.layers.set(layer.editor, layer);
        layer.disposables.add(
          new Disposable(() => {
            this.layers.delete(layer.editor);
          }),
        );
      },
      getItems: ({ editor }) => {
        const data = this.data.get(editor);
        if (!data) {
          return [];
        }
        const { cls, markerLayer } = data;
        if (markerLayer.isDestroyed()) return [];
        const lastBufferRow = editor.getLastBufferRow();
        const items = [];
        // Line decorations own the ranges that follow edits. Project those
        // anchors while the next comparison waits for idle.
        for (const marker of markerLayer.getMarkers()) {
          const range = marker.getBufferRange();
          const end = range.end.column > 0 || range.isEmpty() ? range.end.row + 1 : range.end.row;
          items.push({
            row: editor.screenRowForBufferRow(range.start.row),
            end:
              end > lastBufferRow
                ? editor.getLastScreenRow()
                : editor.screenRowForBufferRow(end) - 1,
            cls,
          });
        }
        return items;
      },
    };
  },
};
