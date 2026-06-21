# All Activities Show With Times — Design

**Date:** 2026-06-20
**Status:** Spec, pending user review
**Author:** brainstormed with Cody

## Goal

Make the live activity panel (web UI at `/`, JSON at `/api/activity`, and by
extension the desktop console which polls the same endpoint) show **every**
activity in the guild with an accurate elapsed-time readout — not just the
ones that happen to have a Discord role configured.

Today, activities without a premade or auto-created role appear as
*synthetic rows* in `collectSyntheticRows` ([src/panel.js:29](../../../src/panel.js:29))
with `timeStr: ""` and `minutes: 0`. The screenshot the user shared shows the
target state: Tarkov, Forza Horizon 6, Fortnite, R6 all listed under
**Playing** with proper times (`1h32m`, `5h46m`, etc.), Spotify under
**Listening** with `6m`, WAVLINK voice with `1h52m`.

## Non-goals

- **Touching `onlyUsePremadeRoles`.** This config flag stays `true`. The bot
  does not start creating Discord roles for every random game — the whole
  reason the flag was added stays intact.
- **Voice synthetic rows.** Voice channels without a managed role are rare
  and we have no per-member voice-join timestamp to derive elapsed from.
  They stay blank-timed for this iteration.
- **Stats-channel JPEG redesign.** User explicitly deferred — comes after
  this lands.
- **Tracker schema changes / new types.** TYPES stays `["game", "voice"]`.
  Listening / Watching / Other do not get persisted entries.
- **A new HTTP endpoint or snapshot shape change.** `/api/activity` returns
  the same JSON shape; only the values inside synthetic rows change.

## How activity-with-time information flows today

```
Discord Gateway presence update
        │
        ▼
src/events.js → handlePresence()
        │
        ▼
src/presence.js handlePresence()
        │  for each activity in presence.activities:
        │    • blacklist check
        │    • hasActivityConfig? → recordUnknownActivity()
        │    • activity.type !== 0 && !hasConfig → continue   ◄── drops listening/watching/etc.
        │    • premade role exists? → assign role + tracker.observePresence
        │    • else if onlyUsePremadeRoles → continue          ◄── drops unmatched games
        │    • else → create role + assign + tracker.observePresence
        │
        ▼
src/tracker.js openSessions[guildId][type|key|subjectId]
        │
        ▼ (read path)
src/stats-channel.js collectRows(guild)
        │  walks roleMap[guildId], joins with tracker.activeElapsedMinutes
        │  ──► rows with times
        │
        ▼
src/panel.js buildSnapshot()
        │  calls collectRows + collectSyntheticRows
        │  collectSyntheticRows walks guild.presences.cache to fill in
        │  anything collectRows missed, with timeStr: "", minutes: 0
        │  ──► merged sections returned to /api/activity
```

The gap: synthetic rows have no time source because the tracker never
saw the activity.

## Change set

### Change 1 — `src/presence.js` observes more activities

Two edits inside `handlePresence`.

**1a. Skip non-game activity types early in the loop.** They will be handled
live by the panel and should not influence role assignment, fallback role,
or auto-cleanup logic.

```js
// Discord ActivityType: 0 Playing, 1 Streaming, 2 Listening, 3 Watching,
// 4 Custom, 5 Competing. Custom is already rejected upstream by the type-4
// guard in recordUnknownActivity / shouldRecordUnknownActivity. We treat
// 0/1/5 as "game-like" for tracking purposes.
const TRACKABLE_GAME_TYPES = new Set([0, 1, 5]);
```

Replace the existing line:

```js
if (activity.type !== 0 && !hasConfig) continue;
```

with:

```js
if (!TRACKABLE_GAME_TYPES.has(activity.type)) continue;
```

This drops Listening (2) and Watching (3) out of the role-assignment +
tracker path entirely. They will get times in the panel via `createdTimestamp`
arithmetic (see Change 2).

