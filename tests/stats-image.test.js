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

// measureText's width here depends on the currently-set font (size + bold),
// same as a real canvas — unlike the shared stub above (flat 7px/char,
// tuned so other tests' hardcoded tile widths don't truncate). This is what
// lets drawLeaderboardRow's font-swap-before-measuring overlap bug (fixed in
// 10.13.0) actually show up under test.
function fontWidth(text, font) {
  const px = Number((/([\d.]+)px/.exec(font) || [, 13])[1]);
  const bold = /bold/i.test(font);
  return String(text).length * px * (bold ? 0.62 : 0.52);
}

function makeFontAwareStubCtx() {
  const { ctx, calls } = makeStubCtx();
  let currentFont = "13px UI";
  const fontDescriptor = Object.getOwnPropertyDescriptor(ctx, "font");
  Object.defineProperty(ctx, "font", {
    set(v) { currentFont = v; fontDescriptor.set.call(ctx, v); },
    get() { return currentFont; },
  });
  ctx.measureText = (s) => ({ width: fontWidth(s, currentFont) });
  return { ctx, calls };
}

const fakeImage2 = { _fake: true };

test("computeEvenGrid splits width into `count` equal tiles with gaps between", () => {
  const rects = stats.__computeEvenGrid(920, 168, 10, 5);
  assert.equal(rects.length, 5);
  // (920 - 4*10) / 5 = 176 each.
  assert.ok(rects.every((r) => r.w === 176 && r.h === 168 && r.y === 0));
  assert.equal(rects[0].x, 0);
  assert.equal(rects[1].x, 186); // 176 + 10
  assert.equal(rects[4].x, 744); // 4 * 186
});

test("computeEvenGrid returns [] for a zero count", () => {
  assert.deepEqual(stats.__computeEvenGrid(920, 168, 10, 0), []);
});

test("computeEvenGrid handles a single tile (spans the full width)", () => {
  const rects = stats.__computeEvenGrid(920, 168, 10, 1);
  assert.deepEqual(rects, [{ x: 0, y: 0, w: 920, h: 168 }]);
});

test("drawActivityTile draws label, title, time, and an avatar cluster", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawActivityTile(ctx, 0, 0, 176, 168, {
    variant: "game",
    label: "PLAYING",
    title: "Counter-Strike 2",
    avatars: [fakeImage2, fakeImage2, fakeImage2],
    extraCount: 2,
    timeStr: "24m",
    subCaption: "5 people",
    barValue: 0.6,
  });
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.includes("PLAYING"));
  assert.ok(texts.includes("Counter-Strike 2"));
  assert.ok(texts.includes("24m"));
  assert.ok(texts.includes("+2"), `expected +N chip, got ${JSON.stringify(texts)}`);
  const drawImages = calls.filter((c) => c[0] === "drawImage");
  assert.equal(drawImages.length, 3, "three avatars drawn");
});

test("drawActivityTile uses voice tile background and green time for the voice variant", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawActivityTile(ctx, 0, 0, 920, 168, {
    variant: "voice",
    label: "VOICE",
    title: "General",
    avatars: [],
    extraCount: 0,
    timeStr: "2h",
    subCaption: "3 in channel",
    barValue: 1,
  });
  const fills = calls.filter((c) => c[0] === "fillStyle").map((c) => c[1]);
  assert.ok(fills.includes("rgba(28,60,40,0.62)"), "voice tile bg");
  assert.ok(fills.includes("#b8e3a1"), "green time color");
});

test("drawMemberRankTile draws rank badge, name, game line, and voice time", () => {
  const { ctx, calls } = makeStubCtx();
  // 47 * 60 = 2820 min = 1d 23h per fmtTime; check for the day portion "1d".
  stats.__drawMemberRankTile(ctx, 0, 0, 176, 168, {
    displayName: "Helms",
    voiceMinutes: 47 * 60,
    topGame: { key: "Counter-Strike 2", minutes: 38 * 60 },
  }, fakeImage2, 1, 47 * 60);
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.some((t) => t.includes("1ST")), `expected rank text, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("Helms"));
  assert.ok(texts.some((t) => t.includes("Counter-Strike 2")));
  assert.ok(texts.some((t) => t.includes("1d")), `expected day-formatted voice time, got ${JSON.stringify(texts)}`);
});

test("drawMemberRankTile uses the rank-appropriate badge for ranks 2-5", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawMemberRankTile(ctx, 0, 0, 176, 168, {
    displayName: "Cody",
    voiceMinutes: 39 * 60,
    topGame: { key: "Spotify", minutes: 15 * 60 },
  }, fakeImage2, 4, 60 * 60);
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.some((t) => t.includes("4TH")));
  assert.ok(texts.includes("Cody"));
  assert.ok(texts.some((t) => t.includes("Spotify")));
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

test("drawLeaderboardRow places the game label after the name, not overlapping it", () => {
  const { ctx, calls } = makeFontAwareStubCtx();
  stats.__drawLeaderboardRow(ctx, 0, 0, 1200, 64, {
    displayName: "Sarah",
    voiceMinutes: 14 * 60,
    topGame: { key: "Minecraft", minutes: 9 * 60 },
    avatar: fakeImage2,
  }, 4, 28 * 60);
  const fillTexts = calls.filter((c) => c[0] === "fillText");
  const nameCall = fillTexts.find((c) => c[1] === "Sarah");
  const gameCall = fillTexts.find((c) => String(c[1]).includes("Minecraft"));
  assert.ok(nameCall && gameCall, "expected both name and game fillText calls");
  // drawLeaderboardRow's nameFont is `bold ${13 * SCALE}px UI Bold` (SCALE=2).
  const nameEndX = nameCall[2] + fontWidth("Sarah", "bold 26px UI Bold");
  assert.ok(
    gameCall[2] >= nameEndX - 1,
    `game label x (${gameCall[2]}) should start at/after the name's actual rendered end (${nameEndX}) — regression check for the font-swap-before-measure overlap bug`,
  );
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
