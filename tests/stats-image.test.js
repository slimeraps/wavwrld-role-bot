const test = require("node:test");
const assert = require("node:assert/strict");

// We test drawProgressRow with a stub canvas context that records draw ops.
// This isolates the layout logic without depending on @napi-rs/canvas output.
const stats = require("../src/stats-image");

function makeStubCtx() {
  const calls = [];
  const ctx = {
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    beginPath: () => calls.push(["beginPath"]),
    closePath: () => calls.push(["closePath"]),
    clip: () => calls.push(["clip"]),
    fill: () => calls.push(["fill"]),
    stroke: () => calls.push(["stroke"]),
    rect: (...a) => calls.push(["rect", ...a]),
    arc: (...a) => calls.push(["arc", ...a]),
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    fillRect: (...a) => calls.push(["fillRect", ...a]),
    drawImage: (...a) => calls.push(["drawImage", ...a]),
    fillText: (...a) => calls.push(["fillText", ...a]),
    measureText: (s) => ({ width: String(s).length * 7 }),
    set fillStyle(v) { calls.push(["fillStyle", v]); },
    get fillStyle() { return null; },
    set strokeStyle(v) { calls.push(["strokeStyle", v]); },
    get strokeStyle() { return null; },
    set lineWidth(v) { calls.push(["lineWidth", v]); },
    get lineWidth() { return null; },
    set font(v) { calls.push(["font", v]); },
    get font() { return null; },
    set textAlign(v) { calls.push(["textAlign", v]); },
    get textAlign() { return null; },
    set textBaseline(v) { calls.push(["textBaseline", v]); },
    get textBaseline() { return null; },
  };
  return { ctx, calls };
}

const fakeImage = { _fake: true };

test("drawProgressRow draws no avatar circles when avatars is empty", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawProgressRow(ctx, 0, 0, 800, 36, {
    rank: 4, avatars: [], extraCount: 0,
    name: "Helmsy", gameLabel: null, hoursLabel: "1h",
  });
  // A single placeholder arc is drawn when no avatars are provided.
  const arcs = calls.filter((c) => c[0] === "arc");
  assert.equal(arcs.length, 1, "placeholder circle drawn when no avatars");
  const drawImages = calls.filter((c) => c[0] === "drawImage");
  assert.equal(drawImages.length, 0);
});

test("drawProgressRow draws one avatar when avatars has one entry", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawProgressRow(ctx, 0, 0, 800, 36, {
    rank: 4, avatars: [fakeImage], extraCount: 0,
    name: "Helmsy", gameLabel: null, hoursLabel: "1h",
  });
  const drawImages = calls.filter((c) => c[0] === "drawImage");
  assert.equal(drawImages.length, 1);
});

test("drawProgressRow draws three overlapping avatars", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawProgressRow(ctx, 0, 0, 800, 36, {
    rank: "", avatars: [fakeImage, fakeImage, fakeImage], extraCount: 0,
    name: "Assetto", gameLabel: "A, B, C", hoursLabel: "289h",
  });
  const drawImages = calls.filter((c) => c[0] === "drawImage");
  assert.equal(drawImages.length, 3);
});

test("drawProgressRow draws +N chip when extraCount > 0", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawProgressRow(ctx, 0, 0, 800, 36, {
    rank: "", avatars: [fakeImage, fakeImage, fakeImage], extraCount: 2,
    name: "WAVLINK", gameLabel: "a, b, c +2", hoursLabel: "3h",
  });
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.includes("+2"), `expected "+2" chip in fillText calls, got ${JSON.stringify(texts)}`);
});
