# Debug & Fix `!stats` PNG Always Falling Back to Embed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the `!stats` / `/stats` PNG render. Currently the embed fallback fires every time. Find the actual error before touching code, then fix the root cause.

**Architecture:** Evidence-first. The existing 10.1.0 code already logs the caught error to console and pings the monitoring channel with `err.message` ([src/stats.js:180-181](src/stats.js:180)). Step 1 is read that, not guess. Only if the existing log is insufficient do we add more instrumentation. Only after we know the failure mode do we propose a fix.

**Tech Stack:** Node 20 on Fly.io, `discord.js` v14, `@napi-rs/canvas`, prefix + slash command adapter in [src/commands.js](src/commands.js).

**Iron Law:** No fix is proposed in this plan until Task 1 or Task 2 produces a concrete error string. If a task here says "fix X," it's gated on evidence from an earlier task.

---

## Hypotheses (ranked, for orientation only — DO NOT pre-fix)

These are what the evidence might show. They are NOT a fix list. The reason to enumerate them is so we recognize the evidence when we see it.

1. **Upload timeout.** Error message: `upload-timeout:reply after 12000ms`. Multipart upload to Discord stalls. Likely if `!playing` (smaller payload, fewer rows) succeeds but `!stats` (10 rows + icons) stalls.
2. **Interaction state mismatch.** Error like `InteractionAlreadyReplied` or `Unknown interaction`. `statsCmd` calls `ctx.defer()` then `sendImage` → `ctx.reply` → `interaction.editReply` (correct path per [src/commands.js:39-43](src/commands.js:39)). If editReply with `files` doesn't behave the same as `reply` with `files`, this could surface.
3. **Render throws.** Error originates inside `renderUsersDefault`. Most likely candidate I spotted while reading: `buildUserMembers` returns `topGame` as a string (`g?.topKey`, [src/stats.js:140](src/stats.js:140)) but the renderer reads `.key` / `.minutes` off it ([src/stats-image.js:158](src/stats-image.js:158), `:224`). This produces `undefined`/`NaN` text but does **not** throw, so probably not the cause — included only so we don't get distracted by it.
4. **Role-icon load hangs/throws.** `loadImage(url)` against Discord CDN. Failures are caught inside `loadRoleIconCached` so this would only surface as a hang, not a throw — and a hang inside render would not trigger the catch block, so this also doesn't match the "fallback always fires" symptom. Listed for completeness.
5. **Payload shape rejected.** Discord 400 on the attachment — bad filename, invalid bytes, etc. Would surface as a `DiscordAPIError`.

---

## Task 1: Read the evidence we already have

**Files:** none (read-only)

- [ ] **Step 1: Pull recent Fly logs and grep for the stats failure line**

Run from project root (PowerShell):

```powershell
fly logs --app wavwrld-role-bot | Select-String -Pattern "\[stats\] PNG path failed" -Context 2,5
```

Expected: zero or more lines of the form `[stats] PNG path failed (<MESSAGE>); falling back to embed`. The `<MESSAGE>` is the entire point of this task.

If the log buffer doesn't cover a recent `!stats` invocation, ask the user to run `!stats` in the server once, wait ~10 seconds, then re-run the command above.

- [ ] **Step 2: Check the Discord monitoring channel**

Ask the user to scroll the monitoring channel (the one `sendMonitoring` posts to — see [src/monitoring.js](src/monitoring.js)) for messages matching `⚠️ /stats PNG fallback to embed in ...`. Each one contains the same `err.message` as the log line.

- [ ] **Step 3: Record the actual error message**

Write down — literally, character-for-character — the `err.message` value. Examples of what we might see:
- `upload-timeout:reply after 12000ms`
- `Interaction has already been replied to.`
- `Cannot read properties of undefined (reading 'key')`
- `DiscordAPIError[50035]: Invalid Form Body`
- `Unknown interaction`

- [ ] **Step 4: Decide branch**

Compare against the hypothesis list above. If the error clearly matches one, **skip Task 2** and jump straight to the matching Task in the "Fix Branches" section (Task 3a/3b/3c/3d/3e).

If the error is something we didn't enumerate, or if no log line exists at all (meaning we don't know whether the catch is even firing), proceed to Task 2.

- [ ] **Step 5: Commit**

Nothing to commit. This task is read-only.

---

## Task 2: Add fine-grained instrumentation (only if Task 1 inconclusive)

**Skip this task entirely if Task 1 produced a clear error.**

**Files:**
- Modify: `src/stats.js:148-190` (`runUsersView`)
- Modify: `src/stats.js:31-41` (`sendImage`) — add stage tagging

