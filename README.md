# diff-view

A split pane diff tool.

Compare files side-by-side with synchronized scrolling, soft-wrap support, git integration, and context menus.

## Features

- **Side-by-side diff**: highlights added, removed, and changed lines in two editors.
- **Word diff**: highlights the changed words within each modified line.
- **Git integration**: diff the active file against its git HEAD or a previous commit.
- **Soft-wrap support**: diff works correctly with soft wrap enabled, including proper line offsets and scroll synchronization.
- **Buffer-based scroll sync**: uses buffer line positions for proper alignment across different soft-wrap settings.
- **Quick toggle buttons**: footer buttons for soft-wrap toggle and equalizing pane widths.
- **Context menus**: right-click on tree-view files or tabs to "Diff with Active File".
- **Scrollbar markers**: shows the diff chunks on the scrollbar and minimap via the marker hub.

## Installation

To install `diff-view` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/diff-view`.

## Commands

Commands available in `lumine-workspace`:

- `diff-view:enable`: start a diff between two panes,
- `diff-view:toggle`: toggle diff on/off,
- `diff-view:disable`: stop the current diff,
- `diff-view:close`: stop diff and close the extra pane,
- `diff-view:next-diff`: jump to next difference,
- `diff-view:prev-diff`: jump to previous difference,
- `diff-view:copy-to-right`: copy current diff chunk to right editor,
- `diff-view:copy-to-left`: copy current diff chunk to left editor,
- `diff-view:git-head`: diff active file with git HEAD,
- `diff-view:git-commit`: diff active file with previous commit,
- `diff-view:toggle-soft-wrap`: toggle soft wrap during diff,
- `diff-view:equalize-widths`: equalize pane widths,
- `diff-view:toggle-center-line`: toggle center line indicator,
- `diff-view:set-ignore-whitespace`: toggle ignore whitespace,
- `diff-view:set-auto-diff`: toggle auto diff.

## Customization

The diff highlights can be tweaked from your stylesheet, e.g. in `styles.css`:

```css
lumine-text-editor .line.diff-view-line.diff-view-added {
  background-color: color-mix(in srgb, var(--syntax-color-added) 35%, transparent);
}
```

## Services

- [`diff-view`](docs/diff-view.md): provided to let other packages programmatically start, control, and inspect diffs — exposes `diffEditors(editor1, editor2, options)`, `getMarkerLayers()`, and `disable()`.
- [`diff-view`](docs/diff-view.md): provided to scrollbar-marker consumers — exposes `getDiffView()` with the current diff chunks and editors, plus an `onDidUpdate(callback)` subscription.
- `marker.layer`: provided to draw the diff chunks on the editor's overview maps (scrollbar, minimap).

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
