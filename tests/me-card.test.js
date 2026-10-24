"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { renderMeCard } = require("../src/me-card");
const { renderMeImage, __meImageCache } = require("../src/panel");
const tracker = require("../src/tracker");
const { playtime } = require("../src/state");

function sampleStats(overrides = {}) {
  return {
    userId: "u1",
    displayName: "Helmsy",
    rank: 3,
    allTime: {
      voiceMinutes: 412 * 60,
      topGames: [
        { name: "Escape from Tarkov", minutes: 286 * 60 },
        { name: "Rust", minutes: 141 * 60 },
        { name: "Rocket League", minutes: 63 * 60 },
      ],
    },
    week: {
      voiceMinutes: 18 * 60,
      topGames: [{ name: "Escape from Tarkov", minutes: 11 * 60 }, { name: "Minecraft", minutes: 4 * 60 }],
    },
    ...overrides,
  };
}

const isJpeg = (buffer) => Buffer.isBuffer(buffer) && buffer[0] === 0xff && buffer[1] === 0xd8;

test("renders a JPEG", async () => {
  const buffer = await renderMeCard({ guildName: "WAV WRLD", stats: sampleStats(), avatar: null });
  assert.ok(isJpeg(buffer));
});

test("renders empty stats", async () => {
  const stats = sampleStats({
    rank: null,
    allTime: { voiceMinutes: 0, topGames: [] },
    week: { voiceMinutes: 0, topGames: [] },
  });
  assert.ok(isJpeg(await renderMeCard({ guildName: "WAV WRLD", stats, avatar: null })));
});

test("renders extreme values", async () => {
  const longName = "A Really Extremely Long Game Name That Goes On And On Forever And Ever More";
  const stats = sampleStats({
    displayName: "x".repeat(32),
    allTime: { voiceMinutes: 6_000_000, topGames: [1, 2, 3].map((i) => ({ name: `${longName} ${i}`, minutes: 5_000_000 })) },
    week: { voiceMinutes: 10_080, topGames: [{ name: longName, minutes: 10_000 }] },
  });
  assert.ok(isJpeg(await renderMeCard({ guildName: "G".repeat(100), stats, avatar: null })));
});

// ── panel route helper ───────────────────────────────────────────────────────

function fakeClient(guildId) {
  const member = (id, displayName) => [id, { id, displayName, user: { bot: false } }];
  const guild = {
    id: guildId,
    name: "Panel Guild",
    members: { cache: new Map([member("111111111111111111", "Alice"), member("222222222222222222", "Bob")]) },
  };
  return { guilds: { cache: new Map([[guildId, guild]]) } };
}

test("renderMeImage 404s a user who is neither a member nor tracked", async () => {
  await assert.rejects(
    renderMeImage(fakeClient("900000000000000002"), "900000000000000002", "123456789012345678"),
    (err) => err.httpCode === 404 && err.message === "user_not_found",
  );
});

test("renderMeImage still renders a member who left but has data", async () => {
  const guildId = "900000000000000003";
  tracker.userBreakdown(guildId, "voice", "lifetime", "nobody");
  playtime[guildId].voice.lifetime = { vc1: { "444444444444444444": 30 } };
  const entry = await renderMeImage(fakeClient(guildId), guildId, "444444444444444444");
  assert.ok(isJpeg(entry.buffer));
});

test("renderMeImage evicts expired entries and caps the cache", async () => {
  __meImageCache.clear();
  for (let i = 0; i < 250; i++) {
    __meImageCache.set(`old:${i}`, { buffer: Buffer.alloc(1), mime: "image/jpeg", generatedAt: 0 });
  }
  await renderMeImage(fakeClient("900000000000000004"), "900000000000000004", "111111111111111111");
  assert.equal(__meImageCache.size, 1, "expired entries are dropped on insert");

  for (let i = 0; i < 250; i++) {
    __meImageCache.set(`fresh:${i}`, { buffer: Buffer.alloc(1), mime: "image/jpeg", generatedAt: Date.now() });
  }
  await renderMeImage(fakeClient("900000000000000004"), "900000000000000004", "222222222222222222");
  assert.ok(__meImageCache.size <= 200, `cache size ${__meImageCache.size}`);
  assert.ok(__meImageCache.has("900000000000000004:222222222222222222"), "newest entry is kept");
});

test("renderMeImage caches per user", async () => {
  const client = fakeClient("900000000000000001");
  const first = await renderMeImage(client, "900000000000000001", "111111111111111111");
  const again = await renderMeImage(client, "900000000000000001", "111111111111111111");
  const other = await renderMeImage(client, "900000000000000001", "222222222222222222");
  assert.equal(first.mime, "image/jpeg");
  assert.ok(isJpeg(first.buffer));
  assert.equal(again, first, "second call within TTL returns the cached entry");
  assert.notEqual(other, first);
});

test("renderMeImage 404s unknown guild", async () => {
  await assert.rejects(
    renderMeImage({ guilds: { cache: new Map() } }, "900000000000000009", "111111111111111111"),
    (err) => err.httpCode === 404 && err.message === "guild_not_found",
  );
});