**Goal:** Distinguish render-failure from upload-failure from interaction-failure in the logs.

- [ ] **Step 1: Wrap each phase with timing + tagged errors**

Edit `runUsersView` in [src/stats.js](src/stats.js) so the `try` body looks like this:

```js
  // Try PNG first; fall back to the embed if rendering or uploading fails.
  const t0 = Date.now();
  let stage = "init";
  try {
    stage = "render";
    const { renderUsersDefault } = require("./stats-image");
    const buffer = await renderUsersDefault({
      guildName: guild.name,
      title,
      lookbackLabel,
      totals,
      members,
      guild,
      roleByGameKey: (key) => roleForGameKey(guild, key),
    });
    const renderMs = Date.now() - t0;
    console.log(`[stats] render ok in ${renderMs}ms, buffer=${buffer.length} bytes`);

    stage = "upload";
    const tUpload = Date.now();
    const result = await sendImage(ctx, buffer, "stats-members.png");
    console.log(`[stats] upload ok in ${Date.now() - tUpload}ms`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.warn(`[stats] PNG path failed at stage=${stage} after ${elapsed}ms: ${err?.name || "Error"}: ${err?.message}`);
    if (err?.stack) console.warn(err.stack);
    sendMonitoring(`⚠️ /stats PNG fallback (stage=${stage}, ${elapsed}ms) in **${guild.name}**: ${err?.name || "Error"}: ${err?.message}`).catch(() => {});
    const embed = buildStatsEmbed(guild, members, totals, { title, lookbackLabel });
    try {
      return await ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch {
      try { return await ctx.followUp({ embeds: [embed], allowedMentions: { parse: [] } }); } catch {}
      if (ctx.channel) return ctx.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    }
  }
```

This gives us four data points the existing code does not:
- Whether we even reach the upload stage (`stage=render` vs `stage=upload`).
- How long render took.
- Buffer size (to rule out a giant payload).
- The error name and stack, not just the message.

- [ ] **Step 2: Commit and deploy**

```powershell
git add src/stats.js
git commit -m "stats: per-stage timing + error tagging for PNG path"
fly deploy --remote-only --strategy immediate
```

Expected: deploy succeeds, machine restarts, version bump is **not** required (this is a debug build, not a release).

- [ ] **Step 3: Trigger and observe**

Ask user to run `!stats` once. Then:

```powershell
fly logs --app wavwrld-role-bot | Select-String -Pattern "\[stats\]" -Context 0,3
```

Look for the new lines. Capture:
- The `stage=` value at failure
- The elapsed ms
- The `err.name`
- The full message
- Stack frame pointing into our code or into `discord.js` / `undici`

- [ ] **Step 4: Pick a fix branch**

Map the evidence to a branch below. If render is OK and upload fails near 12000ms → Task 3a. If render throws → Task 3c. If interaction error from upload → Task 3b. If Discord rejects payload → Task 3d. If something else → Task 3e (escalate, do not guess).

---

## Fix Branches — pick exactly one based on evidence

Each branch is self-contained. Only execute the one that the evidence supports. If two seem to apply, the evidence is ambiguous — return to Task 2 and gather more.

### Task 3a: Fix — upload genuinely times out

**Evidence required:** error message contains `upload-timeout:reply` AND `stage=upload`.

**Files:**
- Modify: `src/stats.js:13` (`UPLOAD_TIMEOUT_MS`)
- Modify: `src/stats.js:31-41` (`sendImage`)

**Why this isn't just "raise the timeout":** the 10.1.1 hot-fix added the 12 s timeout specifically because `ctx.reply` was wedging the bot — an indefinite wait queued every subsequent command. The previous "retry via followUp" path was worse: it could also wedge. The right fix here is to (a) keep a hard ceiling so the bot never freezes, (b) switch the upload off the interaction-bound `ctx.reply` to `ctx.channel.send`, which doesn't carry interaction state and doesn't tie up the slash-command token.

- [ ] **Step 1: Route uploads through the channel, not the interaction**

Replace `sendImage` in [src/stats.js:31-41](src/stats.js:31) with:

