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
  // Legacy tokens — still used by renderVoice30d / renderPlaying.
  bg: "#1e1f22",
  panel: "#2b2d31",
  panel2: "#232428",
  border: "#1f2024",
  text: "#dbdee1",
  muted: "#949ba4",
  dim: "#80848e",
  accent: "#5865f2",
  legacyGreen: "#23a55a",
  yellow: "#fee75c",
  red: "#f23f42",
  voice: "#43a25a",
  // Rank colors — used by both legacy and redesigned renderers.
  gold: "#e5b25d",
  silver: "#b3b9c5",
  bronze: "#c47e58",
  // New tokens for the redesigned renderUsersDefault.
  bgGradFrom: "#7a4e62",
  bgGradTo: "#4d5f7a",
  usersText: "#ece6f0",
  usersMuted: "#a39cb0",
  usersDim: "#6e6878",
  usersPanel: "#1d1c25",
  usersPanelPrimary: "#251c26",
  usersBorder: "#2a2735",
  pink: "#ffa6c9",
  pinkGhost: "rgba(255, 166, 201, 0.08)",
  pinkBorder: "rgba(255, 166, 201, 0.45)",
  blue: "#9ec5ff",
  green: "#b8e3a1",
  // Bento tile tokens.
  tileBg:        "rgba(29,28,37,0.62)",
  tileBgVoice:   "rgba(28,60,40,0.62)",
  tileHighlight: "rgba(255,255,255,0.05)",
};

const PADDING = 20;
const GAP = 12;
const WIDTH = 720;
const RADIUS = 8;
const ICON_SIZE = 18;

// Density multiplier for renderUsersDefault. Discord caps embed image *display*
// width around 550-600px on desktop, so we render at 2x source and let the
// downscale yield sharper text on HiDPI displays.
const SCALE = 2;

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

// In-memory user-avatar cache keyed by the resolved URL. The URL contains the
// avatar hash (or default-avatar index), so a user changing their picture
// naturally produces a new URL and misses the cache. Failures cache `null`
// so we don't retry a broken CDN URL on every render.
const userAvatarCache = new Map();

async function loadUserAvatarCached(guild, userId) {
  if (!guild || !userId) return null;
  const member = guild.members?.cache?.get(userId) || null;
  let url = null;
  if (member && typeof member.displayAvatarURL === "function") {
    url = member.displayAvatarURL({ extension: "png", size: 64, forceStatic: true });
  }
  if (!url) return null;
  if (userAvatarCache.has(url)) return userAvatarCache.get(url);
  try {
    const img = await loadImage(url);
    userAvatarCache.set(url, img);
    return img;
  } catch (err) {
    console.warn(`[stats] could not load avatar for user ${userId}: ${err.message}`);
    userAvatarCache.set(url, null);
    return null;
  }
}

// Single time formatter used everywhere in the dashboards. Minute-based for
// short spans, h+m for medium, d+h for long. Drops zero suffixes ("8h" not
// "8h 0m") so the output stays compact.
function fmtTime(min) {
  if (min <= 0) return "0m";
  if (min < 1) return "<1m";
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const minutes = m % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
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

// Tile background + subtle inset top highlight. Caller passes already-scaled
// coords. fill defaults to PALETTE.tileBg.
function drawTileChrome(ctx, x, y, w, h, fill = PALETTE.tileBg) {
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, RADIUS * SCALE);
  ctx.fill();
  ctx.fillStyle = PALETTE.tileHighlight;
  ctx.fillRect(x + RADIUS * SCALE, y, w - RADIUS * 2 * SCALE, 1 * SCALE);
}

// Thin progress bar across the bottom inner edge of a tile. value is 0..1.
function drawTileBar(ctx, x, y, w, h, value, color) {
  if (!(value > 0)) return;
  const pad = 14 * SCALE;
  const barY = y + h - 3 * SCALE;
  const barW = (w - pad * 2) * Math.min(1, value);
  ctx.fillStyle = color;
  ctx.fillRect(x + pad, barY, barW, 3 * SCALE);
}

