# diff-view

Reports the current comparison and its live marker layers.

|             |                                                         |
| ----------- | ------------------------------------------------------- |
| Version     | `1.0.0`                                                 |
| Provided by | `provideDiffView()` returning the query facade          |
| Consumed by | `consumeDiffView(service)`                              |
| Owner       | [`diff-view`](https://github.com/lumine-code/diff-view) |

For a package that wants to render the diff somewhere else — a scrollbar overview is the existing consumer — or to switch the comparison off while something else takes over the editors.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "diff-view": {
      "versions": { "^1.0.0": "consumeDiffView" }
    }
  }
}
```

## Contract

```ts
type DiffViewService = {
  getDiffView(): DiffState | null;
  diffEditors(
    editor1: TextEditor,
    editor2: TextEditor,
    options?: DiffOptions,
  ): Promise<{ editor1: TextEditor; editor2: TextEditor } | null>;
  disable(): void;
  onDidUpdate(callback: (state: DiffState | null) => void): Disposable;
};

type DiffMarkerLayers = {
  editor1?: EditorMarkerLayers;
  editor2?: EditorMarkerLayers;
};

type EditorMarkerLayers = {
  id: number;
  lineMarkerLayer: DisplayMarkerLayer;
  selectionMarkerLayer: DisplayMarkerLayer;
  highlightType: "added" | "removed";
};

type DiffOptions = {
  autoDiff?: boolean;
  diffWords?: boolean;
  ignoreWhitespace?: boolean;
  computeTimeout?: number;
  turnOffSoftWrap?: boolean;
  muteNotifications?: boolean;
  hideDocks?: boolean;
  scrollSyncType?: "Vertical + Horizontal" | "Vertical" | "None";
  addedColorSide?: "left" | "right";
};

type DiffState = {
  chunks: Chunk[];
  editor1: TextEditor | undefined;
  editor2: TextEditor | undefined;
  addedColorSide: "left" | "right";
  markerLayers: DiffMarkerLayers;
};
```

| Member              | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `getDiffView()`     | The current diff, or **`null` when no comparison is running**.  |
| `diffEditors(a, b)` | Starts a comparison of the two editors and resolves when ready. |
| `disable()`         | Turns comparison off and closes editors it created.             |
| `onDidUpdate(cb)`   | Fires when the diff is recomputed.                              |

## Minimal example

```js
const { CompositeDisposable, Disposable } = require("lumine");

module.exports = {
  consumeDiffView(service) {
    this.diffView = service;
    const disposables = new CompositeDisposable();
    disposables.add(
      service.onDidUpdate(() => this.redraw()),
      new Disposable(() => {
        this.diffView = null;
        this.redraw();
      }),
    );
    return disposables;
  },

  rangesFor(editor) {
    const state = this.diffView?.getDiffView();
    if (!state) return [];
    const side =
      editor === state.editor1
        ? state.markerLayers.editor1
        : editor === state.editor2
          ? state.markerLayers.editor2
          : null;
    return side?.lineMarkerLayer.getMarkers().map((marker) => marker.getBufferRange()) ?? [];
  },
};
```

## Behavior

`getDiffView()` returning `null` is the normal resting state — most of the time no comparison is running. Check it on every read rather than caching the state object.

`editor1` and `editor2` may each be `undefined` even when a diff exists, since the extenders are resolved independently. Guard both.

**`addedColorSide` matters if you draw colours.** It says which side is being treated as the additions, and it flips when the user swaps the comparison; drawing added/removed without reading it produces a diff whose colours are inverted half the time.

Chunks describe rows in the two editors' buffers. Re-read them after every `onDidUpdate` rather than holding them across edits.

`getDiffView().markerLayers` synchronously returns the current owned marker layers. Its line markers track buffer edits immediately, while chunk coordinates describe the last completed comparison. Consumers project the live line marker ranges during continuous editing without requesting a new comparison. A line range ending at column zero excludes its final buffer row. Re-read the snapshot after `onDidUpdate`, and stop using its layers when the comparison or service disappears.

`diffEditors()` accepts existing editors and optional overrides for the listed settings. It resolves to the compared editors, or `null` when opening is cancelled or fails. Read `getDiffView().markerLayers` after it resolves to inspect the ready comparison. The marker-layer snapshot is keyed by `editor1` and `editor2`.

`onDidUpdate` fires on recomputation, which includes the comparison being torn down — so a callback should handle `getDiffView()` answering `null`.

**An update can also carry no chunks for a comparison that is still running.** The diff is computed in the window under the Compute Timeout budget, and a pair that differs almost everywhere can exhaust it; the update then reports empty chunks and marker layers so consumers clear what they drew.

## Teardown

Return a `Disposable` that unsubscribes and clears what you drew. The marker layers belong to `diff-view`; do not destroy them, and do not call `disable()` as part of your own teardown — that turns off a feature the user asked for.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
