"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// handleCleanupCmd saves state; keep roles.json out of the checkout.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-cleanup-"));

const test = require("node:test");
const assert = require("node:assert/strict");

const client = require("../src/client");
const configModule = require("../src/config");
const { handleCleanupCmd } = require("../src/cleanup");

function fakeGuild(id, rolesFetch = async () => {}) {
  return {
    id,
    name: "Cleanup Guild",
    members: { me: null },
    roles: { cache: new Map(), fetch: rolesFetch },
    channels: { cache: new Map() },
  };
}

async function runCleanup(guild, ctx) {
  const saved = { ...configModule.config };
  Object.assign(configModule.config, { dryRun: false, fallbackRoleId: "", liveRoleId: "", premadeRoleIds: {} });
  client.guilds.cache.set(guild.id, guild);
  try {
    await handleCleanupCmd(ctx);
  } finally {
    client.guilds.cache.delete(guild.id);
    Object.assign(configModule.config, saved);
  }
}

test("cleanup falls back to channel.send when followUp throws", async () => {
  const sent = [];
  const ctx = {
    author: { tag: "Owner#0001", id: "owner" },
    channel: { send: async (text) => sent.push(text) },
    defer: async () => {},
    reply: async () => {},
    followUp: async () => { throw new Error("Invalid Webhook Token"); },
  };
  await runCleanup(fakeGuild("cg2"), ctx);
  assert.equal(sent.length, 2, "both the summary and the resync message should be sent");
  assert.ok(sent[0].includes("Cleanup complete"));
  assert.ok(sent[1].includes("Roles re-applied"));
});

test("doctor error in one guild does not abort cleanup", async () => {
  const followUps = [];
  const ctx = {
    author: { tag: "Owner#0001", id: "owner" },
    defer: async () => {},
    reply: async () => {},
    followUp: async (text) => followUps.push(text),
  };
  await runCleanup(fakeGuild("cg3", async () => { throw new Error("Service Unavailable"); }), ctx);
  assert.equal(followUps.length, 2);
  assert.ok(followUps[0].includes("doctor removed 0 duplicate roles"));
});

test("cleanup deletes untracked duplicate roles and reports the count", async () => {
  const saved = { ...configModule.config };
  Object.assign(configModule.config, { dryRun: false, fallbackRoleId: "", liveRoleId: "", premadeRoleIds: {} });

  const deleted = [];
  const roles = ["d1", "d2", "d3"].map((id) => ({
    id,
    name: "Playing Gemini",
    managed: false,
    editable: true,
    members: { size: 0, values: () => [][Symbol.iterator]() },
    delete: async () => deleted.push(id),
  }));
  const guild = {
    id: "cg1",
    name: "Cleanup Guild",
    members: { me: null },
    roles: { cache: new Map(roles.map((role) => [role.id, role])), fetch: async () => {} },
    channels: { cache: new Map() },
  };
  client.guilds.cache.set(guild.id, guild);

  const followUps = [];
  const ctx = {
    author: { tag: "Owner#0001", id: "owner" },
    defer: async () => {},
    reply: async () => {},
    followUp: async (text) => followUps.push(text),
  };

  try {
    await handleCleanupCmd(ctx);
  } finally {
    client.guilds.cache.delete(guild.id);
    Object.assign(configModule.config, saved);
  }

  assert.deepEqual(deleted.sort(), ["d1", "d2", "d3"]);
  assert.ok(followUps[0].includes("doctor removed 3 duplicate roles"), followUps[0]);
});
