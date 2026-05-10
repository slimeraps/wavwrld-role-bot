const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");

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
  voice: "#43a25a",
};

const PADDING = 20;
const GAP = 12;
const WIDTH = 720;
const RADIUS = 8;
const ICON_SIZE = 18;

// In-memory icon cache keyed by Discord role.icon hash. Hashes change when an
// admin uploads a new icon, so cached entries are valid until that happens.
const iconCache = new Map();

async function loadRoleIconCached(role) {
  if (!role || !role.icon) return null;
  const key = role.icon;
  if (iconCache.has(key)) return iconCache.get(key);
  const url = role.iconURL({ size: 64, extension: "png" });
  if (!url) return null;
  try {
    const img = await loadImage(url);
    iconCache.set(key, img);
    return img;
  } catch (err) {
    console.warn(`[stats] could not load role icon for "${role.name}": ${err.message}`);
    iconCache.set(key, null);
    return null;
  }
}

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

function drawHeader(ctx, x, y, w, title, subtitle, accent = PALETTE.accent) {
  const h = 60;
  drawPanel(ctx, x, y, w, h, PALETTE.panel);
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

function fillBackground(ctx, w, h) {
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, w, h);
}

// Top Members list with role icons next to each top game.
async function renderUsersDefault({ guildName, totals, members, guild, roleByGameKey }) {
  const memberRows = members.slice(0, 10);

  // Resolve + load role icons in parallel before we start drawing.
  const resolved = await Promise.all(memberRows.map(async (r) => {
    if (!r.topGame) return { row: r, icon: null, role: null };
    const role = roleByGameKey?.(r.topGame.key) || null;
    const icon = await loadRoleIconCached(role);
    return { row: r, icon, role };
  }));

  const headerH = 60;
  const summaryH = 100;
  const listHeaderH = 44;
  const rowH = 32;
  const listH = listHeaderH + rowH * memberRows.length + 12;
  const height = PADDING * 2 + headerH + GAP + summaryH + GAP + listH;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");
  fillBackground(ctx, WIDTH, height);

  let y = PADDING;
  drawHeader(ctx, PADDING, y, WIDTH - PADDING * 2, "Top Members — Last 30 Days", guildName, PALETTE.accent);
  y += headerH + GAP;

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

  // List panel with role icons inline.
  drawPanel(ctx, PADDING, y, sumW, listH);
  drawText(ctx, "TOP MEMBERS", PADDING + 14, y + 26, { size: 11, weight: "bold", color: PALETTE.muted });

  const listX = PADDING;
  const rankColW = 28;
  const valueColX = PADDING + sumW - 14; // right edge for the hours value
  const valueColW = 90;
  const subRightX = valueColX - valueColW - 16;
  const nameX = listX + 14 + rankColW;

  resolved.forEach(({ row, icon, role }, i) => {
    const ry = y + listHeaderH + rowH * i + rowH / 2 + 4;
    const rank = rankLabel(i);
    drawText(ctx, rank.text, listX + 14, ry, { size: 14, weight: "bold", color: rank.color });

    // Member name (left)
    const nameMaxW = 220;
    const nameText = truncate(ctx, row.displayName, nameMaxW, "bold 14px UI Bold");
    drawText(ctx, nameText, nameX, ry, { size: 14, weight: "bold" });

    // Sub line: [icon] Game name (Xh Ym) — right-aligned at subRightX
    let subX = subRightX;
    if (row.topGame) {
      const label = `${row.topGame.key} (${fmtMinutesShort(row.topGame.minutes)})`;
      // Measure width to right-align the whole [icon + label] block.
      ctx.font = "12px UI";
      const labelW = ctx.measureText(label).width;
      const totalW = labelW + (icon ? ICON_SIZE + 6 : 0);
      const startX = subX - totalW;

      if (icon) {
        // Round-clip the icon for a cleaner look.
        ctx.save();
        ctx.beginPath();
        const iy = ry - ICON_SIZE / 2 - 5;
        ctx.arc(startX + ICON_SIZE / 2, iy + ICON_SIZE / 2, ICON_SIZE / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(icon, startX, iy, ICON_SIZE, ICON_SIZE);
        ctx.restore();
      }
      drawText(
        ctx,
        label,
        startX + (icon ? ICON_SIZE + 6 : 0),
        ry,
        { size: 12, color: PALETTE.muted },
      );
    } else {
      drawText(ctx, "no games", subX, ry, { size: 12, color: PALETTE.dim, align: "right" });
    }

    // Voice hours (right)
    drawText(ctx, fmtHours(row.voiceMinutes), valueColX, ry, {
      size: 14, weight: "bold", color: PALETTE.voice, align: "right",
    });
  });

  return canvas.toBuffer("image/png");
}

module.exports = {
  renderUsersDefault,
};