> **Note on `hasConfig`.** The old guard let activity types other than 0
> *through* if they had explicit config (e.g. an `activityRoleMap` entry for
> a Listening activity). That was theoretical — no current config relies on
> it. If we ever need it back we add an explicit allow-list to the config
> schema; not in scope here.
>
> **Note on type 1 / 5 reaching fallback logic.** Before this change, only
> type 0 (Playing) without config could reach the `else if (onlyUsePremadeRoles)`
> branch that flips `hasUnmatchedActivity = true` and ultimately assigns the
> fallback role. After this change, types 1 (Streaming) and 5 (Competing)
> reach it too. That's the correct behavior — someone streaming an unknown
> game should be "Active" same as someone playing one — but it's a small
> visible behavior change worth knowing about.

**1b. Track unmatched game activities by raw `activity.name`.** Where the
loop currently bails on unmatched games:

```js
} else if (onlyUsePremadeRoles) {
  hasUnmatchedActivity = true;
  continue;
}
```

Change to:

```js
} else if (onlyUsePremadeRoles) {
  hasUnmatchedActivity = true;
  tracker.observePresence(guildId, "game", activity.name, member.id);
  currentTargetRoleNames.add(activity.name);
  continue;
}
```

Rationale for `currentTargetRoleNames.add`: that set is used later in the
function to decide which auto-managed roles to remove from this member.
Raw activity names are not in `autoManaged[guildId]`, so they would never
be removed anyway — but adding them keeps the semantics tight: anything
this member is currently doing that we care about is in the set.

**1c. Close raw-name sessions when the activity stops.** The existing
cleanup loop walks `autoManaged[guildId]` and calls `observeAbsence` when
a role-managed activity stops. Raw-name sessions are not in `autoManaged`,
so they need their own close path. After the existing cleanup loop, add:

```js
// Close any raw-name sessions for this member that aren't in the current
// activity set. Symmetric to the autoManaged cleanup above, but for the
// no-role tracking path added in this change.
for (const open of Object.values(openSessions[guildId] || {})) {
  if (open.type !== "game") continue;
  if (open.subjectId !== member.id) continue;
  if (currentTargetRoleNames.has(open.key)) continue;
  // Skip role-managed keys — those are owned by the autoManaged sweep.
  if (autoManaged[guildId].has(open.key)) continue;
  tracker.observeAbsence(guildId, "game", open.key, member.id);
}
```

`openSessions` is already imported indirectly via `tracker`; we will need
to expose it on the tracker module (or expose a helper like
`tracker.closeStaleSessions(guildId, memberId, keepKeys, ignoreKeys)`) to
keep the abstraction. Implementation chooses one — both are fine.

### Change 2 — `src/panel.js` `collectSyntheticRows` populates times

After the bucket-collection loop, when collapsing buckets into result rows
(currently the loop at [src/panel.js:99](../../../src/panel.js:99)),
compute times per row:

```js
for (const { section, display, members } of buckets.values()) {
  // ── existing dedup + sort of uniqueMembers ──

  let minutes = 0;
  let timeStr = "—";

  if (section === "playing") {
    // Raw-name sessions are now flowing into the tracker — query by name.
    const memberIds = uniqueMembers.map((m) => m.id);
    minutes = tracker.activeElapsedMinutes(guild.id, "game", display, memberIds);
    if (minutes > 0) timeStr = formatTimerMinutes(minutes);
  } else if (section === "listening" || section === "watching" || section === "other") {
    // No tracker persistence for these — compute live from sinceTs.
    minutes = liveElapsedMinutes(uniqueMembers);
    if (minutes > 0) timeStr = formatTimerMinutes(minutes);
  }
  // voice synthetic rows stay timeless

  result[section].push({
    display,
    timeStr,
    minutes,
    count: uniqueMembers.length,
    memberNames: uniqueMembers.map((m) => m.displayName),
    members: uniqueMembers,
    synthetic: true,
  });
}
```

Where `liveElapsedMinutes` is a tiny helper local to panel.js:

