const http = require("http");
const crypto = require("crypto");
const { collectRows, buildLiveActivitySnapshot } = require("./stats-channel");
const { buildUserMembers, buildStatsTotals, roleForGameKey } = require("./stats");
const { renderUsersDefault, renderLiveActivity } = require("./stats-image");
const { config } = require("./config");

// ── ActivityType constants (discord.js 14 / Discord API) ──────────────────
// 0 Playing, 1 Streaming, 2 Listening, 3 Watching, 4 Custom, 5 Competing
const ACTIVITY_SECTION = {
  0: "playing",   // Playing
  1: "playing",   // Streaming → fold into playing
  2: "listening", // Listening
  3: "watching",  // Watching
  // 4 Custom status — skipped entirely
  5: "other",     // Competing
};

/**
 * Build synthetic rows from live Discord presence/voice state for activities
 * that are NOT already represented by a tracked row from collectRows.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{ [section: string]: Array<{ display: string }> }} trackedRows
 *   The rows object returned by collectRows — used for deduplication.
 * @returns {{ [section: string]: Array<object> }}
 *   An object with the same section keys, each an array of synthetic rows.
 */
function collectSyntheticRows(guild, trackedRows) {
  // Build a set of (section, display-lowercase) pairs already covered by
  // tracked rows so we can skip duplicates.
  const tracked = new Set();
  for (const [section, rows] of Object.entries(trackedRows)) {
    for (const r of rows) {
      tracked.add(`${section}\0${r.display.toLowerCase()}`);
    }
  }

  // Accumulate per (section, displayLower) → { display, members: [...] }
  // We keep the first-seen display casing.
  const buckets = new Map(); // key → { section, display, members: [{id, displayName, sinceTs}] }

  // ── presence activities ─────────────────────────────────────────────────
  for (const presence of guild.presences.cache.values()) {
    const member = presence.member;
    if (!member || member.user?.bot) continue;

    for (const activity of presence.activities || []) {
      const section = ACTIVITY_SECTION[activity.type];
      if (!section) continue; // type 4 (Custom) or unknown — skip

      const display = activity.name;
      if (!display) continue;

      const displayLower = display.toLowerCase();
      const trackedKey = `${section}\0${displayLower}`;
      if (tracked.has(trackedKey)) continue; // suppressed by a tracked row

      const bucketKey = `${section}\0${displayLower}`;
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { section, display, members: [] });
      }
      buckets.get(bucketKey).members.push({
        id: member.id,
        displayName: member.displayName || member.user?.username || member.id,
        sinceTs: activity.createdTimestamp ?? null,
      });
    }
  }

  // ── voice states ────────────────────────────────────────────────────────
  for (const vs of guild.voiceStates.cache.values()) {
    const member = vs.member;
    if (!member || member.user?.bot) continue;
    const channel = vs.channel;
    if (!channel) continue;

    const section = "voice";
    const display = channel.name;
    const displayLower = display.toLowerCase();

    const trackedKey = `${section}\0${displayLower}`;
    if (tracked.has(trackedKey)) continue;

    const bucketKey = `${section}\0${displayLower}`;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { section, display, members: [] });
    }
    buckets.get(bucketKey).members.push({
      id: member.id,
      displayName: member.displayName || member.user?.username || member.id,
      sinceTs: null, // no per-member voice join time tracked
    });
  }

  // ── collapse buckets into synthetic rows ────────────────────────────────
  const result = { playing: [], listening: [], watching: [], voice: [], other: [] };

  for (const { section, display, members } of buckets.values()) {
    // De-duplicate members who appear twice (e.g. streaming + playing same name)
    const seen = new Set();
    const uniqueMembers = members.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    uniqueMembers.sort((a, b) => a.displayName.localeCompare(b.displayName));

    result[section].push({
      display,
      timeStr: "",
      minutes: 0,
      count: uniqueMembers.length,
      memberNames: uniqueMembers.map((m) => m.displayName),
      members: uniqueMembers,
      synthetic: true,
    });
  }

  // Sort synthetic rows within each section: count desc, then display asc
  for (const rows of Object.values(result)) {
    rows.sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));
  }

  return result;
}

