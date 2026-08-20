const { Disposable } = require("lumine");

// The `marker.layer` provider: the diff chunks on the overview maps.
//
// Fed by the package's own diff-view service — main.js connects this module to
// `provideDiffView()` at activation, so this layer sees exactly the updates an
// external consumer of the service would.
module.exports = {
  activate() {
    this.diffService = null;
    this.lastEditor1 = null;
    this.lastEditor2 = null;
    // The hub builds exactly one layer per editor for this provider, so an
    // editor maps straight to its layer.
    this.layers = new Map();
    // The chunks behind those layers, resolved once per editor: a layer that
    // attaches while a diff is already running has to draw it without waiting
    // for the next update.
    this.data = new Map();
  },

  deactivate() {
    this.diffService = null;
    this.layers.clear();
    this.data.clear();
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
    this.diffService = diffService;
    let subscription = diffService.onDidUpdate?.((data) => {
      const { chunks, editor1, editor2 } = data || {};
      if (this.lastEditor1 && this.lastEditor1 !== editor1) {
        this.setEditorData(this.lastEditor1, null);
      }
      if (this.lastEditor2 && this.lastEditor2 !== editor2) {
        this.setEditorData(this.lastEditor2, null);
      }
      this.lastEditor1 = editor1;
      this.lastEditor2 = editor2;
      // The added color follows the diff-view addedColorSide setting; the
      // removed color lands on the opposite editor.
      const addedSide = data?.addedColorSide === "right" ? "right" : "left";
      this.setEditorData(
        editor1,
        chunks
          ? {
              chunks,
              startKey: "oldLineStart",
              endKey: "oldLineEnd",
              cls: addedSide === "left" ? "added" : "removed",
            }
          : null,
      );
      this.setEditorData(
        editor2,
        chunks
          ? {
              chunks,
              startKey: "newLineStart",
              endKey: "newLineEnd",
              cls: addedSide === "left" ? "removed" : "added",
            }
          : null,
      );
    });
    return new Disposable(() => {
      this.setEditorData(this.lastEditor1, null);
      this.setEditorData(this.lastEditor2, null);
      this.lastEditor1 = null;
      this.lastEditor2 = null;
      this.diffService = null;
      subscription?.dispose();
    });
  },

  provideMarkerLayer() {
    return {
      name: "diff-view",
      description: "Diff-view chunk markers",
      timer: 100,
      merge: true,
      enabled: "diff-view.marker.enabled",
      threshold: "diff-view.marker.threshold",
      initialize: (layer) => {
        this.layers.set(layer.editor, layer);
        layer.disposables.add(
          new Disposable(() => {
            this.layers.delete(layer.editor);
            this.data.delete(layer.editor);
          }),
        );
      },
      getItems: ({ editor }) => {
        const data = this.data.get(editor);
        if (!data) {
          return [];
        }
        const { chunks, startKey, endKey, cls } = data;
        const lastBufferRow = editor.getLastBufferRow();
        const items = [];
        for (const chunk of chunks) {
          const start = chunk[startKey];
          const end = chunk[endKey];
          // A one-sided chunk covers no lines on this editor: a pure
          // insertion has no rows in the old file and vice versa.
          if (start === end) {
            continue;
          }
          // The chunks describe the buffer as it was when the diff ran, and an
          // edit can shrink it below them before the next diff lands. A row
          // past the end clips to the last line, which would pile the markers
          // at the bottom of the map — returning null keeps the previous items
          // instead, until the diff on its way replaces them.
          if (end > lastBufferRow + 1) {
            return null;
          }
          // The last screen row of the chunk's last line, so a wrapped chunk's
          // marker covers the chunk rather than stopping at the first of its
          // wrapped rows. Asking for the next line's first row would clip at
          // the end of the buffer, hence the branch.
          const endScreenRow =
            end > lastBufferRow ? editor.getLastScreenRow() : editor.screenRowForBufferRow(end) - 1;
          items.push({
            row: editor.screenRowForBufferRow(start),
            end: endScreenRow,
            cls,
          });
        }
        return items;
      },
    };
  },
};
