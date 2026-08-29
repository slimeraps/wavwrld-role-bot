# "Now playing together" detection

## Problem

The Live Activity image already computes, every 15 seconds, which games and
voice channels currently have multiple concurrent members — that's the
participant-count-first ranking from the 11.1.0 work. But it's a snapshot:
you only see a group forming if you happen to look at the dashboard at the
right moment. There's no active surface that calls out "hey, 3+ people just
converged on the same game or channel right now."

## Scope

New feature: a live-updating message per qualifying game/voice-channel
session, posted to the stats channel, edited as membership changes, and
deleted when the group falls back below threshold. This is additive — it
does not change the Live Activity image, its ranking, or its rendering.

**In scope:** games and voice channels, both tracked (premade-role) and
synthetic (untracked/raw) rows — the same universe `collectRows` +
`collectSyntheticRows` already cover.

**Out of scope:** `!stats` leaderboard, milestones/achievements (separate
v12 feature, not designed yet), any change to `collectRows` /
`collectSyntheticRows` / `buildLiveActivitySnapshot` output shape.

## Design

### 1. Detecting qualifying groups

On the same 15s cadence as `updateStatsEmbed`, a new
`updateGroupActivityMessages(client)` in
[src/stats-channel.js](../../../src/stats-channel.js):

1. Calls `collectRows(guild)` and `collectSyntheticRows(guild, rows)` (both
   already idle-filtered, bot-excluded).
2. Merges tracked + synthetic rows per section, same merge
   `buildLiveActivitySnapshot` already performs.
3. Filters to rows where `row.members.length >= (config.groupActivityThreshold || 3)`.

Voice and game rows are treated by the same mechanism — no per-type special
casing beyond the display/emoji text in §3.

### 2. Row identity (the key)

Each qualifying row needs a stable key across ticks so edits land on the
right message instead of creating duplicates:

- Tracked game row → `roleId`
- Voice row → `channelId` (available on tracked voice rows via the existing
  `voiceChannelRoles` mapping)
- Synthetic (untracked) row → `` `${section}\0${normalizeDisplayKey(display)}` ``,
  reusing the same `normalizeDisplayKey` helper `collectSyntheticRows`
  already uses for its own dedup.

### 3. Message lifecycle

Persisted state (new `state.js` bucket): `groupActivityMessages[guildId][key] = messageId`,
saved via the existing `saveData()`.

Per tick, per guild:

- **Key not previously tracked, row now qualifies** → send a new message,
  store its ID under that key.
- **Key previously tracked, row still qualifies** → compare a hash of
  `(display, sorted member id list)` against the last-sent value (in-memory
  `Map`, same pattern as `lastLiveUrl`/`lastStatsUrl`). If unchanged, skip
  the edit. If changed, `edit()` the existing message with the new member
  list.
- **Key previously tracked, row no longer qualifies** (dropped below
  threshold or vanished) → delete the message, remove the key from
  `groupActivityMessages[guildId]`, `saveData()`.

Fetch/delete failures (message already gone, permissions, etc.) are caught,
logged, and reported via `sendMonitoring()` — the key is removed from the
persisted map regardless so a bad state doesn't wedge future ticks, mirroring
`fetchOrCreateMessage`'s existing "cached message not found → drop and
recreate" behavior.

Because the persisted map survives restarts, a group that ended while the
bot was offline gets cleaned up on the first post-restart tick (its key is
in the map but the row no longer qualifies), and a group still active across
a restart keeps editing the same message rather than duplicating it.

### 4. Message content

Plain content message (not an embed — consistent with how `updateStatsEmbed`
already sends bare content), no member mentions
(`allowedMentions: { parse: [] }`):

```
🎮 **3 playing Rust** — Alice, Bob, Carol
Started <t:1735689600:R>
```

Voice rows use 🎤 and "in `<channel name>`" phrasing:

```
🎤 **4 in General** — Alice, Bob, Carol, Dave
Started <t:1735689600:R>
```

The relative timestamp uses the message's own `createdTimestamp` — since a
message is only created once (when the group first crosses the threshold)
and edited afterward, its creation time is definitionally the session start.
No separate "session start" state needs to be tracked or persisted.

### 5. Config

New `config.json` key: `groupActivityThreshold` (default `3` when unset or
falsy). Read directly as `config.groupActivityThreshold`, no env var — this
is a per-guild tuning knob, not host/secret config, consistent with how
`vipRoleId` and other gameplay-tuning keys are handled.

Channel resolution reuses `STATS_CHANNEL_ID` (env, preferred) / `config.statsChannelId`,
same as the other stats-channel auto-updaters. If unset, the function
no-ops silently, matching `updateStatsEmbed`'s existing guard.

## Testing

Extend `tests/stats-channel.test.js` with cases for:

- Row → key mapping: `roleId` for tracked game rows, `channelId` for voice
  rows, normalized-display key for synthetic rows.
- Threshold filtering: a row at exactly `groupActivityThreshold` qualifies;
  one below does not; default of `3` applies when the config key is unset.
- Lifecycle:
  - New qualifying row → message created, key stored.
  - Membership change on a tracked key → message edited.
  - No membership change → edit skipped (hash check).
  - Row drops below threshold or disappears → message deleted, key removed.
- Restart recovery: a persisted key with no matching in-memory hash state
  (simulating a fresh process) still resolves correctly — deletes if the row
  no longer qualifies, edits correctly if it does.