// ── live activity image cache ──────────────────────────────────────────
// The bot edits the live activity embed every 15 s with a fresh ?t bucket,
// which forces Discord's image proxy to refetch. We cache the rendered JPEG
// for 10 s — guarantees at most one render per 15 s tick, and absorbs any
// stampede from the proxy refetching twice in quick succession.
const LIVE_CACHE_TTL_MS = 10_000;
const liveImageCache = new Map(); // guildId -> { buffer, mime, generatedAt }

async function renderLiveImage(client, guildId) {
  const cached = liveImageCache.get(guildId);
  if (cached && Date.now() - cached.generatedAt < LIVE_CACHE_TTL_MS) {
    return cached;
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    const e = new Error("guild_not_found");
    e.httpCode = 404;
    throw e;
  }
  const snapshot = await buildLiveActivitySnapshot(guild);
  const buffer = await renderLiveActivity(snapshot);
  const entry = { buffer, mime: "image/jpeg", generatedAt: Date.now() };
  liveImageCache.set(guildId, entry);
  return entry;
}

// ── stats PNG cache ────────────────────────────────────────────────────
// 10.2.0 pivots the !stats image away from bot-side multipart uploads
// (which silently hang on this host — see comments in src/stats.js) and
// onto a panel-served URL that Discord's image proxy fetches itself. The
// render is moderately expensive (canvas + role-icon CDN loads on cold
// cache), so we cache the rendered JPEG per guild for 30s. Discord's own
// image proxy then caches it further upstream; the !stats command appends
// a per-minute cache-busting query so repeated invocations get a fresh
// image at most once per minute.
const STATS_CACHE_TTL_MS = 30_000;
const statsImageCache = new Map(); // guildId -> { buffer, mime, generatedAt }

