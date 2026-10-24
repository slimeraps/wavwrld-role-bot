"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { meCmd, parseMeText } = require("../src/me-cmd");

const GUILD_ID = "900000000000000100";
const ALICE = "111111111111111111";
const BOB = "222222222222222222";
const BOT = "333333333333333333";

function makeCtx() {
  const replies = [];
  const guild = {
    id: GUILD_ID,
    name: "Cmd Guild",
    members: {
      cache: new Map([
        [ALICE, { id: ALICE, displayName: "Alice", user: { bot: false } }],
        [BOB, { id: BOB, displayName: "Bob", user: { bot: false } }],
        [BOT, { id: BOT, displayName: "Robo", user: { bot: true } }],
      ]),
    },
  };
  return {
    replies,
    guild,
    author: { id: ALICE },
    channel: { send: async (payload) => replies.push(payload) },
    defer: async () => {},
    reply: async (payload) => replies.push(payload),
    followUp: async (payload) => replies.push(payload),
  };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("parseMeText reads mentions and ids", () => {
  assert.deepEqual(parseMeText([`<@${BOB}>`]), { userId: BOB });
  assert.deepEqual(parseMeText([`<@!${BOB}>`]), { userId: BOB });
  assert.deepEqual(parseMeText([BOB]), { userId: BOB });
  assert.deepEqual(parseMeText(["hello"]), { userId: null });
  assert.deepEqual(parseMeText([]), { userId: null });
});

test("replies with image url when panel is configured", async () => {
  await withEnv({ PANEL_TOKEN: "secret", FLY_APP_NAME: "wavwrld-role-bot", PANEL_PUBLIC_URL: null }, async () => {
    const ctx = makeCtx();
    await meCmd(ctx, { userId: BOB });
    assert.equal(ctx.replies.length, 1);
    assert.match(ctx.replies[0].content, new RegExp(`/me/${GUILD_ID}/${BOB}\\.jpg\\?t=\\d+$`));
    assert.deepEqual(ctx.replies[0].allowedMentions, { parse: [] });
  });
});

test("falls back to text embed without panel", async () => {
  await withEnv({ PANEL_TOKEN: null, FLY_APP_NAME: null, PANEL_PUBLIC_URL: null }, async () => {
    const ctx = makeCtx();
    await meCmd(ctx, { userId: null });
    const embed = ctx.replies[0].embeds[0].toJSON();
    assert.equal(embed.title, "Alice's stats");
    assert.deepEqual(embed.fields.map((f) => f.name), ["Voice · all time", "Top games · all time", "This week"]);
  });
});

test("bot target gets text reply", async () => {
  const ctx = makeCtx();
  await meCmd(ctx, { userId: BOT });
  assert.deepEqual(ctx.replies, ["Bots don't have stats."]);
});

test("defaults to the caller", async () => {
  await withEnv({ PANEL_TOKEN: "secret", FLY_APP_NAME: "wavwrld-role-bot", PANEL_PUBLIC_URL: null }, async () => {
    const ctx = makeCtx();
    await meCmd(ctx, {});
    assert.match(ctx.replies[0].content, new RegExp(`/me/${GUILD_ID}/${ALICE}\\.jpg`));
  });
});
