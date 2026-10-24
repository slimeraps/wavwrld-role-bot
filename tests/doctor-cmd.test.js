"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { doctorCmd } = require("../src/doctor-cmd");
const configModule = require("../src/config");
const { roleMap, autoManaged } = require("../src/state");

function makeGuild(id, roleNames, onDelete) {
  const roles = roleNames.map((name, i) => ({
    id: `${id}-r${i}`,
    name,
    managed: false,
    editable: true,
    members: { size: 0 },
    delete: async () => onDelete(`${id}-r${i}`),
  }));
  return {
    id,
    name: "Test Guild",
    roles: { cache: new Map(roles.map((role) => [role.id, role])), fetch: async () => {} },
    channels: { cache: new Map() },
  };
}

function makeCtx(guild, { replyThrowsOnCall = null } = {}) {
  const replies = [];
  const sent = [];
  let calls = 0;
  return {
    replies,
    sent,
    guild,
    channel: { send: async (text) => sent.push(text) },
    defer: async () => {},
    reply: async (text) => {
      calls += 1;
      if (calls === replyThrowsOnCall) throw new Error("Unknown interaction");
      replies.push(text);
    },
  };
}

async function withDryRun(value, fn) {
  const saved = configModule.config.dryRun;
  configModule.config.dryRun = value;
  try {
    await fn();
  } finally {
    configModule.config.dryRun = saved;
  }
}

function reset(guildId) {
  delete roleMap[guildId];
  delete autoManaged[guildId];
}

test("report-only run replies with the audit and deletes nothing", async () => {
  reset("c1");
  const deleted = [];
  const ctx = makeCtx(makeGuild("c1", ["Playing Gemini", "Playing Gemini"], (id) => deleted.push(id)));
  await doctorCmd(ctx, {});
  assert.equal(deleted.length, 0);
  assert.equal(ctx.replies.length, 1);
  assert.ok(ctx.replies[0].includes("1 duplicate groups · 2 roles to delete · 0 kept"));
});

test("fix with dryRun deletes nothing and replies with would-delete", async () => {
  reset("c2");
  const deleted = [];
  const ctx = makeCtx(makeGuild("c2", ["Playing Gemini", "Playing Gemini"], (id) => deleted.push(id)));
  await withDryRun(true, () => doctorCmd(ctx, { fix: true }));
  assert.equal(deleted.length, 0);
  assert.ok(ctx.replies.at(-1).includes("Dry run: would delete 2 duplicate roles."));
});

test("fix with nothing to do says so", async () => {
  reset("c3");
  const ctx = makeCtx(makeGuild("c3", ["Playing Solo"], () => {}));
  await doctorCmd(ctx, { fix: true });
  assert.deepEqual(ctx.replies, ["No duplicate roles found. Nothing to fix."]);
});

test("final reply falls back to channel.send when reply throws", async () => {
  reset("c4");
  const ctx = makeCtx(makeGuild("c4", ["Playing Gemini", "Playing Gemini"], () => {}), { replyThrowsOnCall: 2 });
  await withDryRun(true, () => doctorCmd(ctx, { fix: true }));
  assert.equal(ctx.sent.length, 1);
  assert.ok(ctx.sent[0].includes("Dry run: would delete 2 duplicate roles."));
});
