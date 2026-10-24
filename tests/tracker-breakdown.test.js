"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const tracker = require("../src/tracker");
const { openSessions, playtime, playtimeResets } = require("../src/state");

function resetGuildState(guildId) {
  delete openSessions[guildId];
  delete playtime[guildId];
  playtimeResets[guildId] = { daily: Date.now(), weekly: Date.now(), monthly: Date.now() };
}

function seed(guildId, type, period, bucket) {
  tracker.userBreakdown(guildId, type, period, "nobody"); // creates the buckets
  playtime[guildId][type][period] = bucket;
}

test("userBreakdown sums a user's keys", () => {
  resetGuildState("gb1");
  seed("gb1", "game", "lifetime", { A: { u1: 30, u2: 5 }, B: { u1: 10 } });
  assert.deepEqual(tracker.userBreakdown("gb1", "game", "lifetime", "u1"), { total: 40, perKey: { A: 30, B: 10 } });
});

test("userBreakdown folds in open sessions", () => {
  resetGuildState("gb2");
  seed("gb2", "voice", "lifetime", {});
  openSessions.gb2["voice|vc1|u1"] = { type: "voice", key: "vc1", subjectId: "u1", startedAt: Date.now() - 5 * 60_000 };
  openSessions.gb2["game|X|u1"] = { type: "game", key: "X", subjectId: "u1", startedAt: Date.now() - 9 * 60_000 };
  const result = tracker.userBreakdown("gb2", "voice", "lifetime", "u1");
  assert.ok(result.perKey.vc1 >= 5);
  assert.equal(result.perKey.X, undefined, "other types are not folded in");
  assert.equal(result.total, result.perKey.vc1);
});

test("userBreakdown unknown user is empty", () => {
  resetGuildState("gb3");
  seed("gb3", "game", "weekly", { A: { u1: 30 } });
  assert.deepEqual(tracker.userBreakdown("gb3", "game", "weekly", "u9"), { total: 0, perKey: {} });
});