```js
async function sendImage(ctx, buffer, name) {
  const payload = {
    files: [new AttachmentBuilder(buffer, { name })],
    allowedMentions: { parse: [] },
  };
  // Send via the channel rather than ctx.reply so the upload isn't bound to
  // the interaction token. If the channel send stalls, the timeout still
  // protects us; if it succeeds, we tidy the deferred interaction with a
  // short ack so Discord doesn't show "thinking..." forever.
  const sendPromise = ctx.channel
    ? ctx.channel.send(payload)
    : ctx.reply(payload);
  const result = await withUploadTimeout(Promise.resolve(sendPromise), "send");

  // Best-effort tidy of the deferred slash-command reply.
  if (ctx.type === "interaction") {
    ctx.reply({ content: "📊 Stats above ⬆️", allowedMentions: { parse: [] } }).catch(() => {});
  }
  return result;
}
```

- [ ] **Step 2: Raise the timeout modestly**

Edit [src/stats.js:13](src/stats.js:13):

```js
const UPLOAD_TIMEOUT_MS = 20_000;
```

20 s gives a slow upload more headroom but still bounds wedge risk. Do NOT raise it higher — the original symptom was the bot freezing on stuck uploads.

- [ ] **Step 3: Run the bot locally and confirm it loads**

```powershell
node src/index.js
```

Expected: bot logs in successfully, no syntax errors. Ctrl+C after ~5 seconds.

- [ ] **Step 4: Commit, version bump, deploy**

Bump `package.json` to `10.1.2`. Add a `## 10.1.2` entry to README. Then:

```powershell
git add src/stats.js package.json README.md
git commit -m "Release 10.1.2: stats PNG sent via channel.send, 20s ceiling"
git tag v10.1.2
git push origin main --tags
fly deploy --remote-only
```

- [ ] **Step 5: Verify in Discord**

Ask user to run `!stats`. Expected: PNG appears, no fallback message in monitoring.

---

### Task 3b: Fix — interaction state mismatch

**Evidence required:** error name is `DiscordAPIError` with code matching `InteractionAlreadyReplied`, or message contains `Unknown interaction` / `Interaction has already been replied to`.

**Files:**
- Modify: `src/stats.js:31-41` (`sendImage`)

**Root cause hypothesis:** `editReply` with `files` requires the same flags (`ephemeral`, etc.) as the original `deferReply`, or the deferred interaction has timed out (3 s window for `deferReply` ack, 15 min for the followup). If render is slow enough to blow the 15-minute followup window, `editReply` fails.

- [ ] **Step 1: Confirm token timing**

Re-read the failing log line. If elapsed at failure is < 900_000 ms (15 min), the token has not expired and the cause must be flag mismatch or duplicate reply. If > 900_000 ms, expiry is the cause. In either case, the fix is the same: send via channel.

- [ ] **Step 2: Apply the channel-send fix from Task 3a Step 1**

Same edit as Task 3a Step 1 (route through `ctx.channel.send`). The interaction token then plays no role in the file upload.

- [ ] **Step 3: Commit, version bump, deploy, verify**

Same as Task 3a Steps 3-5 with commit message `Release 10.1.2: stats PNG via channel send to avoid interaction reply conflict`.

---

### Task 3c: Fix — render throws

**Evidence required:** failure log shows `stage=render` and an error name like `TypeError` from inside `renderUsersDefault`.

**Files:**
- Modify: `src/stats.js:126-146` (`buildUserMembers`)
- Modify: `src/stats-image.js:158`, `:223-224` if the error points there

**Likely culprit:** `topGame` shape mismatch. `buildUserMembers` returns `topGame` as a string (the game key) but `renderUsersDefault` reads `.key` and `.minutes` off it. Today this produces garbage labels rather than a throw, but if the data shape from `tracker.userTotals` changed and `g.topKey` is now an object, the access pattern flips and one side breaks.

- [ ] **Step 1: Make `buildUserMembers` produce an object**

Edit `buildUserMembers` in [src/stats.js:126-146](src/stats.js:126). Replace the return shape:

```js
    .map((userId) => {
      const v = voice.find((r) => r.userId === userId);
      const g = gamesByUser.get(userId);
      return {
        userId,
        displayName: displayNameFor(guild, userId),
        voiceMinutes: v?.minutes || 0,
        gameMinutes: g?.minutes || 0,
        topGame: g?.topKey
          ? { key: g.topKey, minutes: g.topMinutes ?? g.minutes ?? 0 }
          : null,
      };
    })
```

Verify by reading [src/tracker.js](src/tracker.js) (not pre-listed here — read it during this task) for the exact field name of the top-game minutes value on a `userTotals` row. If it's not `topMinutes` or `minutes`, adjust the right-hand side accordingly. If the tracker doesn't expose top-game minutes per user, the renderer cannot show them and we need to either change the renderer's label format or extend the tracker — flag this to the user before continuing.

- [ ] **Step 2: Update the embed builder to match**