// Avatar cluster: overlapping circular avatars left-to-right with a ring
// around each, optional "+N" chip after the stack. Returns the right edge
// x (so callers can place follow-on text).
//
// opts:
//   avatars:    Image[] (already loaded; never null inside the array)
//   extraCount: integer
//   size:       circle diameter (already scaled)
//   step:       horizontal offset between disks (already scaled)
//   ringColor:  color of the per-avatar background ring (already scaled stroke)
function drawAvatarCluster(ctx, x, cy, opts) {
  const { avatars, extraCount, size, step, ringColor } = opts;
  const ringPad = 1.5 * SCALE;
  if (avatars.length === 0) {
    ctx.beginPath();
    ctx.arc(x + size / 2, cy, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }
  for (let i = 0; i < avatars.length; i += 1) {
    const cx = x + size / 2 + step * i;
    // Background ring.
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2 + ringPad, 0, Math.PI * 2);
    ctx.fillStyle = ringColor;
    ctx.fill();
    // Round-clipped image.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatars[i], cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
  }
  let rightX = x + size + (Math.max(0, avatars.length - 1) * step);
  if (extraCount > 0) {
    const chipFont = `bold ${11 * SCALE}px UI Bold`;
    ctx.font = chipFont;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.usersDim;
    const chipText = `+${extraCount}`;
    ctx.fillText(chipText, rightX + 8 * SCALE, cy);
    rightX += 8 * SCALE + ctx.measureText(chipText).width;
  }
  return rightX;
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

// Diagonal pink-to-blue gradient background for the redesigned !stats image.
// Endpoints from PALETTE.bgGradFrom / bgGradTo. Draws across the entire canvas.
function drawCanvasBackground(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, PALETTE.bgGradFrom);
  grad.addColorStop(1, PALETTE.bgGradTo);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

// Picks the section with the highest memberCount. Ties resolve to the
// section that appears first in `sections` (which is LIVE_SECTIONS order
// because buildLiveActivitySnapshot iterates that array).
function selectLeader(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  let leader = sections[0];
  for (const s of sections) {
    if (s.memberCount > leader.memberCount) leader = s;
  }
  return leader;
}

// Returns { heroRect, smallRects[] } for a bento grid of given outer size.
// All values are in the same pixel space as inputs (caller multiplies by
// SCALE before calling, or not — this helper is unit-agnostic).
//
// Layouts:
//   smallCount=0 → hero fills full rect, smallRects=[].
//   smallCount=1 → hero 1.5fr left, 1 small 1fr right, both full height.
//   smallCount=2 → hero 1.5fr left, 2 smalls stacked in right column.
//   smallCount=3 → hero 1.5fr left, 3 smalls in 1-column stack on right.
//   smallCount=4 → hero 1.5fr left, 2x2 grid of smalls on right.
function computeBentoGrid(w, h, gap, smallCount) {
  if (smallCount <= 0) {
    return { heroRect: { x: 0, y: 0, w, h }, smallRects: [] };
  }
  const colSplit = w - gap;
  const heroW = Math.floor(colSplit * 1.5 / 2.5);
  const smallW = colSplit - heroW;
  const heroRect = { x: 0, y: 0, w: heroW, h };
  const smallX = heroW + gap;

  if (smallCount === 1) {
    return { heroRect, smallRects: [{ x: smallX, y: 0, w: smallW, h }] };
  }
  if (smallCount === 2 || smallCount === 3) {
    const tileH = Math.floor((h - gap * (smallCount - 1)) / smallCount);
    const smallRects = [];
    for (let i = 0; i < smallCount; i += 1) {
      smallRects.push({ x: smallX, y: i * (tileH + gap), w: smallW, h: tileH });
    }
    return { heroRect, smallRects };
  }
  // smallCount === 4 → 2x2.
  const tileW = Math.floor((smallW - gap) / 2);
  const tileH = Math.floor((h - gap) / 2);
  const smallRects = [
    { x: smallX,                  y: 0,            w: tileW, h: tileH },
    { x: smallX + tileW + gap,    y: 0,            w: tileW, h: tileH },
    { x: smallX,                  y: tileH + gap,  w: tileW, h: tileH },
    { x: smallX + tileW + gap,    y: tileH + gap,  w: tileW, h: tileH },
  ];
  return { heroRect, smallRects };
}

async function renderUsersDefault({ guildName, title, totals, members, guild }) {
  const memberRows = members.slice(0, 10);
  const hero = memberRows[0] || null;
  const podium = memberRows.slice(1, 3); // #2, #3
  const ladder = memberRows.slice(3);    // #4 onwards

  // Resolve avatars in parallel.
  const resolved = await Promise.all(memberRows.map(async (r) => ({
    row: r,
    avatar: await loadUserAvatarCached(guild, r.userId),
  })));

  // Layout (1× logical pixels).
  const W = 960 * SCALE;
  const PAD = 20 * SCALE;
  const HEADER_H = 72 * SCALE;
  const GAP = 10 * SCALE;
  const HERO_H = 232 * SCALE;
  const LADDER_ROW_H = 32 * SCALE;
  const LADDER_PAD_Y = 6 * SCALE;
  const EMPTY_PANEL_H = 80 * SCALE;

  if (!hero) {
    const height = PAD + HEADER_H + GAP + EMPTY_PANEL_H + PAD;
    const canvas = createCanvas(W, height);
    const ctx = canvas.getContext("2d");
    drawCanvasBackground(ctx, W, height);
    // Header (no ACTIVE count).
    let y = PAD;
    ctx.fillStyle = PALETTE.usersPanel;
    roundRect(ctx, PAD, y, W - PAD * 2, HEADER_H, RADIUS * SCALE);
    ctx.fill();
    ctx.fillStyle = PALETTE.pink;
    roundRect(ctx, PAD, y, 4 * SCALE, HEADER_H, 2 * SCALE);
    ctx.fill();
    drawText(ctx, title || "Top Members — Last 30 Days",
      PAD + 24 * SCALE, y + 30 * SCALE,
      { size: 19 * SCALE, weight: "bold", color: PALETTE.usersText });
    drawText(ctx, guildName || "",
      PAD + 24 * SCALE, y + 52 * SCALE,
      { size: 12 * SCALE, color: PALETTE.usersMuted });
    y += HEADER_H + GAP;
    ctx.fillStyle = PALETTE.usersPanel;
    roundRect(ctx, PAD, y, W - PAD * 2, EMPTY_PANEL_H, RADIUS * SCALE);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${14 * SCALE}px UI`;
    ctx.fillStyle = PALETTE.usersDim;
    ctx.fillText("No tracked activity yet.", W / 2, y + EMPTY_PANEL_H / 2);
    return canvas.toBuffer("image/jpeg");
  }

  const ladderH = ladder.length > 0
    ? LADDER_PAD_Y * 2 + LADDER_ROW_H * ladder.length
    : 0;
  const height = PAD + HEADER_H + GAP + HERO_H
    + (ladderH > 0 ? GAP + ladderH : 0) + PAD;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");
  drawCanvasBackground(ctx, W, height);

  // ── Header (unchanged structurally) ───────────────────────────────────
  let y = PAD;
  ctx.fillStyle = PALETTE.usersPanel;
  roundRect(ctx, PAD, y, W - PAD * 2, HEADER_H, RADIUS * SCALE);
  ctx.fill();
  ctx.fillStyle = PALETTE.pink;
  roundRect(ctx, PAD, y, 4 * SCALE, HEADER_H, 2 * SCALE);
  ctx.fill();
  drawText(ctx, title || "Top Members — Last 30 Days",
    PAD + 24 * SCALE, y + 30 * SCALE,
    { size: 19 * SCALE, weight: "bold", color: PALETTE.usersText });
  drawText(ctx, guildName || "",
    PAD + 24 * SCALE, y + 52 * SCALE,
    { size: 12 * SCALE, color: PALETTE.usersMuted });

  const activeRightX = W - PAD - 18 * SCALE;
  const dividerX = activeRightX - 80 * SCALE;
  ctx.strokeStyle = PALETTE.usersBorder;
  ctx.lineWidth = 1 * SCALE;
  ctx.beginPath();
  ctx.moveTo(dividerX, y + 18 * SCALE);
  ctx.lineTo(dividerX, y + HEADER_H - 18 * SCALE);
  ctx.stroke();
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText("ACTIVE", activeRightX, y + 30 * SCALE);
  ctx.font = `bold ${26 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.pink;
  ctx.fillText(String(totals?.activeMembers ?? 0), activeRightX, y + 58 * SCALE);
  y += HEADER_H;

  // ── Hero + podium grid ────────────────────────────────────────────────
  y += GAP;
  const innerW = W - PAD * 2;
  const grid = computeBentoGrid(innerW, HERO_H, GAP, podium.length);

  drawMemberHeroTile(
    ctx,
    PAD + grid.heroRect.x,
    y + grid.heroRect.y,
    grid.heroRect.w,
    grid.heroRect.h,
    hero,
    resolved[0]?.avatar || null,
  );

  podium.forEach((row, i) => {
    const rect = grid.smallRects[i];
    drawMemberPodiumTile(
      ctx,
      PAD + rect.x,
      y + rect.y,
      rect.w,
      rect.h,
      row,
      resolved[i + 1]?.avatar || null,
      i + 2, // rank 2 or 3
    );
  });
  y += HERO_H;

  // ── Leaderboard 4–10 ──────────────────────────────────────────────────
  if (ladder.length > 0) {
    y += GAP;
    ctx.fillStyle = PALETTE.tileBg;
    roundRect(ctx, PAD, y, innerW, ladderH, RADIUS * SCALE);
    ctx.fill();
    const leaderMinutes = ladder[0].voiceMinutes;
    ladder.forEach((row, i) => {
      const rowY = y + LADDER_PAD_Y + LADDER_ROW_H * i;
      const enriched = { ...row, avatar: resolved[i + 3]?.avatar || null };
      drawLeaderboardRow(
        ctx,
        PAD + 14 * SCALE,
        rowY,
        innerW - 28 * SCALE,
        LADDER_ROW_H,
        enriched,
        i + 4,
        leaderMinutes,
      );
    });
  }

  return canvas.toBuffer("image/jpeg");
}

// Section order and visual treatment. Voice has its own green accent;
// everything else uses the standard pink/blue language.
const LIVE_SECTIONS = [
  { key: "playing",   title: "Playing",   emoji: "🎮" },
  { key: "voice",     title: "Voice",     emoji: "🎤" },
  { key: "listening", title: "Listening", emoji: "🎵" },
  { key: "watching",  title: "Watching",  emoji: "📺" },
  { key: "other",     title: "Other",     emoji: "🟣" },
];

// Per-section label words for the hero subline (the "N in lobby" caption).
const HERO_SUB_WORD = {
  playing:   "in lobby",
  voice:     "in channel",
  listening: "listening",
  watching:  "watching",
  other:     "active",
};

// Draws the Live Activity hero tile.
//
// opts:
//   section: { key, emoji, memberCount }
//   row:     { display, timeStr, avatars, extraCount }
//   barScale: number — denominator for the bottom progress bar, in minutes
//   minutes:  number — row.minutes (used for the bar). If omitted, bar fills full.
function drawHeroTile(ctx, x, y, w, h, opts) {
  const isVoice = opts.section.key === "voice";
  const tileBg = isVoice ? PALETTE.tileBgVoice : PALETTE.tileBg;
  const accent = isVoice ? PALETTE.green : PALETTE.pink;
  const timeColor = isVoice ? PALETTE.green : PALETTE.pink;

  drawTileChrome(ctx, x, y, w, h, tileBg);

  // Left-edge accent bar.
  ctx.fillStyle = accent;
  roundRect(ctx, x, y + 14 * SCALE, 3 * SCALE, h - 28 * SCALE, 2 * SCALE);
  ctx.fill();

  const innerX = x + 20 * SCALE;
  const innerW = w - 40 * SCALE;

  // Icon block.
  const iconSize = 48 * SCALE;
  const iconY = y + 18 * SCALE;
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, innerX, iconY, iconSize, iconSize, 12 * SCALE);
  ctx.fill();
  ctx.fillStyle = PALETTE.usersText;
  ctx.font = `${22 * SCALE}px UI`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(opts.section.emoji, innerX + iconSize / 2, iconY + iconSize / 2);

  // Section label + activity name (right of icon block).
  const textX = innerX + iconSize + 14 * SCALE;
  const textW = innerW - iconSize - 14 * SCALE;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const label = `▸ LEADING · ${opts.section.key.toUpperCase()}`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillText(label, textX, iconY + 14 * SCALE);

  const nameFont = `bold ${22 * SCALE}px UI Bold`;
  const nameText = truncate(ctx, opts.row.display, textW, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, textX, iconY + 40 * SCALE);

  // Avatar cluster (centered horizontally) + time below it.
  const avSize = 32 * SCALE;
  const avStep = 20 * SCALE;
  const avatars = opts.row.avatars || [];
  const extraCount = opts.row.extraCount || 0;
  const clusterWidth = avatars.length === 0
    ? avSize
    : avSize + avStep * (avatars.length - 1);
  const clusterStartX = innerX + (innerW - clusterWidth) / 2;
  const clusterY = y + h - 96 * SCALE;
  drawAvatarCluster(ctx, clusterStartX, clusterY, {
    avatars,
    extraCount,
    size: avSize,
    step: avStep,
    ringColor: tileBg.replace(/[\d.]+\)$/, "1)"), // opaque ring matching tile bg
  });

  // Time + sub-caption.
  const timeY = y + h - 36 * SCALE;
  ctx.font = `bold ${26 * SCALE}px UI Bold`;
  ctx.fillStyle = timeColor;
  ctx.textAlign = "center";
  ctx.fillText(opts.row.timeStr, innerX + innerW / 2, timeY);

  const sub = `${opts.section.memberCount} ${HERO_SUB_WORD[opts.section.key] || "active"}`;
  ctx.font = `${12 * SCALE}px UI`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText(sub, innerX + innerW / 2, timeY + 18 * SCALE);

  // Bottom progress bar.
  const barValue = opts.barScale > 0 && typeof opts.minutes === "number"
    ? opts.minutes / opts.barScale
    : 1;
  drawTileBar(ctx, x, y, w, h, barValue, accent);
}

function drawMemberHeroTile(ctx, x, y, w, h, row, avatar) {
  drawTileChrome(ctx, x, y, w, h, PALETTE.tileBg);

  // Left-edge gold accent bar.
  ctx.fillStyle = PALETTE.gold;
  roundRect(ctx, x, y + 14 * SCALE, 3 * SCALE, h - 28 * SCALE, 2 * SCALE);
  ctx.fill();

  const innerX = x + 20 * SCALE;
  const innerW = w - 40 * SCALE;

  // Rank label.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${11 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText("🏆 1ST · GOLD", innerX, y + 26 * SCALE);

  // Avatar + name + game stack.
  const avSize = 64 * SCALE;
  const avCx = innerX + avSize / 2;
  const avCy = y + 70 * SCALE;
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, avCx - avSize / 2, avCy - avSize / 2, avSize, avSize);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }

  const textX = innerX + avSize + 16 * SCALE;
  const textW = innerW - avSize - 16 * SCALE;

  // Name (22px) and game name (22px to match).
  const lineFont = `bold ${22 * SCALE}px UI Bold`;
  ctx.font = lineFont;
  ctx.fillStyle = PALETTE.usersText;
  const nameText = truncate(ctx, row.displayName, textW, lineFont);
  ctx.fillText(nameText, textX, y + 60 * SCALE);

  const gameLabel = row.topGame
    ? `${row.topGame.key} · ${fmtTime(row.topGame.minutes)}`
    : "—";
  const gameText = truncate(ctx, gameLabel, textW, lineFont);
  ctx.fillText(gameText, textX, y + 90 * SCALE);

  // Divider.
  const divY = y + 120 * SCALE;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1 * SCALE;
  ctx.beginPath();
  ctx.moveTo(innerX, divY);
  ctx.lineTo(innerX + innerW, divY);
  ctx.stroke();

  // VOICE · 30D label centered.
  ctx.textAlign = "center";
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText("VOICE · 30D", innerX + innerW / 2, divY + 28 * SCALE);

  // Big time.
  ctx.font = `bold ${32 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.pink;
  ctx.fillText(fmtTime(row.voiceMinutes), innerX + innerW / 2, divY + 68 * SCALE);

  // Bottom bar (always full).
  drawTileBar(ctx, x, y, w, h, 1, PALETTE.pink);
}

// rank: 2 → silver, 3 → bronze (no other ranks accepted).
function drawMemberPodiumTile(ctx, x, y, w, h, row, avatar, rank) {
  drawTileChrome(ctx, x, y, w, h, PALETTE.tileBg);

  const rankInfo = rank === 2
    ? { label: "🥈 2ND · SILVER", color: PALETTE.silver }
    : { label: "🥉 3RD · BRONZE", color: PALETTE.bronze };

  const padX = 14 * SCALE;
  const avSize = 44 * SCALE;
  const avCx = x + padX + avSize / 2;
  const avCy = y + h / 2;

  // Avatar.
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, avCx - avSize / 2, avCy - avSize / 2, avSize, avSize);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }

  // Right-aligned time.
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${18 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.blue;
  const timeStr = fmtTime(row.voiceMinutes);
  ctx.fillText(timeStr, x + w - padX, avCy);
  const timeW = ctx.measureText(timeStr).width;

  // Text stack (left-aligned, between avatar and time).
  const textX = x + padX + avSize + 12 * SCALE;
  const textRight = x + w - padX - timeW - 12 * SCALE;
  const textW = Math.max(0, textRight - textX);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillStyle = rankInfo.color;
  ctx.fillText(rankInfo.label, textX, avCy - 14 * SCALE);

  const nameFont = `bold ${15 * SCALE}px UI Bold`;
  const nameText = truncate(ctx, row.displayName, textW, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, textX, avCy + 4 * SCALE);

  const gameLabel = row.topGame
    ? `${row.topGame.key} · ${fmtTime(row.topGame.minutes)}`
    : "—";
  const gameFont = `${11 * SCALE}px UI`;
  const gameText = truncate(ctx, gameLabel, textW, gameFont);
  ctx.font = gameFont;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText(gameText, textX, avCy + 20 * SCALE);
}

function drawLeaderboardRow(ctx, x, y, w, h, row, rank, leaderMinutes) {
  const cy = y + h / 2;
  ctx.textBaseline = "middle";

  // Rank.
  ctx.textAlign = "right";
  ctx.font = `bold ${11 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersDim;
  const rankX = x + 22 * SCALE;
  ctx.fillText(String(rank).padStart(2, "0"), rankX, cy);

  // Avatar.
  const avSize = 24 * SCALE;
  const avX = rankX + 8 * SCALE;
  const avCx = avX + avSize / 2;
  if (row.avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, cy, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(row.avatar, avX, cy - avSize / 2, avSize, avSize);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(avCx, cy, avSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }

  // Right-aligned time.
  ctx.textAlign = "right";
  ctx.font = `bold ${13 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.blue;
  const timeStr = fmtTime(row.voiceMinutes);
  const timeRightX = x + w - 14 * SCALE;
  ctx.fillText(timeStr, timeRightX, cy);
  const timeW = ctx.measureText(timeStr).width;

  // Bar (ghost track + filled portion). Sits just before the time column.
  const barW = 80 * SCALE;
  const barX = timeRightX - timeW - 12 * SCALE - barW;
  const barY = cy - 2 * SCALE;
  ctx.fillStyle = "rgba(255,166,201,0.18)";
  roundRect(ctx, barX, barY, barW, 4 * SCALE, 2 * SCALE);
  ctx.fill();
  const fillW = leaderMinutes > 0
    ? barW * Math.min(1, row.voiceMinutes / leaderMinutes)
    : 0;
  if (fillW > 0) {
    ctx.fillStyle = PALETTE.pink;
    roundRect(ctx, barX, barY, fillW, 4 * SCALE, 2 * SCALE);
    ctx.fill();
  }

  // Name + game label, between avatar and bar.
  const textX = avX + avSize + 12 * SCALE;
  const textRight = barX - 12 * SCALE;
  const textW = Math.max(0, textRight - textX);

  ctx.textAlign = "left";
  const nameFont = `bold ${13 * SCALE}px UI Bold`;
  const gameLabel = row.topGame
    ? ` ${row.topGame.key} · ${fmtTime(row.topGame.minutes)}`
    : "";
  ctx.font = nameFont;
  const nameOnlyW = ctx.measureText(row.displayName).width;
  const nameText = truncate(ctx, row.displayName, Math.min(textW, nameOnlyW), nameFont);
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, textX, cy);
  if (gameLabel) {
    const gameFont = `${11 * SCALE}px UI`;
    const remaining = textW - ctx.measureText(nameText).width;
    const gameText = truncate(ctx, gameLabel, Math.max(0, remaining), gameFont);
    ctx.font = gameFont;
    ctx.fillStyle = PALETTE.usersMuted;
    ctx.fillText(gameText, textX + ctx.measureText(nameText).width, cy);
  }
}

function drawSmallTile(ctx, x, y, w, h, opts) {
  const isVoice = opts.section.key === "voice";
  const tileBg = isVoice ? PALETTE.tileBgVoice : PALETTE.tileBg;
  const timeColor = isVoice ? PALETTE.green : PALETTE.blue;

  drawTileChrome(ctx, x, y, w, h, tileBg);

  const innerX = x + 14 * SCALE;
  const innerW = w - 28 * SCALE;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Top label row: "emoji SECTION" left, count right.
  const labelY = y + 18 * SCALE;
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText(`${opts.section.emoji} ${opts.section.title.toUpperCase()}`, innerX, labelY);

  ctx.textAlign = "right";
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(String(opts.section.memberCount), innerX + innerW, labelY);

  // Activity name.
  ctx.textAlign = "left";
  const nameFont = `bold ${15 * SCALE}px UI Bold`;
  const nameText = truncate(ctx, opts.row.display, innerW, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, innerX, y + 42 * SCALE);

  // Members line.
  const memberLabel = (() => {
    const names = opts.row.memberNames || [];
    const shown = names.slice(0, 3);
    const more = names.length - shown.length;
    if (shown.length === 0) return "";
    return `${shown.join(", ")}${more > 0 ? ` +${more}` : ""}`;
  })();
  if (memberLabel) {
    const memberFont = `${11 * SCALE}px UI`;
    const memberText = truncate(ctx, memberLabel, innerW, memberFont);
    ctx.font = memberFont;
    ctx.fillStyle = PALETTE.usersMuted;
    ctx.fillText(memberText, innerX, y + 58 * SCALE);
  }

  // Time.
  ctx.font = `bold ${17 * SCALE}px UI Bold`;
  ctx.fillStyle = timeColor;
  ctx.fillText(opts.row.timeStr, innerX, y + h - 18 * SCALE);

  // Bottom bar.
  const barValue = opts.barScale > 0 ? opts.row.minutes / opts.barScale : 0;
  drawTileBar(ctx, x, y, w, h, barValue, isVoice ? PALETTE.green : PALETTE.pink);
}

async function renderLiveActivity({ guildName, totalActive, sections }) {
  // Layout constants (1× logical pixels — multiplied by SCALE before drawing).
  const W = 960 * SCALE;
  const PAD = 20 * SCALE;
  const HEADER_H = 72 * SCALE;
  const GAP = 10 * SCALE;
  const EMPTY_PANEL_H = 80 * SCALE;
  const HERO_H = 232 * SCALE;

  const hasContent = Array.isArray(sections) && sections.length > 0;
  const bodyH = hasContent ? HERO_H : EMPTY_PANEL_H;
  const height = PAD + HEADER_H + GAP + bodyH + PAD;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");
  drawCanvasBackground(ctx, W, height);

  // ── Header (unchanged structurally) ───────────────────────────────────
  let y = PAD;
  ctx.fillStyle = PALETTE.usersPanel;
  roundRect(ctx, PAD, y, W - PAD * 2, HEADER_H, RADIUS * SCALE);
  ctx.fill();
  ctx.fillStyle = PALETTE.pink;
  roundRect(ctx, PAD, y, 4 * SCALE, HEADER_H, 2 * SCALE);
  ctx.fill();

  drawText(ctx, `Live Activity — ${guildName || ""}`,
    PAD + 24 * SCALE, y + 30 * SCALE,
    { size: 19 * SCALE, weight: "bold", color: PALETTE.usersText });
  drawText(ctx, "updates every 15 seconds",
    PAD + 24 * SCALE, y + 52 * SCALE,
    { size: 12 * SCALE, color: PALETTE.usersMuted });

  const activeRightX = W - PAD - 18 * SCALE;
  const dividerX = activeRightX - 80 * SCALE;
  ctx.strokeStyle = PALETTE.usersBorder;
  ctx.lineWidth = 1 * SCALE;
  ctx.beginPath();
  ctx.moveTo(dividerX, y + 18 * SCALE);
  ctx.lineTo(dividerX, y + HEADER_H - 18 * SCALE);
  ctx.stroke();
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText("ACTIVE", activeRightX, y + 30 * SCALE);
  ctx.font = `bold ${26 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.pink;
  ctx.fillText(String(totalActive ?? 0), activeRightX, y + 58 * SCALE);
  y += HEADER_H;

  // ── Empty state ───────────────────────────────────────────────────────
  if (!hasContent) {
    y += GAP;
    ctx.fillStyle = PALETTE.usersPanel;
    roundRect(ctx, PAD, y, W - PAD * 2, EMPTY_PANEL_H, RADIUS * SCALE);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${14 * SCALE}px UI`;
    ctx.fillStyle = PALETTE.usersDim;
    ctx.fillText("Nothing happening — go play something.",
      W / 2, y + EMPTY_PANEL_H / 2);
    return canvas.toBuffer("image/jpeg");
  }

  // ── Bento grid ────────────────────────────────────────────────────────
  y += GAP;
  const leader = selectLeader(sections);
  const others = sections.filter((s) => s !== leader);
  const innerW = W - PAD * 2;
  const grid = computeBentoGrid(innerW, HERO_H, GAP, others.length);

  // Bar scale: max minutes across all top rows of all displayed sections.
  const barScale = sections.reduce(
    (m, s) => Math.max(m, s.rows[0]?.minutes || 0),
    0,
  );

  // Hero.
  const heroRow = leader.rows[0];
  drawHeroTile(
    ctx,
    PAD + grid.heroRect.x,
    y + grid.heroRect.y,
    grid.heroRect.w,
    grid.heroRect.h,
    { section: leader, row: heroRow, barScale, minutes: heroRow.minutes },
  );

  // Smalls.
  others.forEach((section, i) => {
    const rect = grid.smallRects[i];
    const topRow = section.rows[0];
    drawSmallTile(
      ctx,
      PAD + rect.x,
      y + rect.y,
      rect.w,
      rect.h,
      { section, row: topRow, barScale },
    );
  });

  return canvas.toBuffer("image/jpeg");
}

// ── /stats voice — top users by 30d voice minutes ─────────────────────
function renderVoice30d({ guildName, totals, members }) {
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
  drawHeader(ctx, PADDING, y, WIDTH - PADDING * 2, "Top Voice Members — Last 30 Days", guildName, PALETTE.legacyGreen);
  y += headerH + GAP;

  const sumW = WIDTH - PADDING * 2;
  const leftW = Math.floor(sumW * 0.36);
  const rightW = sumW - leftW - GAP;
  drawBigStat(
    ctx, PADDING, y, leftW, summaryH,
    "30d Total VC",
    fmtTime(totals.month),
    `${totals.memberCount} members tracked`,
    PALETTE.legacyGreen,
  );
  drawTriStat(
    ctx, PADDING + leftW + GAP, y, rightW, summaryH,
    "Voice Activity",
    [
      { label: "1d", value: fmtTime(totals.day), color: PALETTE.voice },
      { label: "7d", value: fmtTime(totals.week), color: PALETTE.voice },
      { label: "30d", value: fmtTime(totals.month), color: PALETTE.voice },
    ],
  );
  y += summaryH + GAP;

  drawPanel(ctx, PADDING, y, sumW, listH);
  drawText(ctx, "TOP VOICE MEMBERS", PADDING + 14, y + 26, { size: 11, weight: "bold", color: PALETTE.muted });

  const rankColW = 28;
  const valueColX = PADDING + sumW - 14;
  const valueColW = 90;
  const nameX = PADDING + 14 + rankColW;

  memberRows.forEach((row, i) => {
    const ry = y + listHeaderH + rowH * i + rowH / 2 + 4;
    const rank = rankLabel(i);
    drawText(ctx, rank.text, PADDING + 14, ry, { size: 14, weight: "bold", color: rank.color });
    const nameText = truncate(ctx, row.displayName, 280, "bold 14px UI Bold");
    drawText(ctx, nameText, nameX, ry, { size: 14, weight: "bold" });
    drawText(ctx, `${row.percent}% of total`, valueColX - valueColW - 16, ry, {
      size: 12, color: PALETTE.muted, align: "right",
    });
    drawText(ctx, fmtTime(row.minutes), valueColX, ry, {
      size: 14, weight: "bold", color: PALETTE.voice, align: "right",
    });
  });

  return canvas.toBuffer("image/png");
}

// ── /playing — active game roles + member counts ──────────────────────
async function renderPlaying({ guildName, rows, totalActive, roleByName }) {
  const visibleRows = rows.slice(0, 12);

  // Pre-load role icons in parallel.
  const resolved = await Promise.all(visibleRows.map(async (r) => {
    const role = roleByName?.(r.roleName) || null;
    const icon = await loadRoleIconCached(role);
    return { row: r, icon, role };
  }));

  const headerH = 60;
  const summaryH = 80;
  const listHeaderH = 44;
  const rowH = 36;
  const listH = listHeaderH + rowH * visibleRows.length + 12;
  const height = PADDING * 2 + headerH + GAP + summaryH + GAP + listH;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");
  fillBackground(ctx, WIDTH, height);

  let y = PADDING;
  drawHeader(ctx, PADDING, y, WIDTH - PADDING * 2, "Currently Playing", guildName, PALETTE.yellow);
  y += headerH + GAP;

  const sumW = WIDTH - PADDING * 2;
  drawPanel(ctx, PADDING, y, sumW, summaryH);
  drawText(ctx, "ACTIVE NOW", PADDING + 14, y + 22, { size: 11, weight: "bold", color: PALETTE.muted });
  drawText(ctx, `${rows.length}`, PADDING + 14, y + 56, { size: 28, weight: "bold", color: PALETTE.yellow });
  drawText(ctx, `${rows.length === 1 ? "game" : "games"} · ${totalActive} ${totalActive === 1 ? "person" : "people"} playing`, PADDING + 50, y + 56, { size: 14, color: PALETTE.text });
  y += summaryH + GAP;

  drawPanel(ctx, PADDING, y, sumW, listH);
  drawText(ctx, "GAMES", PADDING + 14, y + 26, { size: 11, weight: "bold", color: PALETTE.muted });

  const valueColX = PADDING + sumW - 14;
  const iconColX = PADDING + 14;
  const nameX = iconColX + 32;

  resolved.forEach(({ row, icon }, i) => {
    const ry = y + listHeaderH + rowH * i + rowH / 2 + 4;

    if (icon) {
      ctx.save();
      ctx.beginPath();
      const iy = ry - 18 / 2 - 5;
      ctx.arc(iconColX + 12, iy + 12, 12, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(icon, iconColX, iy, 24, 24);
      ctx.restore();
    }

    const nameText = truncate(ctx, row.roleName, 360, "bold 14px UI Bold");
    drawText(ctx, nameText, nameX, ry, { size: 14, weight: "bold" });

    const countLabel = `${row.count} ${row.count === 1 ? "member" : "members"}`;
    drawText(ctx, countLabel, valueColX, ry, {
      size: 14, weight: "bold", color: PALETTE.accent, align: "right",
    });
  });

  return canvas.toBuffer("image/png");
}

module.exports = {
  renderUsersDefault,
  renderLiveActivity,
  LIVE_SECTIONS,
  renderVoice30d,
  renderPlaying,
  loadUserAvatarCached,
  __userAvatarCache: userAvatarCache,
  __selectLeader: selectLeader,
  __computeBentoGrid: computeBentoGrid,
  __drawHeroTile: drawHeroTile,
  __drawSmallTile: drawSmallTile,
  __drawMemberHeroTile: drawMemberHeroTile,
  __drawMemberPodiumTile: drawMemberPodiumTile,
  __drawLeaderboardRow: drawLeaderboardRow,
};
