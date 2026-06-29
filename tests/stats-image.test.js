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

test("selectLeader returns null for empty input", () => {
  assert.equal(stats.__selectLeader([]), null);
  assert.equal(stats.__selectLeader(null), null);
  assert.equal(stats.__selectLeader(undefined), null);
});

test("selectLeader returns the single section when only one", () => {
  const only = { key: "playing", memberCount: 2 };
  assert.equal(stats.__selectLeader([only]), only);
});

test("selectLeader picks the section with the highest memberCount", () => {
  const a = { key: "playing",   memberCount: 3 };
  const b = { key: "voice",     memberCount: 8 };
  const c = { key: "listening", memberCount: 1 };
  assert.equal(stats.__selectLeader([a, b, c]), b);
});

test("selectLeader ties break to the earliest section in input order", () => {
  const a = { key: "playing", memberCount: 4 };
  const b = { key: "voice",   memberCount: 4 };
  assert.equal(stats.__selectLeader([a, b]), a);
});

test("computeBentoGrid with 0 small tiles → hero fills the rect", () => {
  const grid = stats.__computeBentoGrid(600, 240, 10, 0);
  assert.deepEqual(grid.heroRect, { x: 0, y: 0, w: 600, h: 240 });
  assert.deepEqual(grid.smallRects, []);
});

test("computeBentoGrid with 1 small tile → hero + 1 full-height column", () => {
  const grid = stats.__computeBentoGrid(610, 240, 10, 1);
  // hero takes 1.5fr of available split, small takes 1fr.
  // available = 610 - 10 = 600; hero = 600 * 1.5/2.5 = 360; small = 240.
  assert.deepEqual(grid.heroRect, { x: 0, y: 0, w: 360, h: 240 });
  assert.equal(grid.smallRects.length, 1);
  assert.deepEqual(grid.smallRects[0], { x: 370, y: 0, w: 240, h: 240 });
});

test("computeBentoGrid with 2 small tiles → vertical stack on right", () => {
  const grid = stats.__computeBentoGrid(610, 250, 10, 2);
  assert.equal(grid.heroRect.w, 360);
  assert.equal(grid.heroRect.h, 250);
  assert.equal(grid.smallRects.length, 2);
  // 2 tiles stacked in a 250-tall column with 10px gap → each 120 tall.
  assert.equal(grid.smallRects[0].h, 120);
  assert.equal(grid.smallRects[1].h, 120);
  assert.equal(grid.smallRects[1].y, 130);
});

test("computeBentoGrid with 3 small tiles → 3-deep stack on right", () => {
  const grid = stats.__computeBentoGrid(610, 250, 10, 3);
  assert.equal(grid.smallRects.length, 3);
  // (250 - 20) / 3 = 76.66 → 76.
  assert.equal(grid.smallRects[0].h, 76);
});

test("computeBentoGrid with 4 small tiles → 2x2 grid on right", () => {
  const grid = stats.__computeBentoGrid(610, 250, 10, 4);
  assert.equal(grid.smallRects.length, 4);
  // 4 tiles in a 2x2: each 120 tall, ~115 wide (240/2 - 5).
  const sums = grid.smallRects.map((r) => `${r.x},${r.y}`);
  // Tiles are placed row-major: 0=TL, 1=TR, 2=BL, 3=BR.
  assert.equal(sums[0], "370,0");
  assert.equal(sums[1], "495,0"); // 370 + 115 + 10
  assert.equal(sums[2], "370,130");
  assert.equal(sums[3], "495,130");
});

const fakeImage2 = { _fake: true };

test("drawHeroTile draws name, time, and avatar cluster", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawHeroTile(ctx, 0, 0, 600, 400, {
    section: { key: "playing", emoji: "🎮", memberCount: 6 },
    row: {
      display: "Counter-Strike 2",
      timeStr: "24m",
      avatars: [fakeImage2, fakeImage2, fakeImage2],
      extraCount: 3,
    },
    barScale: 60,
  });
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.includes("Counter-Strike 2"), `expected name in fillText, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("24m"), `expected time in fillText, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("+3"), `expected +N chip in fillText, got ${JSON.stringify(texts)}`);
  const drawImages = calls.filter((c) => c[0] === "drawImage");
  assert.equal(drawImages.length, 3, "three avatars drawn");
});

test("drawHeroTile uses voice tile background when section is voice", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawHeroTile(ctx, 0, 0, 600, 400, {
    section: { key: "voice", emoji: "🎤", memberCount: 8 },
    row: { display: "General VC", timeStr: "2h", avatars: [], extraCount: 0 },
    barScale: 120,
  });
  const fills = calls.filter((c) => c[0] === "fillStyle").map((c) => c[1]);
  assert.ok(fills.includes("rgba(28,60,40,0.62)"), "voice tile bg used");
});

test("drawSmallTile draws name, members, and time", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawSmallTile(ctx, 0, 0, 240, 120, {
    section: { key: "listening", title: "Listening", emoji: "🎵", memberCount: 2 },
    row: { display: "Spotify", timeStr: "47m", memberNames: ["Helms", "Cody"], minutes: 47 },
    barScale: 134,
  });
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.includes("Spotify"));
  assert.ok(texts.includes("47m"));
  assert.ok(texts.some((t) => t.includes("Helms")));
});

test("drawSmallTile uses voice tile background and green time for voice", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawSmallTile(ctx, 0, 0, 240, 120, {
    section: { key: "voice", title: "Voice", emoji: "🎤", memberCount: 8 },
    row: { display: "General", timeStr: "2h", memberNames: [], minutes: 120 },
    barScale: 120,
  });
  const fills = calls.filter((c) => c[0] === "fillStyle").map((c) => c[1]);
  assert.ok(fills.includes("rgba(28,60,40,0.62)"), "voice tile bg");
  assert.ok(fills.includes("#b8e3a1"), "green time color");
});

test("drawMemberHeroTile draws rank, name, game line, and big voice time", () => {
  const { ctx, calls } = makeStubCtx();
  // 47 * 60 = 2820 min = 1d 23h per fmtTime; check for the hours portion "23h".
  stats.__drawMemberHeroTile(ctx, 0, 0, 400, 232, {
    displayName: "Helms",
    voiceMinutes: 47 * 60,
    topGame: { key: "Counter-Strike 2", minutes: 38 * 60 },
  }, fakeImage2);
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.some((t) => t.includes("1ST")), `expected rank text, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("Helms"));
  assert.ok(texts.some((t) => t.includes("Counter-Strike 2")));
  assert.ok(texts.some((t) => t.includes("1d")), `expected day-formatted voice time, got ${JSON.stringify(texts)}`);
});
