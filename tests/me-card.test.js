"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { renderMeCard } = require("../src/me-card");

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
