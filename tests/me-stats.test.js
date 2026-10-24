"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { gameDisplayName, isNonGameName, topEntries, buildMeStats } = require("../src/me-stats");
const tracker = require("../src/tracker");
const { openSessions, playtime, playtimeResets } = require("../src/state");

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeGuild(id, memberIds) {
  return {
    id,
    name: "Test Guild",
    members: {
      cache: new Map(memberIds.map((memberId) => [memberId, { id: memberId, displayName: `Name ${memberId}`, user: { bot: false, username: memberId } }])),
    },
  };
}

function resetGuild(guildId) {
  delete openSessions[guildId];
  delete playtime[guildId];
  playtimeResets[guildId] = { daily: Date.now(), weekly: Date.now(), monthly: Date.now() };
  tracker.userBreakdown(guildId, "game", "lifetime", "nobody"); // creates every bucket
}

function seed(guildId, type, period, bucket) {
  playtime[guildId][type][period] = bucket;
}

// ── naming rules ─────────────────────────────────────────────────────────────

test("gameDisplayName strips Playing and Medal", () => {
  assert.equal(gameDisplayName("Playing Tarkov"), "Tarkov");
  assert.equal(gameDisplayName("playing Rust with Medal"), "Rust");
  assert.equal(gameDisplayName("FL Studio"), "FL Studio");
});

test("isNonGameName", () => {
  assert.equal(isNonGameName("Listening to Spotify"), true);
  assert.equal(isNonGameName("watching Twitch"), true);
  assert.equal(isNonGameName("Designing in Blender"), false);
  assert.equal(isNonGameName("Codex"), false);
});

test("topEntries merges same display name", () => {
  assert.deepEqual(
    topEntries({ "Playing Valorant": 30, "Valorant": 20, "Playing Rust": 40 }),
    [{ name: "Valorant", minutes: 50 }, { name: "Rust", minutes: 40 }],
  );
});

test("topEntries drops non-game and caps at 3", () => {
  const result = topEntries({
    "Playing Listening to Spotify": 999,
    "Watching YouTube": 500,
    "Playing A": 40,
    "Playing B": 30,
    "Playing C": 20,
    "Playing D": 10,
    "Playing Zero": 0,
  });
  assert.deepEqual(result.map((e) => e.name), ["A", "B", "C"]);
});

// ── buildMeStats ─────────────────────────────────────────────────────────────

test("buildMeStats all-time and weekly", () => {
  resetGuild("gm1");
  seed("gm1", "voice", "lifetime", { vc1: { u1: 100 }, vc2: { u1: 20, u2: 5 } });
  seed("gm1", "voice", "weekly", { vc1: { u1: 15 } });
  seed("gm1", "game", "lifetime", { "Playing Tarkov": { u1: 300 }, "Playing Rust": { u1: 120 } });
  seed("gm1", "game", "weekly", { "Playing Rust": { u1: 60 } });
  const stats = buildMeStats(makeGuild("gm1", ["u1", "u2"]), "u1");
  assert.equal(stats.displayName, "Name u1");
  assert.equal(stats.allTime.voiceMinutes, 120);
  assert.deepEqual(stats.allTime.topGames, [{ name: "Tarkov", minutes: 300 }, { name: "Rust", minutes: 120 }]);
  assert.equal(stats.week.voiceMinutes, 15);
  assert.deepEqual(stats.week.topGames, [{ name: "Rust", minutes: 60 }]);
});

test("live sessions count everywhere", () => {
  resetGuild("gm2");
  openSessions.gm2["voice|vc1|u1"] = { type: "voice", key: "vc1", subjectId: "u1", startedAt: Date.now() - 10 * 60_000 };
  const stats = buildMeStats(makeGuild("gm2", ["u1"]), "u1");
  assert.ok(stats.allTime.voiceMinutes >= 10);
  assert.ok(stats.week.voiceMinutes >= 10);
  assert.equal(stats.rank, 1);
});

test("empty week after reset", () => {
  resetGuild("gm3");
  seed("gm3", "voice", "lifetime", { vc1: { u1: 50 } });
  seed("gm3", "game", "lifetime", { "Playing Rust": { u1: 70 } });
  const stats = buildMeStats(makeGuild("gm3", ["u1"]), "u1");
  assert.equal(stats.week.voiceMinutes, 0);
  assert.deepEqual(stats.week.topGames, []);
  assert.equal(stats.allTime.voiceMinutes, 50);
  assert.equal(stats.allTime.topGames.length, 1);
});

test("rank by lifetime voice", () => {
  resetGuild("gm4");
  seed("gm4", "voice", "lifetime", { vc1: { u2: 60, u1: 40, u3: 20 } });
  const guild = makeGuild("gm4", ["u1", "u2", "u3", "u4"]);
  assert.equal(buildMeStats(guild, "u1").rank, 2);
  assert.equal(buildMeStats(guild, "u4").rank, null);
});

test("rank ignores members who left", () => {
  resetGuild("gm5");
  seed("gm5", "voice", "lifetime", { vc1: { u2: 60, u1: 40 } });
  const guild = makeGuild("gm5", ["u1"]);
  assert.equal(buildMeStats(guild, "u1").rank, 1);
  const leftStats = buildMeStats(guild, "u2");
  assert.equal(leftStats.allTime.voiceMinutes, 60, "a member who left still gets their own numbers");
  assert.equal(leftStats.displayName, "user u2");
});