async function renderStatsImage(client, guildId) {
  const cached = statsImageCache.get(guildId);
  if (cached && Date.now() - cached.generatedAt < STATS_CACHE_TTL_MS) {
    return cached;
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    const e = new Error("guild_not_found");
    e.httpCode = 404;
    throw e;
  }
  const members = buildUserMembers(guild, "monthly");
  if (members.length === 0) {
    const e = new Error("no_members");
    e.httpCode = 404;
    throw e;
  }
  const totals = buildStatsTotals(guild, members);
  const buffer = await renderUsersDefault({
    guildName: guild.name,
    title: "Top Members — Last 30 Days",
    lookbackLabel: "30d",
    totals,
    members,
    guild,
    roleByGameKey: (key) => roleForGameKey(guild, key),
  });
  const entry = { buffer, mime: "image/jpeg", generatedAt: Date.now() };
  statsImageCache.set(guildId, entry);
  return entry;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const SECTIONS = [
  { key: "playing", title: "Playing", emoji: "🎮" },
  { key: "voice", title: "Voice", emoji: "🎤" },
  { key: "listening", title: "Listening", emoji: "🎵" },
  { key: "watching", title: "Watching", emoji: "📺" },
  { key: "other", title: "Other", emoji: "🟣" },
];

/**
 * Build the "active" section from the fallback role, if configured.
 * Returns the section object, or null if it should be omitted.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {{ key: string, title: string, emoji: string, rows: Array<object> } | null}
 */
function buildActiveSection(guild) {
  if (!config.fallbackRoleId) return null;

  const role = guild.roles.cache.get(config.fallbackRoleId);
  if (!role) return null;

  const humans = role.members.filter((m) => !m.user.bot);
  if (!humans.size) return null;

  const memberList = [...humans.values()].map((m) => ({
    id: m.id,
    displayName: m.displayName || m.user?.username || m.id,
  }));
  memberList.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const row = {
    display: role.name,
    timeStr: "",
    minutes: 0,
    count: humans.size,
    memberNames: memberList.map((m) => m.displayName),
    members: memberList.map((m) => ({ id: m.id, displayName: m.displayName, sinceTs: null })),
  };

  return { key: "active", title: "Active", emoji: "", rows: [row] };
}

function buildSnapshot(client, guildId) {
  const guild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
  if (!guild) return { error: "guild_not_found", guildId: guildId || null };

  const rows = collectRows(guild);
  const syntheticRows = collectSyntheticRows(guild, rows);

  const existingSections = SECTIONS.map(({ key, title, emoji }) => {
    const tracked = (rows[key] || []).map((r) => ({
      display: r.display,
      timeStr: r.timeStr,
      minutes: r.minutes,
      count: r.count,
      memberNames: r.memberNames,
      members: r.members,
      synthetic: false,
    }));
    const synthetic = syntheticRows[key] || [];
    return {
      key,
      title,
      emoji,
      rows: [...tracked, ...synthetic],
    };
  }).filter((s) => s.rows.length > 0);

  const activeSection = buildActiveSection(guild);
  const sections = activeSection ? [activeSection, ...existingSections] : existingSections;

  return {
    guildId: guild.id,
    guildName: guild.name,
    guildIcon: guild.iconURL({ size: 64, extension: "png" }),
    sections,
    fetchedAt: new Date().toISOString(),
  };
}

const HTML_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Activity</title>
<style>
  :root {
    --bg: #1e1f22;
    --panel: #2b2d31;
    --panel-2: #232428;
    --row-hover: #34363c;
    --text: #dbdee1;
    --muted: #949ba4;
    --dim: #80848e;
    --accent: #b084f0;
    --accent-soft: #b084f01a;
    --time: #f0c674;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
  }
  .wrap {
    max-width: 1200px;
    margin: 0 auto;
    padding: 28px 24px 60px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 22px;
  }
  header img.icon {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--panel);
  }
  header .titles { line-height: 1.2; }
  header h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0.2px;
  }
  header .sub {
    color: var(--muted);
    font-size: 12px;
    margin-top: 2px;
  }
  .empty {
    padding: 50px 0;
    text-align: center;
    color: var(--muted);
    font-style: italic;
  }
  .err {
    background: #f23f4220;
    border: 1px solid #f23f4280;
    color: #ffb4b4;
    padding: 10px 14px;
    border-radius: 6px;
    margin-bottom: 18px;
    display: none;
  }
  section.section {
    background: var(--panel);
    border-radius: 10px;
    padding: 14px 18px 10px;
    margin-bottom: 14px;
    border-left: 3px solid var(--accent);
  }
  section.section h2 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grid {
    display: grid;
    grid-template-columns: max-content 1fr max-content minmax(0, 2fr);
    column-gap: 22px;
    row-gap: 2px;
    align-items: center;
  }
  .grid .row {
    display: contents;
  }
  .grid .row > div {
    padding: 6px 10px;
    border-radius: 4px;
  }
  .grid .row:hover > div {
    background: var(--row-hover);
  }
  .grid .time {
    font-variant-numeric: tabular-nums;
    color: var(--time);
    font-weight: 500;
    text-align: right;
    min-width: 64px;
  }
  .grid .name {
    font-weight: 600;
    color: var(--text);
  }
  .grid .count {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    text-align: center;
    min-width: 24px;
  }
  .grid .members {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  footer {
    text-align: center;
    color: var(--dim);
    font-size: 11px;
    margin-top: 24px;
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img class="icon" id="icon" alt="" />
    <div class="titles">
      <h1 id="title">Loading…</h1>
      <div class="sub" id="sub">—</div>
    </div>
  </header>
  <div class="err" id="err"></div>
  <div id="root"></div>
  <footer>updates every 5s · <span id="updated">—</span></footer>
</div>
<script>
(function () {
  const POLL_MS = 5000;
  const params = new URLSearchParams(location.search);
  const key = params.get('key') || '';
  const root = document.getElementById('root');
  const icon = document.getElementById('icon');
  const title = document.getElementById('title');
  const sub = document.getElementById('sub');
  const err = document.getElementById('err');
  const updated = document.getElementById('updated');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderRow(r) {
    const members = r.memberNames.length > 0 ? r.memberNames.join(', ') : '';
    return ''
      + '<div class="row">'
      +   '<div class="time">' + escapeHtml(r.timeStr) + '</div>'
      +   '<div class="name">' + escapeHtml(r.display) + '</div>'
      +   '<div class="count">' + r.count + '</div>'
      +   '<div class="members" title="' + escapeHtml(members) + '">' + escapeHtml(members) + '</div>'
      + '</div>';
  }

  function render(data) {
    err.style.display = 'none';
    if (data.error) {
      err.textContent = 'Error: ' + data.error;
      err.style.display = '';
      return;
    }

    title.textContent = data.guildName ? 'Live Activity — ' + data.guildName : 'Live Activity';
    icon.src = data.guildIcon || '';
    icon.style.visibility = data.guildIcon ? 'visible' : 'hidden';

    const totalRows = data.sections.reduce((n, s) => n + s.rows.length, 0);
    sub.textContent = totalRows === 0
      ? 'No tracked activity right now'
      : totalRows + (totalRows === 1 ? ' active role' : ' active roles');

    if (totalRows === 0) {
      root.innerHTML = '<div class="empty">Nothing happening — go play something.</div>';
    } else {
      root.innerHTML = data.sections.map((s) => ''
        + '<section class="section">'
        +   '<h2><span>' + escapeHtml(s.emoji) + '</span><span>' + escapeHtml(s.title) + '</span></h2>'
        +   '<div class="grid">' + s.rows.map(renderRow).join('') + '</div>'
        + '</section>'
      ).join('');
    }

    if (data.fetchedAt) {
      const d = new Date(data.fetchedAt);
      updated.textContent = d.toLocaleTimeString();
    }
  }

  async function tick() {
    try {
      const r = await fetch('/api/activity?key=' + encodeURIComponent(key), { cache: 'no-store' });
      if (!r.ok) {
        err.textContent = 'Error ' + r.status + ': ' + (await r.text());
        err.style.display = '';
        return;
      }
      render(await r.json());
    } catch (e) {
      err.textContent = 'Network error: ' + e.message;
      err.style.display = '';
    }
  }

  tick();
  setInterval(tick, POLL_MS);
})();
</script>
</body>
</html>`;

function startPanel(client) {
  const token = process.env.PANEL_TOKEN;
  if (!token) {
    console.log("Panel disabled: set PANEL_TOKEN to enable.");
    return null;
  }
  const port = parseInt(process.env.PANEL_PORT || "8080", 10);
  const guildId = process.env.PANEL_GUILD_ID || null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    // Public, un-authed stats image. Discord's image-proxy fetches this
    // when rendering the embed sent by !stats; gating it with a token
    // would break that fetch (Discord doesn't send our key). The data is
    // visible inside the Discord server anyway. Validate that the path
    // looks like a snowflake before doing any work.
    const statsMatch = url.pathname.match(/^\/stats\/(\d{17,20})\.jpg$/);
    if (statsMatch) {
      const guildId = statsMatch[1];
      renderStatsImage(client, guildId).then((entry) => {
        res.writeHead(200, {
          "Content-Type": entry.mime,
          "Cache-Control": "public, max-age=60",
          "Content-Length": entry.buffer.length,
        });
        res.end(entry.buffer);
      }).catch((err) => {
        const code = err.httpCode || 500;
        res.writeHead(code, { "Content-Type": "text/plain" });
        res.end(err.message);
        if (code >= 500) console.error(`[panel] /stats/${guildId}.jpg failed:`, err);
      });
      return;
    }

    // Public, un-authed live activity image. Same rationale as /stats: the
    // Discord image proxy fetches this URL when rendering the live activity
    // embed, and we can't make it send our PANEL_TOKEN. The data is visible
    // inside the Discord server anyway. Validate snowflake shape first.
    const liveMatch = url.pathname.match(/^\/live\/(\d{17,20})\.jpg$/);
    if (liveMatch) {
      const guildId = liveMatch[1];
      renderLiveImage(client, guildId).then((entry) => {
        res.writeHead(200, {
          "Content-Type": entry.mime,
          "Cache-Control": "public, max-age=15",
          "Content-Length": entry.buffer.length,
        });
        res.end(entry.buffer);
      }).catch((err) => {
        const code = err.httpCode || 500;
        res.writeHead(code, { "Content-Type": "text/plain" });
        res.end(err.message);
        if (code >= 500) console.error(`[panel] /live/${guildId}.jpg failed:`, err);
      });
      return;
    }

    const provided = url.searchParams.get("key") || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (!safeEqual(provided, token)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(HTML_PAGE);
      return;
    }
    if (url.pathname === "/api/activity") {
      try {
        const snap = buildSnapshot(client, guildId);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(snap));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Panel listening on :${port} (guild=${guildId || "first"})`);
  });
  server.on("error", (err) => {
    console.error("Panel server error:", err.message);
  });
  return server;
}

module.exports = { startPanel, collectSyntheticRows, buildSnapshot, buildActiveSection };
