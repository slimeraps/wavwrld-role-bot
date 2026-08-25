"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const tracker = require("../src/tracker");
const { openSessions, playtime } = require("../src/state");

function resetGuildState(guildId) {
  delete openSessions[guildId];
  delete playtime[guildId];
}

test("closeStaleRawSessions: closes a raw-name session not in keepKeys", () => {
  const guildId = "g-tracker-1";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "game", "Forza Horizon 6", "u1");
  // Backdate startedAt so observeAbsence credits a positive minute count.
  const id = `game|Forza Horizon 6|u1`;
  openSessions[guildId][id].startedAt = Date.now() - 5 * 60_000;

  tracker.closeStaleRawSessions(guildId, "u1", new Set(), new Set());

  assert.equal(openSessions[guildId][id], undefined, "session should be closed");
  assert.ok(
    playtime[guildId].game.lifetime["Forza Horizon 6"]?.u1 >= 5,
    "minutes should be credited on close",
  );
});

test("closeStaleRawSessions: leaves keepKeys sessions open", () => {
  const guildId = "g-tracker-2";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "game", "Forza Horizon 6", "u1");
  const id = `game|Forza Horizon 6|u1`;

  tracker.closeStaleRawSessions(guildId, "u1", new Set(["Forza Horizon 6"]), new Set());

  assert.ok(openSessions[guildId][id], "session should remain open");
});

test("closeStaleRawSessions: skips ignoreKeys (role-managed keys)", () => {
  const guildId = "g-tracker-3";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "game", "Playing Tarkov", "u1");
  const id = `game|Playing Tarkov|u1`;

  // "Playing Tarkov" is in ignoreKeys -> owned by autoManaged loop, do not touch.
  tracker.closeStaleRawSessions(guildId, "u1", new Set(), new Set(["Playing Tarkov"]));

  assert.ok(openSessions[guildId][id], "ignoreKeys session should remain open");
});

test("closeStaleRawSessions: only affects given member", () => {
  const guildId = "g-tracker-4";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "game", "Forza Horizon 6", "u1");
  tracker.observePresence(guildId, "game", "Forza Horizon 6", "u2");

  tracker.closeStaleRawSessions(guildId, "u1", new Set(), new Set());

  assert.equal(openSessions[guildId][`game|Forza Horizon 6|u1`], undefined);
  assert.ok(openSessions[guildId][`game|Forza Horizon 6|u2`], "u2 session untouched");
});

test("closeStaleRawSessions: skips voice sessions", () => {
  const guildId = "g-tracker-5";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "voice", "channel-id-123", "u1", { channelName: "General" });
  const id = `voice|channel-id-123|u1`;

  tracker.closeStaleRawSessions(guildId, "u1", new Set(), new Set());

  assert.ok(openSessions[guildId][id], "voice session should not be closed by this helper");
});

test("closeStaleRawSessions: no-op when guild has no sessions", () => {
  const guildId = "g-tracker-6";
  resetGuildState(guildId);

  // Should not throw.
  tracker.closeStaleRawSessions(guildId, "u1", new Set(), new Set());
  assert.ok(true);
});

test("sumActiveElapsedMinutes adds every participant's time; activeElapsedMinutes takes the max", () => {
  const guildId = "g-tracker-7";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "game", "Palworld", "u1");
  tracker.observePresence(guildId, "game", "Palworld", "u2");
  openSessions[guildId]["game|Palworld|u1"].startedAt = Date.now() - 10 * 60_000;
  openSessions[guildId]["game|Palworld|u2"].startedAt = Date.now() - 4 * 60_000;

  assert.equal(tracker.activeElapsedMinutes(guildId, "game", "Palworld"), 10);
  assert.equal(tracker.sumActiveElapsedMinutes(guildId, "game", "Palworld"), 14);
});

test("sumActiveElapsedMinutes respects the subjectIds filter", () => {
  const guildId = "g-tracker-8";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "game", "Valorant", "u1");
  tracker.observePresence(guildId, "game", "Valorant", "u2");
  openSessions[guildId]["game|Valorant|u1"].startedAt = Date.now() - 8 * 60_000;
  openSessions[guildId]["game|Valorant|u2"].startedAt = Date.now() - 3 * 60_000;

  assert.equal(tracker.sumActiveElapsedMinutes(guildId, "game", "Valorant", ["u1"]), 8);
});
