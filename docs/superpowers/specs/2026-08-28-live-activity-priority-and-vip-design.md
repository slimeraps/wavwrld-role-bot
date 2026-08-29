# Live Activity ranking: participant priority, away filtering, VIP top spot

## Problem

The Live Activity image (the auto-updating "currently happening" embed in
`#stats`, served from `/live/<guildId>.jpg`) has three ranking/visibility
gaps:

1. **No priority for multi-user activities.** Rows are ranked purely by
   combined elapsed minutes. A single member's long solo session can
   outrank a game two or three people just started playing together,
   even though the multi-person activity is more interesting to surface.
2. **Idle ("away") members still show up.** `presence.js` already strips
   a member's game/listening/watching role when their status goes idle
   (treating idle as "no activities" for role-management purposes), but:
   - That's an async side effect of a Discord event handler — nothing
     guarantees the role is actually gone by the time the image renders.
   - `collectSyntheticRows` (the fallback path for raw/untracked
     activities) reads `guild.presences.cache` directly with no idle
     check at all, so untracked activities leak idle members into the
     image unconditionally.
3. **No VIP prioritization.** `config.vipRoleId` already exists and is
   used elsewhere (music command gating, role-list promotion in
   `promotion.js`), but has no effect on Live Activity ranking. An active
   VIP's activity should get a top spot.

## Scope

This only touches the **Live Activity** image pipeline:
`collectRows` / `collectSyntheticRows` / `buildLiveActivitySnapshot` in
[src/stats-channel.js](../../../src/stats-channel.js), consumed by
`renderLiveActivity` in [src/stats-image.js](../../../src/stats-image.js)
via the `/live/<id>.jpg` panel route.

**Out of scope:** the `!stats` 30-day leaderboard image
(`renderUsersDefault`, fed by `buildUserMembers`/`buildStatsTotals`).
That image ranks individual accumulated playtime, not concurrent
activity groups — "more than one user on an activity" and "away" don't
apply to it, and it is not touched by this change.

**Side effect (accepted):** `collectRows`/`collectSyntheticRows` are also
used by `panel.js`'s `buildSnapshot`/`buildActiveSection`, which back the
desktop-console/monitoring HTML panel (not a Discord image). Because the
idle filter lives at the data-collection layer, that panel will also stop
listing idle members under Playing/Listening/Watching. Its own row sort
(`buildSnapshot`'s `.sort((a,b) => b.minutes - a.minutes || ...)`) is
*not* changed — no participant-count-first or VIP-boost logic is added
there, since this change is scoped to the stats images.

## Design

### 1. Away (idle) filtering — games/listening/watching/other, not voice

Discord's Idle status is the definition of "away" for this feature. Voice
channel membership stays exempt (being connected is a physical fact
regardless of status — this matches the existing exclusion of voice roles
from `presence.js`'s idle role-stripping).

- **`collectRows`** (tracked, role-based rows): for any section other than
  `"voice"`, filter `role.members` to exclude members whose
  `presence?.status === "idle"` before building the row (in addition to
  the existing bot filter). This is a defensive/authoritative filter —
  it doesn't rely on `presence.js`'s role removal having already fired.
  A member with unknown/no cached presence is treated as not-idle (fail
  open, matching current behavior).
- **`collectSyntheticRows`** (untracked/raw activity rows): skip idle
  presences entirely before the `presence.activities` loop. This is the
  actual gap fix — today this loop has no idle check at all. The
  voice-state loop (which builds synthetic voice rows) is untouched.
- If filtering drops a row's member list to zero, the row is omitted, the
  same as the existing empty-row handling.

### 2. Ranking — participant count first, then time

In `buildLiveActivitySnapshot`'s per-section merge sort (currently
`b.minutes - a.minutes || a.display.localeCompare(b.display)`), change
the comparator to:

```
participant count desc → minutes desc → display asc
```

using `row.members.length` (falling back to `row.count`) as the
participant count. Applied uniformly to every section — Playing, Voice,
Listening, Watching, Other — so a 2-person voice channel or game always
outranks a 1-person one, regardless of duration. This is the sole
authoritative sort for the image: it determines both which rows land in
the top-5 tile row per section and which spill into the "ALSO HAPPENING"
overflow panel, since the renderer just slices/consumes the already-sorted
`section.rows` array.

The per-section pre-sorts inside `collectRows` and `collectSyntheticRows`
are cosmetic (their output is always re-sorted by the merge step above)
and are left as-is.

### 3. VIP gets a top spot

Add a VIP check ahead of the count comparator:

```
has active VIP desc → participant count desc → minutes desc → display asc
```

"Has active VIP" = at least one member in `row.members` currently holds
`config.vipRoleId` (checked via `guild.members.cache.get(id)`). If
`config.vipRoleId` is unset (empty string, as it is by default), the
check always evaluates false for every row and ranking is identical to
count+time — fully backward compatible.

No visual badge or accent color is added to VIP rows — sort order is the
only effect, per the approved design.

Because idle members are filtered out of Playing/Listening/Watching/Other
*before* this check runs (see §1), an idle VIP will not trigger the boost
in those sections — satisfying "if they are active." Voice stays exempt
from idle filtering (per §1's scope decision), so a VIP connected to
voice while idle still counts as active for the voice-row boost, matching
voice's existing "connected = active" treatment elsewhere in this
codebase.

## Testing

Extend the existing unit suites (`tests/stats-channel.test.js`,
`tests/panel.test.js`) which already cover `collectRows`,
`collectSyntheticRows`, and `buildLiveActivitySnapshot` shapes, with
cases for:

- An idle member's tracked role is excluded from a non-voice row's
  `members`/`count` (and the row is dropped entirely if idle was the
  only member).
- An idle member's raw/untracked presence activity does not produce a
  synthetic row entry.
- An idle member remains present in a voice-channel row.
- A 1-person, long-duration row ranks below a 2-person, short-duration
  row in the same section.
- A row containing a VIP member ranks above all non-VIP rows in the same
  section regardless of count/time; two VIP rows fall back to
  count-then-time ordering.
- With `config.vipRoleId` unset, ranking is unaffected (identical to
  count+time only).
