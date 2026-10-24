"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { auditGuild } = require("../src/doctor");
const configModule = require("../src/config");
const { roleMap, autoManaged, voiceChannelRoles, promotedRoles, originalPositions } = require("../src/state");

// ── fixture helpers ──────────────────────────────────────────────────────────

function makeRole({ id, name, managed = false, editable = true, members = 0, onDelete }) {
  return {
    id,
    name,
    managed,
    editable,
    members: { size: members },
    delete: async () => onDelete?.(id),
  };
}

function makeGuild({ id, roles, channelIds = [] }) {
  return {
    id,
    name: "Test Guild",
    roles: { cache: new Map(roles.map((role) => [role.id, role])), fetch: async () => {} },
    channels: { cache: new Map(channelIds.map((channelId) => [channelId, { id: channelId }])) },
  };
}

function resetGuildState(guildId) {
  delete roleMap[guildId];
  delete autoManaged[guildId];
  delete voiceChannelRoles[guildId];
  delete promotedRoles[guildId];
  delete originalPositions[guildId];
}

// Same pattern as tests/presence.test.js: mutate configModule.config in place
// for the duration of `fn`, then restore every original key.
async function withConfig(overrides, fn) {
  const saved = { ...configModule.config };
  Object.assign(configModule.config, overrides);
  try {
    await fn();
  } finally {
    for (const key of Object.keys(configModule.config)) {
      if (!(key in saved)) delete configModule.config[key];
    }
    Object.assign(configModule.config, saved);
  }
}

async function withPremade(ids, fn) {
  for (const id of ids) configModule.premadeRoleIdsSet.add(id);
  try {
    await fn();
  } finally {
    for (const id of ids) configModule.premadeRoleIdsSet.delete(id);
  }
}

const ids = (list) => list.map((entry) => entry.id);

// ── auditGuild ───────────────────────────────────────────────────────────────

test("premade copy is kept and other copies removed", async () => {
  resetGuildState("g1");
  await withPremade(["p1"], async () => {
    const guild = makeGuild({
      id: "g1",
      roles: [
        makeRole({ id: "p1", name: "Playing Tarkov" }),
        makeRole({ id: "d1", name: "Playing Tarkov" }),
        makeRole({ id: "d2", name: "playing tarkov" }),
      ],
    });
    const audit = await auditGuild(guild);
    assert.equal(audit.groups.length, 1);
    assert.deepEqual(ids(audit.groups[0].keep), ["p1"]);
    assert.equal(audit.groups[0].keep[0].reason, "premade");
    assert.deepEqual(ids(audit.groups[0].remove), ["d1", "d2"]);
    assert.equal(audit.toDeleteCount, 2);
    assert.equal(audit.keptCount, 1);
  });
});

test("group without keeper removes every copy", async () => {
  resetGuildState("g2");
  roleMap.g2 = { "Playing Gemini": "a" };
  autoManaged.g2 = new Set(["Playing Gemini"]);
  const guild = makeGuild({
    id: "g2",
    roles: ["a", "b", "c"].map((id) => makeRole({ id, name: "Playing Gemini" })),
  });
  const audit = await auditGuild(guild);
  assert.equal(audit.groups.length, 1);
  assert.equal(audit.groups[0].remove.length, 3);
  assert.equal(audit.groups[0].keep.length, 0);
});

test("single untracked role is left alone", async () => {
  resetGuildState("g3");
  const audit = await auditGuild(makeGuild({ id: "g3", roles: [makeRole({ id: "s", name: "Playing Solo" })] }));
  assert.equal(audit.groups.length, 0);
});

test("human-made duplicate names are ignored", async () => {
  resetGuildState("g4");
  const guild = makeGuild({
    id: "g4",
    roles: [makeRole({ id: "m1", name: "Member" }), makeRole({ id: "m2", name: "Member" })],
  });
  const audit = await auditGuild(guild);
  assert.equal(audit.groups.length, 0);
});

test("protected, managed and @everyone roles are never candidates", async () => {
  resetGuildState("g5");
  await withConfig({ protectedRoles: ["Playing Safe"] }, async () => {
    const guild = makeGuild({
      id: "g5",
      roles: [
        makeRole({ id: "g5", name: "Playing Everyone" }),
        makeRole({ id: "e2", name: "Playing Everyone" }),
        makeRole({ id: "s1", name: "Playing Safe" }),
        makeRole({ id: "s2", name: "Playing Safe" }),
        makeRole({ id: "b1", name: "Playing Bot", managed: true }),
        makeRole({ id: "b2", name: "Playing Bot", managed: true }),
      ],
    });
    const audit = await auditGuild(guild);
    assert.equal(audit.groups.length, 0);
  });
});