```js
function liveElapsedMinutes(members) {
  let max = 0;
  for (const m of members) {
    if (!m.sinceTs) continue;
    const minutes = Math.floor((Date.now() - m.sinceTs) / 60_000);
    if (minutes > max) max = minutes;
  }
  return max;
}
```

`tracker` and `formatTimerMinutes` need to be imported at the top of
panel.js.

### Sort impact

`collectSyntheticRows` already sorts each section by `count desc, display
asc`. `buildSnapshot` does NOT re-sort the merged tracked+synthetic rows.
Today that's fine because synthetic rows all have `minutes: 0` and look
identical. After this change, synthetic playing rows have real minutes and
may want to be interleaved with tracked rows by time.

**Decision:** sort each section in `buildSnapshot` after merging:

```js
rows: [...tracked, ...synthetic].sort(
  (a, b) => b.minutes - a.minutes || a.display.localeCompare(b.display)
),
```

Matches the existing sort in `collectRows`.

## Downstream effects (intended)

- **`!stats` JPEG + leaderboards** automatically include the new raw-name
  entries because they land in `playtime[guildId].game`. This is the
  behavior the user picked (option A: include all games in stats).
- **History snapshots** (`snapshotBucket` in tracker.js) include them too —
  same code path.
- **Desktop console** picks up the new times with no client-side change;
  it polls the same `/api/activity` endpoint and renders whatever rows
  come back.

## Downstream effects (unintended — and why they're fine)

- **Tracker key namespace becomes mixed.** `playtime.game` now contains
  `"Playing Tarkov"` (from the role-driven path) alongside `"Forza Horizon 6"`
  (from the new raw-name path). They're different keys, no double-count.
  Cosmetic only.
- **Unknown activity inbox.** `recordUnknownActivity` ([src/unknown.js:12](../../../src/unknown.js:12))
  already runs before the tracker calls and is unaffected. Activities the
  inbox flags as suggestions will now also be tracked — that's correct;
  the suggestion is just for "consider adding a role for this", not "we
  aren't tracking it."
- **Promotion logic.** Untouched. Raw-name sessions never create roles, so
  there's nothing to promote.
- **Fallback role logic.** Untouched. The `hasUnmatchedActivity` flag still
  governs fallback-role add/remove the same way.

## Files touched

- `src/presence.js` — Changes 1a, 1b, 1c.
- `src/panel.js` — Change 2 (imports + `collectSyntheticRows` body + sort
  in `buildSnapshot`).
- `src/tracker.js` — only if we choose to expose a `closeStaleSessions`
  helper rather than expose `openSessions` directly from the panel-side
  cleanup. Implementation choice during the plan.
- `tests/panel.test.js` — extend coverage for synthetic rows with times.
- `README.md` — changelog entry for the next version.
- `package.json` — version bump (next minor).

## Test plan

- Unit: `collectSyntheticRows` returns `minutes > 0` and a formatted
  `timeStr` for a playing-section synthetic row when the tracker has an
  open session for that activity name and the member.
- Unit: `collectSyntheticRows` returns live-computed `minutes` for a
  listening synthetic row given a member with `sinceTs = Date.now() - 10min`.
- Unit: `collectSyntheticRows` leaves voice synthetic rows blank
  (`minutes: 0`, `timeStr: "—"`).
- Unit: `handlePresence` opens a tracker session keyed by raw activity
  name when `onlyUsePremadeRoles=true` and no premade role is configured
  for the activity.
- Unit: `handlePresence` closes a raw-name session when the activity
  drops out of `presence.activities` on the next update.
- Manual: deploy to Fly, load `/` with PANEL_TOKEN, confirm Forza Horizon
  6 (or whatever is currently being played by a member with no premade
  role) shows a non-zero time and grows on refresh.

## Open implementation questions (resolved during plan)

1. Expose `openSessions` from tracker.js or add a `closeStaleSessions`
   helper? Both work; pick during the plan.
2. Is there a need to gate the new tracking behind a flag for safety
   during rollout, or just ship? Likely just ship — failure mode is
   "panel times still blank," same as today.