In [src/stats.js:75-81](src/stats.js:75) (`topGameLabel`), `topGame.key` and `topGame.minutes` are already accessed as object fields — confirm by re-reading. If the embed code already treats `topGame` as an object, Task 3c Step 1 unifies the two sites; no further embed change needed.

- [ ] **Step 3: Run locally**

```powershell
node src/index.js
```

Expected: clean startup.

- [ ] **Step 4: Commit, version bump, deploy, verify**

Bump to `10.1.2`, message `Release 10.1.2: fix stats topGame shape so render no longer throws`. Same git + fly steps as Task 3a Steps 4-5.

---

### Task 3d: Fix — Discord rejects the payload

**Evidence required:** error name is `DiscordAPIError`, code in the 50000s, often `50035 Invalid Form Body`. Message will mention the offending field.

**Files:** depends on rejection — most likely `src/stats-image.js` (filename or buffer) or `src/stats.js:31-41` (`AttachmentBuilder` args).

- [ ] **Step 1: Read the full rejection message**

`DiscordAPIError[50035]` carries a JSON path to the bad field. From the message, identify whether the rejection targets `files`, `attachments`, `embeds`, or something else.

- [ ] **Step 2: Reproduce the buffer locally**

Add a one-shot script (do not commit):

```powershell
node -e "const {createCanvas}=require('@napi-rs/canvas');const c=createCanvas(720,800);require('fs').writeFileSync('/tmp/x.png',c.toBuffer('image/png'));console.log('wrote', require('fs').statSync('/tmp/x.png').size)"
```

Confirm bytes look like a PNG (`file /tmp/x.png` if available; otherwise check the first 8 bytes are `89 50 4E 47 0D 0A 1A 0A`).

- [ ] **Step 3: Apply the minimal targeted fix**

Whatever the rejection says — rename the attachment to ASCII-only if name is the problem, drop `embeds: []` from the file send if mixing is the problem, etc. **Do not bundle other changes.**

- [ ] **Step 4: Commit, version bump, deploy, verify**

Same as Task 3a Steps 4-5.

---

### Task 3e: Escalate — evidence doesn't match any branch

**Evidence required:** Task 1/Task 2 produced an error string that does not match Tasks 3a-3d.

- [ ] **Step 1: Stop and report**

Do not propose a fix. Write a one-paragraph summary in the conversation containing:
- The exact `err.name` + `err.message` + first 3 stack frames
- The stage and elapsed time
- Buffer size if render completed
- What hypothesis from the top of this plan, if any, comes closest

- [ ] **Step 2: Wait for direction**

Ask the user how they'd like to proceed. Do not start a new fix branch without their go-ahead.

---

## Task 4: Clean up debug instrumentation (only if Task 2 ran)

**Skip if Task 2 was not executed.**

**Files:**
- Modify: `src/stats.js` — `runUsersView`

- [ ] **Step 1: Keep what's useful, drop what's noisy**

Keep:
- The `stage=` tag in the warn line and monitoring ping. It's small and saves a future debugging session.
- The `err.name` and elapsed time in the warn line.

Drop:
- The `console.log` lines on the happy path (`render ok`, `upload ok`) — these spam the logs in normal operation.
- The full stack dump (only useful when actively debugging).

- [ ] **Step 2: Commit**

```powershell
git add src/stats.js
git commit -m "stats: trim PNG-path debug logging, keep stage/error tagging"
git push origin main
fly deploy --remote-only
```

No version bump — this is log cleanup, not behavior change.

---

## Verification Checklist

After whichever fix lands:

- [ ] User runs `!stats` and sees the PNG (not the embed).
- [ ] User runs `/stats` (slash) and sees the PNG.
- [ ] User runs `!leaderboard` and `!lb` and sees the PNG.
- [ ] No `⚠️ /stats PNG fallback` messages appear in the monitoring channel for ~5 minutes after deploy.
- [ ] `!playing` still works (regression check — same upload path).
- [ ] Bot does not freeze on subsequent commands (the original 10.1 symptom that 10.1.1 was hot-fixing).
- [ ] `fly status --app wavwrld-role-bot` shows the machine healthy on the new release.

## Out of Scope

These are tempting "while we're here" changes. Do NOT include them in this fix:

- Migrating the stats channel live-activity message to an updating image (separate work, gated on stats PNG being reliable).
- Refactoring `sendImage` to be shared between `statsCmd` and `playingCmd` (it already is — both call the same function).
- Adding new metrics to the PNG (different feature).
- Tuning canvas font registration / system font setup.