test("timer prefix and case are ignored when grouping", async () => {
  resetGuildState("g6");
  const guild = makeGuild({
    id: "g6",
    roles: [makeRole({ id: "t1", name: "[5m] Playing Foo" }), makeRole({ id: "t2", name: "playing foo" })],
  });
  const audit = await auditGuild(guild);
  assert.equal(audit.groups.length, 1);
  assert.deepEqual(ids(audit.groups[0].remove), ["t1", "t2"]);
});

test("tracked roles for two live channels with same name are both kept", async () => {
  resetGuildState("g7");
  voiceChannelRoles.g7 = { vc1: "v1", vc2: "v2" };
  const guild = makeGuild({
    id: "g7",
    roles: [makeRole({ id: "v1", name: "In General" }), makeRole({ id: "v2", name: "In General" })],
    channelIds: ["vc1", "vc2"],
  });
  const audit = await auditGuild(guild);
  assert.equal(audit.groups.length, 0);
});

test("untracked In copy next to a tracked voice role is removed", async () => {
  resetGuildState("g8");
  voiceChannelRoles.g8 = { vc1: "v1" };
  const guild = makeGuild({
    id: "g8",
    roles: [makeRole({ id: "v1", name: "In General" }), makeRole({ id: "v3", name: "In General" })],
    channelIds: ["vc1"],
  });
  const audit = await auditGuild(guild);
  assert.equal(audit.groups.length, 1);
  assert.deepEqual(ids(audit.groups[0].remove), ["v3"]);
  assert.equal(audit.groups[0].keep[0].reason, "voice channel");
});

test("voice role for a deleted channel is not exempt", async () => {
  resetGuildState("g9");
  voiceChannelRoles.g9 = { vc9: "v9" };
  const guild = makeGuild({
    id: "g9",
    roles: [makeRole({ id: "v9", name: "In Lobby" }), makeRole({ id: "v8", name: "In Lobby" })],
  });
  const audit = await auditGuild(guild);
  assert.equal(audit.groups.length, 1);
  assert.deepEqual(ids(audit.groups[0].remove).sort(), ["v8", "v9"]);
});

test("fallback, live and vip roles are kept", async () => {
  resetGuildState("g10");
  await withConfig({ liveRoleId: "lv", fallbackRoleId: "fb", vipRoleId: "vp" }, async () => {
    const guild = makeGuild({
      id: "g10",
      roles: [
        makeRole({ id: "lv", name: "Playing Live" }),
        makeRole({ id: "l2", name: "Playing Live" }),
        makeRole({ id: "fb", name: "Playing Other" }),
        makeRole({ id: "f2", name: "Playing Other" }),
        makeRole({ id: "vp", name: "In VIP" }),
        makeRole({ id: "v2", name: "In VIP" }),
      ],
    });
    const audit = await auditGuild(guild);
    assert.equal(audit.groups.length, 3);
    for (const group of audit.groups) {
      assert.equal(group.keep.length, 1);
      assert.equal(group.keep[0].reason, "configured role");
    }
    assert.deepEqual(audit.groups.flatMap((group) => ids(group.remove)).sort(), ["f2", "l2", "v2"]);
  });
});

test("stale records are listed", async () => {
  resetGuildState("g11");
  roleMap.g11 = { "Playing Gone": "missing" };
  autoManaged.g11 = new Set(["Playing Gone", "Orphan"]);
  voiceChannelRoles.g11 = { vcX: "missing2" };
  promotedRoles.g11 = ["missing3"];
  originalPositions.g11 = { missing4: 3 };
  const audit = await auditGuild(makeGuild({ id: "g11", roles: [] }));
  assert.deepEqual(audit.stale.roleMap, ["Playing Gone"]);
  assert.deepEqual(audit.stale.autoManaged, ["Orphan"]);
  assert.deepEqual(audit.stale.voice, ["vcX"]);
  assert.deepEqual(audit.stale.promoted, ["missing3"]);
  assert.deepEqual(audit.stale.positions, ["missing4"]);
  assert.equal(audit.staleCount, 5);
});
