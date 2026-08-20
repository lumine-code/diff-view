const DiffView = require("../lib/diff-display");

describe("view zone alignment", () => {
  let editor1, editor2, diffView;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    editor1 = await lumine.workspace.open();
    lumine.workspace.getActivePane().splitRight();
    editor2 = await lumine.workspace.open();
  });

  afterEach(() => {
    if (diffView) {
      diffView.destroy();
      diffView = null;
    }
  });

  function totalZoneHeight(extender) {
    return extender.getViewZones().reduce((sum, zone) => sum + zone.pixelHeight, 0);
  }

  // The invariant every spacer exists for: screen rows plus spacers add up to
  // the same height on both sides, whatever each side's wrapping does.
  function expectHeightsBalanced() {
    const lineHeight = editor1.getLineHeightInPixels();
    const side1 =
      editor1.getScreenLineCount() * lineHeight + totalZoneHeight(diffView._editorDiffExtender1);
    const side2 =
      editor2.getScreenLineCount() * lineHeight + totalZoneHeight(diffView._editorDiffExtender2);
    expect(side1).toBe(side2);
  }

  it("sums a line owed height by the wrap walk and by a chunk at once", () => {
    // Every left line wraps to two rows; the right side wraps to one — so the
    // per-line walk owes the right side one row per line. Lines 3-4 are also
    // deleted on the right, so the delete chunk owes the gap after line 2 too.
    // Both land on line 2, and dropping either walks the sides apart by
    // exactly that height on every unequal-width resize.
    const wide = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(30)}`);
    editor1.setText(wide.join("\n"));
    editor1.setSoftWrapped(true);
    editor1.displayLayer.reset({ softWrapColumn: 20 });
    const narrow = wide.slice();
    narrow.splice(3, 2);
    editor2.setText(narrow.join("\n"));

    diffView = new DiffView({ editor1, editor2 });
    diffView._chunks = [{ oldLineStart: 3, oldLineEnd: 5, newLineStart: 3, newLineEnd: 3 }];
    diffView._syncViewZoneHeights();

    const lineHeight = editor1.getLineHeightInPixels();
    const rowsPerLeftLine = editor1.screenRowForBufferRow(1) - editor1.screenRowForBufferRow(0);
    expect(rowsPerLeftLine).toBeGreaterThan(1);

    // Line 2's zone carries both debts: its own wrap difference plus the
    // deleted chunk's rows.
    const zone = diffView._editorDiffExtender2.getViewZones().find((z) => z.lineNumber === 2);
    const wrapDebt = (rowsPerLeftLine - 1) * lineHeight;
    const chunkDebt = 2 * rowsPerLeftLine * lineHeight;
    expect(zone.pixelHeight).toBe(wrapDebt + chunkDebt);

    expectHeightsBalanced();
  });

  it("balances the two sides when only the chunk differs", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    editor1.setText(lines.join("\n"));
    const shorter = lines.slice();
    shorter.splice(5, 3);
    editor2.setText(shorter.join("\n"));

    diffView = new DiffView({ editor1, editor2 });
    diffView._chunks = [{ oldLineStart: 5, oldLineEnd: 8, newLineStart: 5, newLineEnd: 5 }];
    diffView._syncViewZoneHeights();

    expectHeightsBalanced();
  });

  it("rebalances after the wrapping changes, reusing the standing zones", () => {
    const wide = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(30)}`);
    editor1.setText(wide.join("\n"));
    const narrow = wide.slice();
    narrow.splice(3, 2);
    editor2.setText(narrow.join("\n"));

    diffView = new DiffView({ editor1, editor2 });
    diffView._chunks = [{ oldLineStart: 3, oldLineEnd: 5, newLineStart: 3, newLineEnd: 3 }];
    diffView._syncViewZoneHeights();
    expectHeightsBalanced();
    const zoneBefore = diffView._editorDiffExtender2.getViewZones().find((z) => z.lineNumber === 2);

    // What a pane resize does: the wrap column moves, every height changes.
    editor1.setSoftWrapped(true);
    editor1.displayLayer.reset({ softWrapColumn: 20 });
    diffView._syncViewZoneHeights();

    expectHeightsBalanced();
    // Resized in place, not recreated — recreating dropped the content height
    // for a frame and let each editor re-anchor onto a different row.
    const zoneAfter = diffView._editorDiffExtender2.getViewZones().find((z) => z.lineNumber === 2);
    expect(zoneAfter).toBe(zoneBefore);
  });
});
