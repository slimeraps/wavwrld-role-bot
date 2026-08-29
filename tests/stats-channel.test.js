const test = require("node:test");
const assert = require("node:assert/strict");
const { collectRows } = require("../src/stats-channel");
const { roleMap } = require("../src/state");
const trackerModule = require("../src/tracker");
const stateModule = require("../src/state");

// Builds a minimal stub guild that satisfies the surface collectRows touches.
function makeGuild({ guildId, mapping, roles }) {
  return {
    id: guildId,
    roles: {
      cache: {
        get: (id) => roles.get(id) || undefined,
      },
    },
  };
}

function makeRole({ id, name, members }) {
  return {
    id,
    name,
    members: {
      size: members.length,
      filter: (fn) => {
        const kept = members.filter(fn);
        return {
          size: kept.length,
          values: () => kept.values(),
        };
      },
      values: () => members.values(),
    },
  };
}

function makeMember({ id, displayName, isBot = false, activities = [], status = "online" }) {
  return {
    id,
    displayName,
    user: { bot: isBot, username: displayName },
    presence: { status, activities },
  };
}

test("collectRows attaches members array with id + displayName per row", () => {
  const guildId = "g1";
  const memberHelmsy = makeMember({ id: "u1", displayName: "Helmsy" });
  const role = makeRole({ id: "r1", name: "Playing Rust", members: [memberHelmsy] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "Playing Rust": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.playing.length, 1);
  const row = rows.playing[0];
  assert.deepEqual(row.members, [{ id: "u1", displayName: "Helmsy", sinceTs: null }]);
  // existing fields still present
  assert.deepEqual(row.memberNames, ["Helmsy"]);
  assert.deepEqual(row.memberIds, ["u1"]);
});

test("collectRows pulls sinceTs from a matching activity when present", () => {
  const guildId = "g2";
  const startTs = 1750000000000;
  const memberHelmsy = makeMember({
    id: "u1",
    displayName: "Helmsy",
    activities: [{ name: "Rust", createdTimestamp: startTs }],
  });
  const role = makeRole({ id: "r1", name: "Playing Rust", members: [memberHelmsy] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "Playing Rust": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.playing[0].members[0].sinceTs, startTs);
});

test("collectRows sets sinceTs to null for voice rows", () => {
  const guildId = "g3";
  const memberHelmsy = makeMember({ id: "u1", displayName: "Helmsy" });
  const role = makeRole({ id: "r1", name: "In General", members: [memberHelmsy] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "In General": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.voice.length, 1);
  assert.equal(rows.voice[0].members[0].sinceTs, null);
});

test("collectRows excludes idle members from non-voice rows", () => {
  const guildId = "g-idle-1";
  const online = makeMember({ id: "u1", displayName: "Online" });
  const idle = makeMember({ id: "u2", displayName: "Idle", status: "idle" });
  const role = makeRole({ id: "r1", name: "Playing Rust", members: [online, idle] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "Playing Rust": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.playing.length, 1);
  assert.deepEqual(rows.playing[0].memberNames, ["Online"]);
  assert.equal(rows.playing[0].count, 1);
});

test("collectRows drops a row entirely when every member is idle", () => {
  const guildId = "g-idle-2";
  const idle = makeMember({ id: "u1", displayName: "Idle", status: "idle" });
  const role = makeRole({ id: "r1", name: "Playing Rust", members: [idle] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "Playing Rust": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.playing.length, 0);
});

test("collectRows keeps idle members in voice rows", () => {
  const guildId = "g-idle-3";
  const idle = makeMember({ id: "u1", displayName: "Idle", status: "idle" });
  const role = makeRole({ id: "r1", name: "In General", members: [idle] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "In General": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.voice.length, 1);
  assert.deepEqual(rows.voice[0].memberNames, ["Idle"]);
});

const { buildLiveActivitySnapshot } = require("../src/stats-channel");

test("buildLiveActivitySnapshot attaches avatars and extraCount per row", async () => {
  const guildId = "g2";
  const members = [
    makeMember({ id: "u1", displayName: "Alice" }),
    makeMember({ id: "u2", displayName: "Bob" }),
    makeMember({ id: "u3", displayName: "Carol" }),
    makeMember({ id: "u4", displayName: "Dan" }),
  ];
  const role = makeRole({ id: "r1", name: "Playing Rust", members });
  const roles = new Map([["r1", role]]);
  roleMap[guildId] = { "Playing Rust": "r1" };

  // Extend the stub guild with members.cache so loadUserAvatarCached can
  // look users up. Each stub member returns a stable per-user fake URL from
  // displayAvatarURL; we prime the avatar cache for those URLs with a fake
  // image so the loader resolves synchronously without touching the network.
  const stats = require("../src/stats-image");
  const fakeImage = { _fake: true };
  const memberCache = new Map(members.map((m) => [m.id, {
    ...m,
    displayAvatarURL: () => `fake://avatar/${m.id}`,
  }]));
  for (const m of members) {
    stats.__userAvatarCache.set(`fake://avatar/${m.id}`, fakeImage);
  }
  const guild = {
    id: guildId,
    name: "G2",
    roles: { cache: { get: (id) => roles.get(id) || undefined } },
    members: { cache: { get: (id) => memberCache.get(id) || undefined } },
    presences: { cache: { values: () => [].values() } },
    voiceStates: { cache: { values: () => [].values() } },
  };

  const snapshot = await buildLiveActivitySnapshot(guild);
  const playingSection = snapshot.sections.find((s) => s.key === "playing");
  assert.ok(playingSection, "playing section present");
  const row = playingSection.rows[0];
  assert.ok(Array.isArray(row.avatars), "row.avatars is an array");
  assert.equal(row.avatars.length, 3, "stack capped at 3");
  assert.equal(row.extraCount, 1, "extraCount = total - 3");
});

test("buildLiveActivitySnapshot ranks a 2-person row above a longer 1-person row", async () => {
  const guildId = "g-rank-1";
  const solo = makeMember({ id: "u1", displayName: "Solo" });
  const duoA = makeMember({ id: "u2", displayName: "DuoA" });
  const duoB = makeMember({ id: "u3", displayName: "DuoB" });

  const soloRole = makeRole({ id: "r1", name: "Playing Solo Game", members: [solo] });
  const duoRole = makeRole({ id: "r2", name: "Playing Duo Game", members: [duoA, duoB] });
  const roles = new Map([["r1", soloRole], ["r2", duoRole]]);
  roleMap[guildId] = { "Playing Solo Game": "r1", "Playing Duo Game": "r2" };

  // Give the solo session a much longer elapsed time than the duo session so
  // a pure minutes-desc sort would (wrongly) put it first.
  trackerModule.observePresence(guildId, "game", "Playing Solo Game", "u1");
  trackerModule.observePresence(guildId, "game", "Playing Duo Game", "u2");
  trackerModule.observePresence(guildId, "game", "Playing Duo Game", "u3");
  stateModule.openSessions[guildId]["game|Playing Solo Game|u1"].startedAt -= 120 * 60_000;
  stateModule.openSessions[guildId]["game|Playing Duo Game|u2"].startedAt -= 5 * 60_000;
  stateModule.openSessions[guildId]["game|Playing Duo Game|u3"].startedAt -= 5 * 60_000;

  const guild = {
    id: guildId,
    name: "RankGuild",
    roles: { cache: { get: (id) => roles.get(id) || undefined } },
    members: { cache: { get: () => undefined } },
    presences: { cache: { values: () => [].values() } },
    voiceStates: { cache: { values: () => [].values() } },
  };

  const snapshot = await buildLiveActivitySnapshot(guild);
  const playing = snapshot.sections.find((s) => s.key === "playing");
  assert.equal(playing.rows[0].display, "Duo Game", "2-person row should outrank the longer 1-person row");
  assert.equal(playing.rows[1].display, "Solo Game");
});
