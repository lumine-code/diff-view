# diff-view

Reports the current diff: its chunks, the two editors being compared, and which side is coloured as added.

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
  getMarkerLayers(): DisplayMarkerLayer[];
  diffEditors(): TextEditor[];
  disable(): void;
  onDidUpdate(callback: () => void): Disposable;
};

type DiffState = {
  chunks: Chunk[];
  editor1: TextEditor | undefined;
  editor2: TextEditor | undefined;
  addedColorSide: "left" | "right";
};
```

| Member              | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `getDiffView()`     | The current diff, or **`null` when no comparison is running**. |
| `getMarkerLayers()` | The marker layers holding the diff decorations.                |
| `diffEditors()`     | The editors taking part in the comparison.                     |
| `disable()`         | Turns the comparison off.                                      |
| `onDidUpdate(cb)`   | Fires when the diff is recomputed.                             |

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

  chunksFor(editor) {
    const state = this.diffView?.getDiffView();
    if (!state) return [];
    if (editor !== state.editor1 && editor !== state.editor2) return [];
    return state.chunks;
  },
};
```

## Behavior

`getDiffView()` returning `null` is the normal resting state — most of the time no comparison is running. Check it on every read rather than caching the state object.

`editor1` and `editor2` may each be `undefined` even when a diff exists, since the extenders are resolved independently. Guard both.

**`addedColorSide` matters if you draw colours.** It says which side is being treated as the additions, and it flips when the user swaps the comparison; drawing added/removed without reading it produces a diff whose colours are inverted half the time.

Chunks describe rows in the two editors' buffers. Re-read them after every `onDidUpdate` rather than holding them across edits.

`onDidUpdate` fires on recomputation, which includes the comparison being torn down — so a callback should handle `getDiffView()` answering `null`.

## Teardown

Return a `Disposable` that unsubscribes and clears what you drew. The marker layers belong to `diff-view`; do not destroy them, and do not call `disable()` as part of your own teardown — that turns off a feature the user asked for.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
