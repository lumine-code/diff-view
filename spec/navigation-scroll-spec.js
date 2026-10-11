const DiffDisplay = require("../lib/diff-display");

describe("diff navigation scrolling", () => {
  let display, left, right;

  beforeEach(() => {
    const editor = () => ({
      setCursorBufferPosition: jasmine.createSpy("place cursor"),
      scrollToBufferPosition: jasmine.createSpy("reveal difference"),
    });
    const extender = (value) => ({
      getEditor: () => value,
      deselectAllLines() {},
      selectLines() {},
    });
    left = editor();
    right = editor();
    display = Object.create(DiffDisplay.prototype);
    display._editorDiffExtender1 = extender(left);
    display._editorDiffExtender2 = extender(right);
    display._chunks = [{ oldLineStart: 3, oldLineEnd: 4, newLineStart: 8, newLineEnd: 9 }];
  });

  it("reveals both navigation destinations through the shared zone", () => {
    display._selectChunk(0, true, false);
    expect(left.setCursorBufferPosition).toHaveBeenCalledOnceWith([3, 0], { autoscroll: false });
    expect(left.scrollToBufferPosition).toHaveBeenCalledOnceWith([3, 0], { mode: "zone" });
    expect(right.scrollToBufferPosition).toHaveBeenCalledOnceWith([8, 0], { mode: "zone" });
  });

  it("lets pixel synchronization reveal the follower without a second request", () => {
    display._selectChunk(0, true, true);
    expect(left.scrollToBufferPosition).toHaveBeenCalledOnceWith([3, 0], { mode: "zone" });
    expect(right.scrollToBufferPosition).not.toHaveBeenCalled();
  });

  it("keeps the viewport still when a visible chunk is selected by pointer", () => {
    display._selectChunk(0, false, false);
    expect(left.scrollToBufferPosition).not.toHaveBeenCalled();
    expect(right.scrollToBufferPosition).not.toHaveBeenCalled();
  });
});
