const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

// Try to register a system font as "UI" so the rest of the file can use one name.
// On Debian-slim we install fonts-dejavu-core; @napi-rs/canvas reads system font dirs.
try {
  GlobalFonts.registerFromPath("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "UI Bold");
  GlobalFonts.registerFromPath("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "UI");
} catch {
  // Local dev / different platform — fall back to whatever Skia finds.
}

const PALETTE = {
  bg: "#1e1f22",
  panel: "#2b2d31",
  panel2: "#232428",
  border: "#1f2024",
  text: "#dbdee1",
  muted: "#949ba4",
  dim: "#80848e",
  accent: "#5865f2",
  green: "#23a55a",
  yellow: "#fee75c",
  red: "#f23f42",
  gold: "#e5b25d",
  silver: "#b3b9c5",
  bronze: "#c47e58",
  purple: "#9b59b6",
  voice: "#43a25a",
};

const PADDING = 20;
const GAP = 12;
const WIDTH = 720;
const RADIUS = 8;

function fmtHours(min) {
  if (min <= 0) return "0h";
  const h = min / 60;
  if (h >= 100) return `${h.toFixed(0)}h`;
  if (h >= 10) return `${h.toFixed(1)}h`;
  return `${h.toFixed(2)}h`;
}

function fmtMinutesShort(min) {
  if (min < 1) return "<1m";
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const minutes = min % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPanel(ctx, x, y, w, h, fill = PALETTE.panel2) {
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, RADIUS);
  ctx.fill();
}

function drawText(ctx, text, x, y, opts = {}) {
  ctx.fillStyle = opts.color || PALETTE.text;
  ctx.font = `${opts.weight || ""} ${opts.size || 14}px ${opts.weight === "bold" ? "UI Bold" : "UI"}`;
  ctx.textAlign = opts.align || "left";
  ctx.textBaseline = opts.baseline || "alphabetic";
  ctx.fillText(text, x, y);
}

function truncate(ctx, text, maxWidth, font) {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

function rankLabel(i) {
  if (i === 0) return { text: "1", color: PALETTE.gold };
  if (i === 1) return { text: "2", color: PALETTE.silver };
  if (i === 2) return { text: "3", color: PALETTE.bronze };
  return { text: String(i + 1), color: PALETTE.dim };
}

// Layout primitives ────────────────────────────────────────────────────

function drawHeader(ctx, x, y, w, title, subtitle, accent = PALETTE.accent) {
  const h = 60;
  drawPanel(ctx, x, y, w, h, PALETTE.panel);
  // accent bar on the left
  ctx.fillStyle = accent;
  roundRect(ctx, x, y, 4, h, 2);
  ctx.fill();
  drawText(ctx, title, x + 18, y + 26, { size: 18, weight: "bold", color: PALETTE.text });
  if (subtitle) drawText(ctx, subtitle, x + 18, y + 47, { size: 12, color: PALETTE.muted });
  return h;
}

function drawBigStat(ctx, x, y, w, h, label, value, sub, accent = PALETTE.accent) {
  drawPanel(ctx, x, y, w, h);
  drawText(ctx, label.toUpperCase(), x + 14, y + 22, { size: 11, weight: "bold", color: PALETTE.muted });
  drawText(ctx, value, x + 14, y + 56, { size: 28, weight: "bold", color: accent });
  if (sub) drawText(ctx, sub, x + 14, y + 78, { size: 12, color: PALETTE.muted });
}

function drawTriStat(ctx, x, y, w, h, title, items) {
  drawPanel(ctx, x, y, w, h);
  drawText(ctx, title.toUpperCase(), x + 14, y + 22, { size: 11, weight: "bold", color: PALETTE.muted });
  const colW = (w - 28) / items.length;
  items.forEach((it, i) => {
    const cx = x + 14 + colW * i;
    drawText(ctx, it.label, cx, y + 48, { size: 12, weight: "bold", color: PALETTE.text });
    drawText(ctx, it.value, cx, y + 70, { size: 14, color: it.color || PALETTE.text });
  });
}

function drawListPanel(ctx, x, y, w, title, rows, opts = {}) {
  const headerH = 44;
  const rowH = 30;
  const h = headerH + rowH * rows.length + 12;
  drawPanel(ctx, x, y, w, h);
  drawText(ctx, title.toUpperCase(), x + 14, y + 26, { size: 11, weight: "bold", color: PALETTE.muted });

  const rankColW = 28;
  const valueColW = opts.valueColW || 90;
  const subColW = opts.subColW || 0;
  const nameX = x + 14 + rankColW;
  const valueX = x + w - 14;
  const subX = subColW ? valueX - valueColW - 16 : null;
  const nameMaxW = (subX || valueX - valueColW) - nameX - 12;

  rows.forEach((row, i) => {
    const ry = y + headerH + rowH * i + rowH / 2 + 4;
    const rank = rankLabel(i);
    drawText(ctx, rank.text, x + 14, ry, { size: 14, weight: "bold", color: rank.color });
    const nameFont = `${row.bold === false ? "" : "bold "}14px ${row.bold === false ? "UI" : "UI Bold"}`;
    const nameText = truncate(ctx, row.name, nameMaxW, nameFont);
    drawText(ctx, nameText, nameX, ry, { size: 14, weight: row.bold === false ? "" : "bold", color: PALETTE.text });
    if (subX && row.sub) {
      drawText(ctx, row.sub, subX, ry, { size: 12, color: PALETTE.muted, align: "right" });
    }
    drawText(ctx, row.value, valueX, ry, { size: 14, weight: "bold", color: row.valueColor || PALETTE.text, align: "right" });
  });

  return h;
}

function fillBackground(ctx, w, h) {
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, w, h);
}

// Renderers ────────────────────────────────────────────────────────────

// /stats default — top members, last 30 days
function renderUsersDefault({ guildName, totals, members }) {
  const memberRows = members.slice(0, 10);

  // Compute height up front.
  const headerH = 60;
  const summaryH = 100;
  const listHeaderH = 44;
  const rowH = 30;
  const listH = listHeaderH + rowH * memberRows.length + 12;
  const height = PADDING * 2 + headerH + GAP + summaryH + GAP + listH;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");
  fillBackground(ctx, WIDTH, height);

  let y = PADDING;
  drawHeader(ctx, PADDING, y, WIDTH - PADDING * 2, "Top Members — Last 30 Days", guildName, PALETTE.accent);
  y += headerH + GAP;

  // Summary row: 2-up — server total + per-window
  const sumW = WIDTH - PADDING * 2;
  const leftW = Math.floor(sumW * 0.36);
  const rightW = sumW - leftW - GAP;
  drawBigStat(
    ctx, PADDING, y, leftW, summaryH,
    "Server Lookback (30d)",
    fmtHours(totals.voiceMonth + totals.gameMonth),
    `${totals.activeMembers} active members`,
    PALETTE.accent,
  );
  drawTriStat(
    ctx, PADDING + leftW + GAP, y, rightW, summaryH,
    "Voice Activity",
    [
      { label: "1d", value: fmtHours(totals.voiceDay), color: PALETTE.voice },
      { label: "7d", value: fmtHours(totals.voiceWeek), color: PALETTE.voice },
      { label: "30d", value: fmtHours(totals.voiceMonth), color: PALETTE.voice },
    ],
  );
  y += summaryH + GAP;

  drawListPanel(ctx, PADDING, y, sumW, "Top Members", memberRows.map((r) => ({
    name: r.displayName,
    value: fmtHours(r.voiceMinutes),
    sub: r.topGame ? `🎮 ${r.topGame.key} ${fmtMinutesShort(r.topGame.minutes)}` : "no games",
    valueColor: PALETTE.voice,
  })), { valueColW: 100, subColW: 240 });

  return canvas.toBuffer("image/png");
}

// /stats voice — lifetime users
function renderVoiceLifetime({ guildName, totals, members }) {
  const memberRows = members.slice(0, 10);

  const headerH = 60;
  const summaryH = 100;
  const listHeaderH = 44;
  const rowH = 30;
  const listH = listHeaderH + rowH * memberRows.length + 12;
  const height = PADDING * 2 + headerH + GAP + summaryH + GAP + listH;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");
  fillBackground(ctx, WIDTH, height);

  let y = PADDING;
  drawHeader(ctx, PADDING, y, WIDTH - PADDING * 2, "Top Voice Members — All Time", guildName, PALETTE.green);
  y += headerH + GAP;

  const sumW = WIDTH - PADDING * 2;
  const leftW = Math.floor(sumW * 0.36);
  const rightW = sumW - leftW - GAP;
  drawBigStat(
    ctx, PADDING, y, leftW, summaryH,
    "Server Lookback",
    fmtHours(totals.lifetime),
    `${totals.memberCount} members tracked`,
    PALETTE.green,
  );
  drawTriStat(
    ctx, PADDING + leftW + GAP, y, rightW, summaryH,
    "Voice Activity",
    [
      { label: "1d", value: fmtHours(totals.day), color: PALETTE.voice },
      { label: "7d", value: fmtHours(totals.week), color: PALETTE.voice },
      { label: "30d", value: fmtHours(totals.month), color: PALETTE.voice },
    ],
  );
  y += summaryH + GAP;

  drawListPanel(ctx, PADDING, y, sumW, "Top Voice Members", memberRows.map((r) => ({
    name: r.displayName,
    value: fmtHours(r.minutes),
    sub: `${r.percent}% of total`,
    valueColor: PALETTE.voice,
  })), { valueColW: 100, subColW: 140 });

  return canvas.toBuffer("image/png");
}

// /stats games — per-period game leaderboard
function renderGames({ guildName, periodLabel, accent, totals, games, resetText }) {
  const gameRows = games.slice(0, 10);

  const headerH = 60;
  const summaryH = 100;
  const listHeaderH = 44;
  const rowH = 30;
  const listH = listHeaderH + rowH * gameRows.length + 12;
  const height = PADDING * 2 + headerH + GAP + summaryH + GAP + listH;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");
  fillBackground(ctx, WIDTH, height);

  let y = PADDING;
  drawHeader(ctx, PADDING, y, WIDTH - PADDING * 2, `Most Played Games — ${periodLabel}`, guildName, accent);
  y += headerH + GAP;

  const sumW = WIDTH - PADDING * 2;
  const leftW = Math.floor(sumW * 0.36);
  const rightW = sumW - leftW - GAP;
  drawBigStat(
    ctx, PADDING, y, leftW, summaryH,
    `Total — ${periodLabel}`,
    fmtHours(totals.minutes),
    `${totals.tracked} games · ${resetText || "—"}`,
    accent,
  );
  drawTriStat(
    ctx, PADDING + leftW + GAP, y, rightW, summaryH,
    "Across All Windows",
    [
      { label: "1d", value: fmtHours(totals.day), color: accent },
      { label: "7d", value: fmtHours(totals.week), color: accent },
      { label: "all", value: fmtHours(totals.lifetime), color: accent },
    ],
  );
  y += summaryH + GAP;

  drawListPanel(ctx, PADDING, y, sumW, `Top Games — ${periodLabel}`, gameRows.map((g) => ({
    name: g.key,
    value: fmtHours(g.minutes),
    sub: g.topUserName ? `top: ${g.topUserName} ${fmtMinutesShort(g.topUserMinutes)}` : "",
    valueColor: accent,
  })), { valueColW: 100, subColW: 220 });

  return canvas.toBuffer("image/png");
}

module.exports = {
  renderUsersDefault,
  renderVoiceLifetime,
  renderGames,
};
