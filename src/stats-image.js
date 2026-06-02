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

// Render one podium card (used 3x by renderUsersDefault).
// All coordinates and sizes are *already scaled* (caller multiplied by SCALE).
//
// opts:
//   rankLabel:    string, e.g. "1ST" / "2ND" / "3RD"
//   rankColor:    PALETTE.gold | silver | bronze
//   icon:         loaded Image | null  (Discord role icon)
//   name:         string (display name)
//   gameLabel:    string (e.g. "Counter-Strike 2 · 38h"), or null
//   hoursLabel:   string (e.g. "47h")
//   isPrimary:    boolean — true for the gold #1 center card
function drawPodCard(ctx, x, y, w, h, opts) {
  // Card body.
  const fill = opts.isPrimary ? PALETTE.usersPanelPrimary : PALETTE.usersPanel;
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, RADIUS * SCALE);
  ctx.fill();
  if (opts.isPrimary) {
    ctx.strokeStyle = PALETTE.pinkBorder;
    ctx.lineWidth = 1 * SCALE;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, RADIUS * SCALE);
    ctx.stroke();
  }

  const cx = x + w / 2;
  let cy = y + 22 * SCALE;

  // Rank label, centered.
  ctx.fillStyle = opts.rankColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${12 * SCALE}px UI Bold`;
  ctx.fillText(opts.rankLabel, cx, cy);
  cy += 14 * SCALE;

  // Round-clipped role icon.
  const iconSize = (opts.isPrimary ? 80 : 64) * SCALE;
  cy += iconSize / 2; // shift to icon center
  if (opts.icon) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(opts.icon, cx - iconSize / 2, cy - iconSize / 2, iconSize, iconSize);
    ctx.restore();
  } else {
    // No icon — draw a subtle filled circle so the layout doesn't collapse.
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }
  cy += iconSize / 2 + 14 * SCALE;

  // Name (truncated to card width).
  const nameSize = (opts.isPrimary ? 18 : 16) * SCALE;
  const nameFont = `bold ${nameSize}px UI Bold`;
  const nameText = truncate(ctx, opts.name, w - 24 * SCALE, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, cx, cy);
  cy += 6 * SCALE + 12 * SCALE; // line height for the 16-18px name

  // Game label (or skip).
  if (opts.gameLabel) {
    const gameFont = `${12 * SCALE}px UI`;
    const gameText = truncate(ctx, opts.gameLabel, w - 24 * SCALE, gameFont);
    ctx.font = gameFont;
    ctx.fillStyle = PALETTE.usersMuted;
    ctx.fillText(gameText, cx, cy);
  }
  cy += 14 * SCALE + 12 * SCALE;

  // Hours value, large.
  const hoursSize = (opts.isPrimary ? 26 : 20) * SCALE;
  const hoursColor = opts.isPrimary ? PALETTE.pink : PALETTE.blue;
  ctx.font = `bold ${hoursSize}px UI Bold`;
  ctx.fillStyle = hoursColor;
  ctx.fillText(opts.hoursLabel, cx, cy);
}

// Render one row of the 4-10 list with a pink-ghost progress bar background.
// All coordinates and sizes are already scaled by the caller.
//
// opts:
//   rank:        number (4..10)
//   icon:        loaded Image | null
//   name:        string
//   gameLabel:   string (e.g. "League of Legends · 12h") or null
//   hoursLabel:  string (e.g. "19h")
//   barPct:      0..1, width of the ghost progress bar relative to row width
function drawProgressRow(ctx, x, y, w, h, opts) {
  // Clip to row rect so the bar can't escape (it shouldn't anyway, defensive).
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // Progress bar (background fill, left-aligned).
  if (opts.barPct > 0) {
    ctx.fillStyle = PALETTE.pinkGhost;
    ctx.fillRect(x, y, w * Math.min(1, opts.barPct), h);
  }

  const innerPad = 18 * SCALE;
  const cy = y + h / 2;
  ctx.textBaseline = "middle";

  // Rank number — small, dim, fixed-width gutter.
  const rankGutter = 28 * SCALE;
  ctx.textAlign = "center";
  ctx.font = `bold ${13 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersDim;
  ctx.fillText(String(opts.rank), x + innerPad + rankGutter / 2, cy);

  // Role icon (round-clipped), 24px logical.
  const iconSize = 24 * SCALE;
  const iconX = x + innerPad + rankGutter + 10 * SCALE;
  const iconY = cy - iconSize / 2;
  if (opts.icon) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(iconX + iconSize / 2, iconY + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(opts.icon, iconX, iconY, iconSize, iconSize);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(iconX + iconSize / 2, iconY + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }

  // Layout for name + game + hours.
  ctx.textAlign = "left";
  const hoursLabel = opts.hoursLabel || "";
  ctx.font = `bold ${14 * SCALE}px UI Bold`;
  const hoursWidth = ctx.measureText(hoursLabel).width;
  const hoursRightX = x + w - innerPad;
  const hoursLeftX = hoursRightX - hoursWidth;

  // Hours (right-aligned). Caller picks the color (blue by default, green for voice).
  ctx.textAlign = "right";
  ctx.fillStyle = opts.timeColor || PALETTE.blue;
  ctx.fillText(hoursLabel, hoursRightX, cy);

  // Available horizontal range for name + game.
  const textStartX = iconX + iconSize + 10 * SCALE;
  const textEndX = hoursLeftX - 12 * SCALE;
  const textRange = textEndX - textStartX;

  // Name takes the left ~45% of the available range; game takes the right ~55%.
  const nameMax = Math.max(0, textRange * 0.45);
  const gameMax = Math.max(0, textRange * 0.55 - 8 * SCALE);

  // Name (left).
  ctx.textAlign = "left";
  const nameFont = `bold ${14 * SCALE}px UI Bold`;
  const nameText = truncate(ctx, opts.name, nameMax, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, textStartX, cy);

  // Game label (left-aligned, starts after the name's max gutter).
  if (opts.gameLabel) {
    const gameFont = `${12 * SCALE}px UI`;
    const gameStart = textStartX + nameMax + 8 * SCALE;
    const gameText = truncate(ctx, opts.gameLabel, gameMax, gameFont);
    ctx.font = gameFont;
    ctx.fillStyle = PALETTE.usersMuted;
    ctx.fillText(gameText, gameStart, cy);
  }

  ctx.restore();
}

// Section header used by renderLiveActivity. Draws a single line at the top of
// each section panel: SECTION TITLE (left) · subtitle (right). All coordinates
// are already scaled by the caller.
function drawSectionHeader(ctx, x, y, w, { title, subtitle, accent }) {
  const padX = 18 * SCALE;
  drawText(ctx, title.toUpperCase(), x + padX, y,
    { size: 10 * SCALE, weight: "bold", color: accent || PALETTE.usersMuted });
  if (subtitle) {
    drawText(ctx, subtitle, x + w - padX, y,
      { size: 10 * SCALE, color: PALETTE.usersDim, align: "right" });
  }
  // Divider line beneath the header — runs full panel width.
  ctx.strokeStyle = PALETTE.usersBorder;
  ctx.lineWidth = 1 * SCALE;
  ctx.beginPath();
  ctx.moveTo(x, y + 10 * SCALE);
  ctx.lineTo(x + w, y + 10 * SCALE);
  ctx.stroke();
}

async function renderUsersDefault({ guildName, title, totals, members, roleByGameKey }) {
  const memberRows = members.slice(0, 10);
  const podiumRows = memberRows.slice(0, 3);
  const listRows = memberRows.slice(3);

  // Resolve + load all role icons in parallel before drawing.
  const resolved = await Promise.all(memberRows.map(async (r) => {
    if (!r.topGame) return { row: r, icon: null };
    const role = roleByGameKey?.(r.topGame.key) || null;
    const icon = await loadRoleIconCached(role);
    return { row: r, icon };
  }));

  // Layout (all values 1x-logical; multiply by SCALE before drawing).
  const W = 720 * SCALE;
  const PAD = 20 * SCALE;
  const HEADER_H = 72 * SCALE;
  const SEC_GAP = 14 * SCALE;
  const POD_GAP = 12 * SCALE;
  const POD_SIDE_H = 232 * SCALE;
  const POD_CENTER_H = 256 * SCALE;
  const LIST_PAD_TOP = 12 * SCALE;
  const LIST_HEADER_H = 30 * SCALE;
  const ROW_H = 36 * SCALE;

  const listH = listRows.length > 0
    ? LIST_PAD_TOP + LIST_HEADER_H + ROW_H * listRows.length + LIST_PAD_TOP
    : 0;
  const podH = podiumRows.length > 0 ? POD_CENTER_H : 0;
  const height = PAD
    + HEADER_H
    + (podH > 0 ? SEC_GAP + podH : 0)
    + (listH > 0 ? SEC_GAP + listH : 0)
    + PAD;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");
  drawCanvasBackground(ctx, W, height);

  // ── Header ────────────────────────────────────────────────────────────
  let y = PAD;
  ctx.fillStyle = PALETTE.usersPanel;
  roundRect(ctx, PAD, y, W - PAD * 2, HEADER_H, RADIUS * SCALE);
  ctx.fill();
  // Pink accent bar on the left edge of the header panel.
  ctx.fillStyle = PALETTE.pink;
  roundRect(ctx, PAD, y, 4 * SCALE, HEADER_H, 2 * SCALE);
  ctx.fill();

  // Title + sub on the left.
  drawText(ctx, title || "Top Members — Last 30 Days",
    PAD + 24 * SCALE, y + 30 * SCALE,
    { size: 19 * SCALE, weight: "bold", color: PALETTE.usersText });
  drawText(ctx, guildName || "",
    PAD + 24 * SCALE, y + 52 * SCALE,
    { size: 12 * SCALE, color: PALETTE.usersMuted });

  // ACTIVE badge on the right.
  const activeRightX = W - PAD - 18 * SCALE;
  const dividerX = activeRightX - 80 * SCALE; // small gutter for the divider
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

  // ── Podium ────────────────────────────────────────────────────────────
  if (podiumRows.length > 0) {
    y += SEC_GAP;
    const podRow = y;
    const innerW = W - PAD * 2;
    const cardW = Math.floor((innerW - POD_GAP * 2) / 3);

    const xs = [PAD, PAD + cardW + POD_GAP, PAD + (cardW + POD_GAP) * 2];
    // Card order on screen: silver(left), gold(center), bronze(right).
    // memberRows indexes: [0]=gold #1, [1]=silver #2, [2]=bronze #3.
    const slots = [
      { row: podiumRows[1], icon: resolved[1]?.icon, rankLabel: "2ND", rankColor: PALETTE.silver, isPrimary: false, x: xs[0], h: POD_SIDE_H },
      { row: podiumRows[0], icon: resolved[0]?.icon, rankLabel: "1ST", rankColor: PALETTE.gold,   isPrimary: true,  x: xs[1], h: POD_CENTER_H },
      { row: podiumRows[2], icon: resolved[2]?.icon, rankLabel: "3RD", rankColor: PALETTE.bronze, isPrimary: false, x: xs[2], h: POD_SIDE_H },
    ].filter((s) => s.row); // gracefully drop slots if <3 members

    for (const slot of slots) {
      const cardY = podRow + (POD_CENTER_H - slot.h); // bottom-align cards
      const gameLabel = slot.row.topGame
        ? `${slot.row.topGame.key} · ${fmtTime(slot.row.topGame.minutes)}`
        : null;
      drawPodCard(ctx, slot.x, cardY, cardW, slot.h, {
        rankLabel: slot.rankLabel,
        rankColor: slot.rankColor,
        icon: slot.icon,
        name: slot.row.displayName,
        gameLabel,
        hoursLabel: fmtTime(slot.row.voiceMinutes),
        isPrimary: slot.isPrimary,
      });
    }
    y += POD_CENTER_H;
  }

  // ── List 4..10 ────────────────────────────────────────────────────────
  if (listRows.length > 0) {
    y += SEC_GAP;
    const innerW = W - PAD * 2;
    ctx.fillStyle = PALETTE.usersPanel;
    roundRect(ctx, PAD, y, innerW, listH, RADIUS * SCALE);
    ctx.fill();

    // Section header label.
    drawText(ctx, "TOP MEMBERS 4–10",
      PAD + 18 * SCALE, y + LIST_PAD_TOP + 18 * SCALE,
      { size: 10 * SCALE, weight: "bold", color: PALETTE.usersMuted });

    // Divider beneath the header.
    ctx.strokeStyle = PALETTE.usersBorder;
    ctx.lineWidth = 1 * SCALE;
    ctx.beginPath();
    const divY = y + LIST_PAD_TOP + LIST_HEADER_H - 1 * SCALE;
    ctx.moveTo(PAD, divY);
    ctx.lineTo(PAD + innerW, divY);
    ctx.stroke();

    // Find leader of positions 4..N for bar scaling.
    const topVoice = listRows.reduce((m, r) => Math.max(m, r.voiceMinutes), 0);

    listRows.forEach((row, i) => {
      const rowY = y + LIST_PAD_TOP + LIST_HEADER_H + ROW_H * i;
      const icon = resolved[i + 3]?.icon || null;
      const gameLabel = row.topGame
        ? `${row.topGame.key} · ${fmtTime(row.topGame.minutes)}`
        : null;
      const barPct = topVoice > 0 ? row.voiceMinutes / topVoice : 0;
      drawProgressRow(ctx, PAD, rowY, innerW, ROW_H, {
        rank: i + 4,
        icon,
        name: row.displayName,
        gameLabel,
        hoursLabel: fmtTime(row.voiceMinutes),
        barPct,
      });
    });
  }

  return canvas.toBuffer("image/jpeg");
}

// Section order and visual treatment. Voice has its own green accent;
// everything else uses the standard pink/blue language.
const LIVE_SECTIONS = [
  { key: "playing",   title: "Playing",   emoji: "🎮" },
  { key: "voice",     title: "Voice",     emoji: "🎤", accent: "green" },
  { key: "listening", title: "Listening", emoji: "🎵" },
  { key: "watching",  title: "Watching",  emoji: "📺" },
  { key: "other",     title: "Other",     emoji: "🟣" },
];

async function renderLiveActivity({ guildName, totalActive, sections }) {
  // Layout constants (1× logical pixels — multiplied by SCALE before drawing).
  const W = 720 * SCALE;
  const PAD = 20 * SCALE;
  const HEADER_H = 72 * SCALE;
  const SEC_GAP = 12 * SCALE;
  const SEC_HEADER_TOP = 18 * SCALE;       // y offset from top of section panel to header text
  const SEC_HEADER_BLOCK = 30 * SCALE;     // total vertical space the header occupies
  const SEC_PAD_BOTTOM = 12 * SCALE;
  const ROW_H = 36 * SCALE;
  const EMPTY_PANEL_H = 80 * SCALE;

  const hasContent = sections && sections.length > 0;

  // Compute total height.
  const sectionHeights = (sections || []).map((s) =>
    SEC_HEADER_BLOCK + ROW_H * s.rows.length + SEC_PAD_BOTTOM,
  );
  const sectionsTotal = sectionHeights.reduce(
    (sum, h) => sum + SEC_GAP + h,
    0,
  );
  const bodyH = hasContent ? sectionsTotal : SEC_GAP + EMPTY_PANEL_H;
  const height = PAD + HEADER_H + bodyH + PAD;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");
  drawCanvasBackground(ctx, W, height);

  // ── Header ────────────────────────────────────────────────────────────
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
    y += SEC_GAP;
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

  // ── Sections ──────────────────────────────────────────────────────────
  // Bar scale uses the leader across all sections so bars are comparable.
  const topMinutes = sections.reduce((max, s) =>
    s.rows.reduce((m, r) => Math.max(m, r.minutes), max),
  0);

  sections.forEach((section, i) => {
    y += SEC_GAP;
    const innerW = W - PAD * 2;
    const sectionH = sectionHeights[i];

    // Section panel.
    ctx.fillStyle = PALETTE.usersPanel;
    roundRect(ctx, PAD, y, innerW, sectionH, RADIUS * SCALE);
    ctx.fill();

    // Header line (title left, subtitle right).
    const isVoice = section.key === "voice";
    const accentColor = isVoice ? PALETTE.green : PALETTE.usersMuted;
    const headerTitle = `${section.emoji} ${section.title}`;
    const roleWord = section.rows.length === 1 ? "role" : "roles";
    const memberWord = section.memberCount === 1 ? "member" : "members";
    const headerSub = `${section.rows.length} ${roleWord} · ${section.memberCount} ${memberWord}`;
    drawSectionHeader(ctx, PAD, y + SEC_HEADER_TOP, innerW, {
      title: headerTitle,
      subtitle: headerSub,
      accent: accentColor,
    });

    // Rows.
    section.rows.forEach((row, j) => {
      const rowY = y + SEC_HEADER_BLOCK + ROW_H * j;
      // Members column doubles as the "game label" slot in drawProgressRow.
      const shown = row.memberNames.slice(0, 3);
      const extra = row.memberNames.length > shown.length
        ? ` +${row.memberNames.length - shown.length}`
        : "";
      const memberLabel = shown.length > 0 ? `${shown.join(", ")}${extra}` : "";
      const barPct = topMinutes > 0 ? row.minutes / topMinutes : 0;

      // drawProgressRow expects a rank value; live activity has no ranking, so
      // pass an empty string and let the renderer's center-aligned slot stay
      // blank. We reuse drawProgressRow's icon + name + label + time columns.
      drawProgressRow(ctx, PAD, rowY, innerW, ROW_H, {
        rank: "",
        icon: row.icon,
        name: row.display,
        gameLabel: memberLabel,
        hoursLabel: row.timeStr,
        barPct,
        timeColor: isVoice ? PALETTE.green : PALETTE.blue,
      });
    });

    y += sectionH;
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
};
