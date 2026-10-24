"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { auditGuild, fixGuild, formatAuditReport, formatFixReport } = require("../src/doctor");
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

// ── fixGuild ─────────────────────────────────────────────────────────────────

function geminiGuild(guildId, extra = {}) {
  roleMap[guildId] = { "Playing Gemini": "a" };
  autoManaged[guildId] = new Set(["Playing Gemini"]);
  const deletedIds = [];
  const onDelete = extra.onDelete || ((id) => deletedIds.push(id));
  const roles = [
    makeRole({ id: "a", name: "Playing Gemini", onDelete, ...(extra.a || {}) }),
    makeRole({ id: "b", name: "Playing Gemini", onDelete, ...(extra.b || {}) }),
  ];
  return { guild: makeGuild({ id: guildId, roles }), deletedIds };
}

test("deletes every remove entry and untracks first", async () => {
  resetGuildState("f1");
  const seenTracked = [];
  const { guild } = geminiGuild("f1", {
    onDelete: (id) => seenTracked.push(Object.values(roleMap.f1).includes(id)),
  });
  const result = await fixGuild(guild, await auditGuild(guild), { dryRun: false, gapMs: 0 });
  assert.deepEqual(ids(result.deleted).sort(), ["a", "b"]);
  assert.deepEqual(seenTracked, [false, false]);
  assert.equal(result.changed, true);
  assert.equal(result.failed.length, 0);
});

test("dryRun deletes nothing and changes no state", async () => {
  resetGuildState("f2");
  const { guild, deletedIds } = geminiGuild("f2");
  const before = JSON.stringify(roleMap.f2);
  const result = await fixGuild(guild, await auditGuild(guild), { dryRun: true, gapMs: 0 });
  assert.deepEqual(deletedIds, []);
  assert.equal(JSON.stringify(roleMap.f2), before);
  assert.ok(autoManaged.f2.has("Playing Gemini"));
  assert.equal(result.deleted.length, 2);
  assert.equal(result.changed, false);
  assert.equal(result.dryRun, true);
});

test("non-editable role is reported and run continues", async () => {
  resetGuildState("f3");
  const { guild, deletedIds } = geminiGuild("f3", { a: { editable: false } });
  const result = await fixGuild(guild, await auditGuild(guild), { dryRun: false, gapMs: 0 });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, "a");
  assert.equal(result.failed[0].reason, "role is above the bot or not editable");
  assert.deepEqual(deletedIds, ["b"]);
  assert.deepEqual(ids(result.deleted), ["b"]);
});

test("dryRun still reports non-editable roles as failures", async () => {
  resetGuildState("f6");
  const { guild } = geminiGuild("f6", { a: { editable: false } });
  const result = await fixGuild(guild, await auditGuild(guild), { dryRun: true, gapMs: 0 });
  assert.deepEqual(ids(result.failed), ["a"]);
  assert.deepEqual(ids(result.deleted), ["b"]);
});

test("throwing editable getter is recorded and run continues", async () => {
  resetGuildState("f7");
  const deletedIds = [];
  const { guild } = geminiGuild("f7", { onDelete: (id) => deletedIds.push(id) });
  // Real Role.editable reads guild.members.resolve(client.user) and throws
  // when the bot's own member isn't cached.
  Object.defineProperty(guild.roles.cache.get("a"), "editable", {
    get() { throw new TypeError("Cannot read properties of null (reading 'permissions')"); },
  });
  const result = await fixGuild(guild, await auditGuild(guild), { dryRun: false, gapMs: 0 });
  assert.deepEqual(ids(result.failed), ["a"]);
  assert.deepEqual(deletedIds, ["b"]);
});

test("delete error is recorded and run continues", async () => {
  resetGuildState("f4");
  const deletedIds = [];
  const { guild } = geminiGuild("f4", {
    onDelete: (id) => {
      if (id === "a") throw new Error("rate limited");
      deletedIds.push(id);
    },
  });
  const result = await fixGuild(guild, await auditGuild(guild), { dryRun: false, gapMs: 0 });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, "rate limited");
  assert.deepEqual(deletedIds, ["b"]);
});

