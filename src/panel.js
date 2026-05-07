const http = require("http");
const crypto = require("crypto");

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function statusOf(presence) {
  if (!presence) return "offline";
  return presence.status || "offline";
}

function activitiesOf(presence) {
  if (!presence) return [];
  return presence.activities.map((a) => ({
    type: a.type,
    name: a.name,
    details: a.details || null,
    state: a.state || null,
    emoji: a.emoji ? a.emoji.name : null,
  }));
}

function buildSnapshot(client, guildId) {
  const guild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
  if (!guild) return { error: "guild_not_found", guildId: guildId || null };

  const voiceByMember = new Map();
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isVoiceBased || !channel.isVoiceBased()) continue;
    for (const [memberId] of channel.members) {
      voiceByMember.set(memberId, channel.name);
    }
  }

  const members = [];
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    const status = statusOf(member.presence);
    if (status === "offline") continue;

    const hoistedRole = member.roles.hoist;
    const topRole = member.roles.highest;

    members.push({
      id: member.id,
      name: member.user.username,
      displayName: member.displayName,
      avatar: member.user.displayAvatarURL({ size: 32, extension: "png" }),
      status,
      activities: activitiesOf(member.presence),
      voiceChannel: voiceByMember.get(member.id) || null,
      hoistRoleId: hoistedRole ? hoistedRole.id : null,
      hoistRoleName: hoistedRole ? hoistedRole.name : null,
      hoistRoleColor: hoistedRole && hoistedRole.color ? `#${hoistedRole.color.toString(16).padStart(6, "0")}` : null,
      hoistRolePosition: hoistedRole ? hoistedRole.position : -1,
      topRoleColor: topRole && topRole.color ? `#${topRole.color.toString(16).padStart(6, "0")}` : null,
    });
  }

  return {
    guildId: guild.id,
    guildName: guild.name,
    guildIcon: guild.iconURL({ size: 64, extension: "png" }),
    memberCount: guild.memberCount,
    onlineCount: members.length,
    members,
    fetchedAt: new Date().toISOString(),
  };
}

