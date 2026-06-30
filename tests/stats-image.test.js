const test = require("node:test");
const assert = require("node:assert/strict");

// We test the bento tile drawers with a stub canvas context that records
// draw ops. This isolates the layout logic without depending on
// @napi-rs/canvas output.
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

test("selectLeader returns null for empty input", () => {
  assert.equal(stats.__selectLeader([]), null);
  assert.equal(stats.__selectLeader(null), null);
  assert.equal(stats.__selectLeader(undefined), null);
});

// Helper for the leader tests below — selectLeader now compares the top
// row's memberNames length, not section-wide totals.
function sec(key, topRowMembers) {
  return { key, rows: [{ memberNames: Array(topRowMembers).fill("x") }] };
}

test("selectLeader returns the single section when only one", () => {
  const only = sec("playing", 2);
  assert.equal(stats.__selectLeader([only]), only);
});

test("selectLeader picks the section whose top row has the most members", () => {
  const a = sec("playing",   3);
  const b = sec("voice",     8);
  const c = sec("listening", 1);
  assert.equal(stats.__selectLeader([a, b, c]), b);
});

test("selectLeader ties break to the earliest section in input order", () => {
  const a = sec("playing", 4);
  const b = sec("voice",   4);
  assert.equal(stats.__selectLeader([a, b]), a);
});

test("selectLeader handles sections with no rows (treats as 0 members)", () => {
  const a = { key: "playing", rows: [] };
  const b = sec("voice", 1);
  assert.equal(stats.__selectLeader([a, b]), b);
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

test("drawMemberPodiumTile draws rank label, name, game line, and time", () => {
  const { ctx, calls } = makeStubCtx();
  // Use 800×232 (≈400×116 logical at SCALE=2) so the text stack has room to
  // render without truncation under the stub's measureText heuristic.
  stats.__drawMemberPodiumTile(ctx, 0, 0, 800, 232, {
    displayName: "Cody",
    voiceMinutes: 39 * 60,
    topGame: { key: "Spotify", minutes: 15 * 60 },
  }, fakeImage2, 2);
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.some((t) => t.includes("2ND")));
  assert.ok(texts.includes("Cody"));
  assert.ok(texts.some((t) => t.includes("Spotify")));
  // 39h = 2340 minutes → days=1, hours=15 → "1d 15h"
  assert.ok(texts.some((t) => t.includes("1d")), `expected "1d" in time output, got ${JSON.stringify(texts)}`);
});

test("drawLeaderboardRow draws rank, name, time and a relative bar", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawLeaderboardRow(ctx, 0, 0, 1200, 64, {
    displayName: "Sarah",
    voiceMinutes: 14 * 60,
    topGame: { key: "Minecraft", minutes: 9 * 60 },
    avatar: fakeImage2,
  }, 4, 28 * 60);
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.some((t) => t.includes("04")));
  assert.ok(texts.some((t) => t.includes("Sarah")));
  assert.ok(texts.some((t) => t.includes("14h")));
  // Bar uses roundRect + fill twice (ghost track + filled portion since 14h/28h > 0).
  const fills = calls.filter((c) => c[0] === "fill");
  assert.ok(fills.length >= 2, `expected ≥2 fill calls for bar, got ${fills.length}`);
});

test("drawOverflowPanel draws header and one row per overflow entry", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawOverflowPanel(ctx, 0, 0, 1800, [
    {
      section: { key: "playing", emoji: "🎮", title: "Playing" },
      row: { display: "Valorant", timeStr: "8m", memberNames: ["alex"] },
    },
    {
      section: { key: "voice", emoji: "🎤", title: "Voice" },
      row: { display: "AFK Channel", timeStr: "8m", memberNames: ["tom"] },
    },
    {
      section: { key: "listening", emoji: "🎵", title: "Listening" },
      row: { display: "YouTube Music", timeStr: "12m", memberNames: ["sarah"] },
    },
  ]);
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.includes("ALSO HAPPENING"), `expected header, got ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes("Valorant")));
  assert.ok(texts.some((t) => t.includes("AFK")));
  assert.ok(texts.some((t) => t.includes("YouTube")));
  // Voice row uses green time color.
  const fills = calls.filter((c) => c[0] === "fillStyle").map((c) => c[1]);
  assert.ok(fills.includes("#b8e3a1"), "voice row uses green time");
});

test("drawOverflowPanel renders nothing for empty overflow", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawOverflowPanel(ctx, 0, 0, 1800, []);
  assert.equal(calls.length, 0, "no draw calls for empty overflow");
});