test("stale records are pruned", async () => {
  resetGuildState("f5");
  roleMap.f5 = { "Playing Gone": "missing" };
  autoManaged.f5 = new Set(["Playing Gone", "Orphan"]);
  voiceChannelRoles.f5 = { vcX: "missing2" };
  promotedRoles.f5 = ["missing3"];
  originalPositions.f5 = { missing4: 3 };
  const guild = makeGuild({ id: "f5", roles: [] });
  const result = await fixGuild(guild, await auditGuild(guild), { dryRun: false, gapMs: 0 });
  assert.equal(result.pruned, 5);
  assert.deepEqual(roleMap.f5, {});
  assert.equal(autoManaged.f5.size, 0);
  assert.deepEqual(voiceChannelRoles.f5, {});
  assert.deepEqual(promotedRoles.f5, []);
  assert.deepEqual(originalPositions.f5, {});
  assert.equal(result.changed, true);
});

// ── report formatting ────────────────────────────────────────────────────────

function emptyStale() {
  return { roleMap: [], autoManaged: [], voice: [], promoted: [], positions: [] };
}

function sampleAudit() {
  return {
    guild: { name: "Test Guild" },
    groups: [
      { name: "Playing Gemini", keep: [], remove: [{ id: "a" }, { id: "b" }, { id: "c" }] },
      { name: "Playing Tarkov", keep: [{ id: "p1", reason: "premade" }], remove: [{ id: "d1" }, { id: "d2" }] },
    ],
    toDeleteCount: 5,
    keptCount: 1,
    stale: emptyStale(),
    staleCount: 0,
  };
}

test("summary line comes second", () => {
  const lines = formatAuditReport(sampleAudit()).split("\n");
  assert.equal(lines[0], "Role Doctor - Test Guild");
  assert.equal(lines[1], "2 duplicate groups · 5 roles to delete · 1 kept");
});

test("nothing to do shows no hint", () => {
  const text = formatAuditReport({
    guild: { name: "Test Guild" }, groups: [], toDeleteCount: 0, keptCount: 0, stale: emptyStale(), staleCount: 0,
  });
  assert.ok(text.includes("No duplicate roles found."));
  assert.ok(!text.includes("/doctor fix:true"));
});

test("group lines use exact copy", () => {
  const text = formatAuditReport({ ...sampleAudit(), staleCount: 2 });
  assert.ok(text.includes("Playing Tarkov — keep premade p1, delete 2"));
  assert.ok(text.includes("Playing Gemini — 3 copies, delete all"));
  assert.ok(text.includes("Stale records: 2"));
  assert.ok(text.includes("Run `/doctor fix:true` to fix."));
});

test("report stays under 1900 chars with 300 groups", () => {
  const groups = Array.from({ length: 300 }, (_, i) => ({
    name: `Playing Some Long Game Name ${i}`, keep: [], remove: [{ id: "x" }, { id: "y" }],
  }));
  const text = formatAuditReport({
    guild: { name: "Test Guild" }, groups, toDeleteCount: 600, keptCount: 0, stale: emptyStale(), staleCount: 0,
  });
  const lines = text.split("\n");
  assert.ok(text.length <= 1900, `length ${text.length}`);
  assert.equal(lines[1], "300 duplicate groups · 600 roles to delete · 0 kept");
  assert.ok(lines.some((line) => /^… and \d+ more groups$/.test(line)));
});

test("fix report covers dryRun, failures and resync", () => {
  const real = formatFixReport(
    { dryRun: false, deleted: [{ id: "a" }, { id: "b" }], failed: [{ id: "c", name: "Playing X", reason: "nope" }], pruned: 3 },
    { resynced: true },
  );
  assert.ok(real.includes("Deleted 2 duplicate roles."));
  assert.ok(real.includes("Pruned 3 stale records."));
  assert.ok(real.includes("Could not delete Playing X (c): nope"));
  assert.ok(real.includes("Roles re-applied from current activity."));

  const dry = formatFixReport({ dryRun: true, deleted: [{ id: "a" }, { id: "b" }], failed: [], pruned: 0 });
  assert.ok(dry.includes("Dry run: would delete 2 duplicate roles."));
  assert.ok(!dry.includes("Pruned"));
  assert.ok(!dry.includes("re-applied"));
});