const HTML_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Member Panel</title>
<style>
  :root {
    --bg: #1e1f22;
    --panel: #2b2d31;
    --panel-2: #232428;
    --hover: #35373c;
    --text: #dbdee1;
    --muted: #949ba4;
    --dim: #80848e;
    --accent: #5865f2;
    --green: #23a55a;
    --yellow: #f0b232;
    --red: #f23f42;
    --gray: #80848e;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 14px;
    display: flex;
    justify-content: center;
  }
  #app {
    width: 280px;
    background: var(--panel);
    height: 100vh;
    overflow-y: auto;
    border-left: 1px solid var(--panel-2);
    border-right: 1px solid var(--panel-2);
  }
  header {
    position: sticky; top: 0;
    background: var(--panel-2);
    padding: 10px 14px;
    border-bottom: 1px solid #1f2024;
    display: flex; align-items: center; gap: 10px;
    z-index: 2;
  }
  header img { width: 24px; height: 24px; border-radius: 50%; }
  header .title { flex: 1; min-width: 0; }
  header .title .name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header .title .meta { font-size: 11px; color: var(--muted); }
  header .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: 0.4; } }
  .section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--muted);
    padding: 14px 10px 4px;
  }
  .member {
    display: flex; align-items: center; gap: 10px;
    padding: 4px 10px;
    border-radius: 4px;
    margin: 0 6px 1px;
    cursor: default;
  }
  .member:hover { background: var(--hover); }
  .avatar-wrap { position: relative; flex-shrink: 0; }
  .avatar-wrap img { width: 28px; height: 28px; border-radius: 50%; display: block; }
  .status-dot {
    position: absolute; right: -2px; bottom: -2px;
    width: 11px; height: 11px; border-radius: 50%;
    border: 2px solid var(--panel);
  }
  .status-online { background: var(--green); }
  .status-idle   { background: var(--yellow); }
  .status-dnd    { background: var(--red); }
  .status-offline { background: var(--gray); }
  .info { min-width: 0; flex: 1; }
  .name {
    font-weight: 500;
    font-size: 14px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .activity {
    font-size: 11px; color: var(--muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    display: flex; align-items: center; gap: 4px;
  }
  .activity .pip { font-size: 10px; }
  .voice { color: #43a25a; }
  #err {
    margin: 16px;
    padding: 10px;
    background: #3a1f1f; color: #ff8a8a;
    border-radius: 6px;
    display: none;
    font-size: 12px;
  }
  .empty { padding: 30px 10px; text-align: center; color: var(--muted); font-size: 12px; }
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-thumb { background: #1a1b1e; border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
</style>
</head>
<body>
  <div id="app">
    <header>
      <img id="g-icon" alt="" />
      <div class="title">
        <div class="name" id="g-name">Loading…</div>
        <div class="meta" id="g-meta"></div>
      </div>
      <div class="pulse" title="live"></div>
    </header>
    <div id="err"></div>
    <div id="list"></div>
  </div>
<script>
(function() {
  const params = new URLSearchParams(location.search);
  const key = params.get('key') || '';
  const POLL_MS = 5000;
  const list = document.getElementById('list');
  const err = document.getElementById('err');
  const gIcon = document.getElementById('g-icon');
  const gName = document.getElementById('g-name');
  const gMeta = document.getElementById('g-meta');

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function activityLine(a, voiceChannel) {
    if (!a) return voiceChannel ? '<span class="voice">🔊 ' + escapeHtml(voiceChannel) + '</span>' : '';
    let prefix = '';
    let body = '';
    switch (a.type) {
      case 0: prefix = '🎮'; body = a.name; break;
      case 1: prefix = '📺'; body = 'Streaming ' + a.name; break;
      case 2: prefix = '🎵'; body = a.details || a.state || a.name; break;
      case 3: prefix = '📺'; body = 'Watching ' + a.name; break;
      case 4: {
        const e = a.emoji ? a.emoji + ' ' : '';
        body = e + (a.state || '');
        break;
      }
      case 5: prefix = '🏆'; body = 'Competing in ' + a.name; break;
      default: body = a.name;
    }
    let line = (prefix ? prefix + ' ' : '') + escapeHtml(body);
    if (voiceChannel) line += ' · <span class="voice">In voice</span>';
    return line;
  }

  function primaryActivity(activities) {
    if (!activities || !activities.length) return null;
    const order = [0, 1, 5, 3, 2, 4];
    for (const t of order) {
      const a = activities.find(x => x.type === t);
      if (a) return a;
    }
    return activities[0];
  }

  function groupKey(m) {
    if (m.hoistRoleId) return 'role:' + m.hoistRoleId;
    return 'online';
  }

  function render(snapshot) {
    err.style.display = 'none';
    if (snapshot.guildIcon) { gIcon.src = snapshot.guildIcon; gIcon.style.display = ''; }
    else { gIcon.style.display = 'none'; }
    gName.textContent = snapshot.guildName || '';
    gMeta.textContent = snapshot.onlineCount + ' online · ' + snapshot.memberCount + ' total';

    const groups = new Map();
    const groupMeta = new Map();
    for (const m of snapshot.members) {
      const k = groupKey(m);
      if (!groups.has(k)) {
        groups.set(k, []);
        groupMeta.set(k, {
          key: k,
          title: m.hoistRoleName || 'ONLINE',
          color: m.hoistRoleColor || null,
          position: m.hoistRolePosition,
        });
      }
      groups.get(k).push(m);
    }

    const ordered = [...groupMeta.values()].sort((a, b) => {
      if (a.key === 'online' && b.key !== 'online') return 1;
      if (b.key === 'online' && a.key !== 'online') return -1;
      return b.position - a.position;
    });

    if (!ordered.length) {
      list.innerHTML = '<div class="empty">No one is online.</div>';
      return;
    }

    let html = '';
    for (const meta of ordered) {
      const ms = groups.get(meta.key);
      const titleStyle = meta.color ? ' style="color:' + escapeHtml(meta.color) + '"' : '';
      html += '<div class="section-title"' + titleStyle + '>' + escapeHtml(meta.title) + ' — ' + ms.length + '</div>';
      for (const m of ms) {
        const a = primaryActivity(m.activities);
        const nameStyle = m.topRoleColor ? ' style="color:' + escapeHtml(m.topRoleColor) + '"' : '';
        const actLine = activityLine(a, m.voiceChannel);
        html += '<div class="member" title="' + escapeHtml(m.displayName) + '">'
          + '<div class="avatar-wrap"><img src="' + escapeHtml(m.avatar) + '" alt=""><div class="status-dot status-' + escapeHtml(m.status) + '"></div></div>'
          + '<div class="info">'
          +   '<div class="name"' + nameStyle + '>' + escapeHtml(m.displayName) + '</div>'
          +   (actLine ? '<div class="activity">' + actLine + '</div>' : '')
          + '</div>'
          + '</div>';
      }
    }
    list.innerHTML = html;
  }

  async function tick() {
    try {
      const r = await fetch('/api/members?key=' + encodeURIComponent(key), { cache: 'no-store' });
      if (!r.ok) {
        err.textContent = 'Error ' + r.status + ': ' + (await r.text());
        err.style.display = '';
        return;
      }
      const data = await r.json();
      if (data.error) {
        err.textContent = 'Error: ' + data.error;
        err.style.display = '';
        return;
      }
      render(data);
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
    if (url.pathname === "/api/members") {
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
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
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

module.exports = { startPanel };
