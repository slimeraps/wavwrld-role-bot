# LIVE role for streamers — design

## Problem

The bot assigns roles for streaming/watching activities purely by activity
*name*, via `premadeRoleIds` / `activityRoleMap` lookups in
[presence.js](../../../src/presence.js). Discord reports both cases below
with the same activity name (e.g. `"Twitch"`), differing only in
`activity.type`:

- Broadcasting to Twitch or YouTube from Discord's integration: `type: 1`
  (Streaming)
- Watching an embedded stream (e.g. Discord's Watch Together / embedded
  player): `type: 3` (Watching)

Because role lookup ignores `type`, a member who is actually *live* gets the
same premade role as a member who is merely *watching* a stream (e.g. the
existing "Watching Twitch" role) — there's no way to tell streamers apart
from viewers, and no way to grant a distinct "LIVE" role for streamers.

## Goals

- Members who are actively streaming (`type: 1`, any platform) get a
  distinct "LIVE" role.
- The existing name-based "Watching Twitch" role continues to work
  correctly for genuine Watching-type (`type: 3`) activity.
- LIVE is additive: a member streaming a game (e.g. Tarkov) keeps whatever
  role their `Playing` activity earns them, plus LIVE.
- Setup follows the existing `vipRoleId` / `fallbackRoleId` convention:
  the admin creates the role once in Discord and puts its ID in
  `config.json`; the bot never creates, renames, or auto-deletes it.

## Non-goals

- Distinguishing Twitch from YouTube streams (both map to the same LIVE
  role).
- Auto-creating or auto-deleting the LIVE role.
- Any change to how `premadeRoleIds`/`activityRoleMap` resolve
  Watching-type activities.

## Design

### Config

Add `liveRoleId` to `config.json`, alongside `vipRoleId` /
`fallbackRoleId`:

```json
"liveRoleId": ""
```

Empty string (the default) disables the feature entirely, same as the
other two role IDs.

### presence.js changes

1. In the per-activity loop in `handlePresence`, immediately after the
   blacklist check, skip any activity with `type === 1` (Streaming):

   ```js
   const STREAMING_ACTIVITY_TYPE = 1;
   // ...
   if (activity.type === STREAMING_ACTIVITY_TYPE) continue;
   ```

   This removes Streaming-type activities from the name-based
   `premadeRoleIds` / `activityRoleMap` resolution entirely, so they can
   no longer match a Watching-type premade role like "Watching Twitch".
   Watching-type (`type: 3`) activities are untouched and keep resolving
   through the existing path.

2. Compute whether the member is currently live:

   ```js
   const isLive = !isIdle && presence.activities.some(
     (a) => a.type === STREAMING_ACTIVITY_TYPE
   );
   ```

   Idle is treated as "not live," consistent with how idle is already
   treated as "no activities" elsewhere in this function.

3. Add a LIVE role add/remove block, mirroring the existing fallback-role
   block at the end of `handlePresence` (dry-run support and monitoring
   messages included):

   - If `config.liveRoleId` is set and the role isn't found in the guild,
     warn once (console + monitoring), matching the fallback-role-missing
     handling.
   - If `isLive` and the member lacks the role, add it (`"Started
     streaming"` reason).
   - If not `isLive` and the member has the role, remove it (`"Stopped
     streaming"` reason).

No other files change: `cleanup.js`'s empty-role auto-deletion, `panel.js`,
and `promotion.js` only ever act on `roleMap`/`autoManaged` entries or
`vipRoleId`/`fallbackRoleId` specifically — `liveRoleId` is never added to
`roleMap`/`autoManaged`, so it's automatically excluded from that
machinery, the same way `vipRoleId` already is.

### Example

Member starts streaming Tarkov to Twitch:

- `Playing Escape from Tarkov` (`type: 0`) → resolves via
  `activityRoleMap`/`premadeRoleIds` as today → "Playing Tarkov" role.
- `Twitch` (`type: 1`) → skipped from name-based resolution, contributes
  only to `isLive = true` → member also gets "LIVE".

Member stops streaming but keeps playing Tarkov: LIVE is removed, "Playing
Tarkov" is untouched.

Member watches an embedded Twitch stream (`type: 3`, name `"Twitch"`):
resolves via `premadeRoleIds["Twitch"]` as today → "Watching Twitch" role,
unaffected by this change.

## Testing

- Unit test around `handlePresence` (or a focused helper) covering:
  - Streaming activity alone → LIVE added, no name-based role created.
  - Streaming + Playing activity together → both LIVE and the Playing
    role added.
  - Streaming activity stops → LIVE removed, other roles untouched.
  - Watching-type activity named "Twitch" → still resolves to the
    existing premade "Watching Twitch" role, LIVE not granted.
  - `liveRoleId` unset → feature is a no-op (no errors, no role churn).
