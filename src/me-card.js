const { createCanvas } = require("@napi-rs/canvas");
const { PALETTE, SCALE, roundRect, drawText, truncate, drawCanvasBackground } = require("./stats-image");

// /me profile card, layout A: header, an all-time row (voice tile + top 3
// games), then a "This week" strip. Same palette, fonts, gradient and 2x
// density as the /stats users image.

const S = SCALE;
const W = 960 * S;
const PAD = 20 * S;
const GAP = 10 * S;
const HEADER_H = 84 * S;
const ROW_H = 150 * S;
const RADIUS = 8 * S;
const RANK_COLORS = [PALETTE.gold, PALETTE.silver, PALETTE.bronze];

// The owner asked for hours, so totals read "412h" rather than fmtTime's
// "17d 4h". Under an hour shows minutes.
function fmtHours(minutes) {
  if (minutes <= 0) return "0h";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return `${Math.round(minutes / 60).toLocaleString("en-US")}h`;
}

function panel(ctx, x, y, w, h, fill) {
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, RADIUS);
  ctx.fill();
  ctx.strokeStyle = PALETTE.usersBorder;
  ctx.lineWidth = 1 * S;
  ctx.stroke();
}

function label(ctx, text, x, y) {
  drawText(ctx, text.toUpperCase(), x, y, { size: 11 * S, weight: "bold", color: PALETTE.usersMuted });
}

function drawAvatar(ctx, avatar, name, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  if (avatar) {
    ctx.clip();
    ctx.drawImage(avatar, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = PALETTE.pink;
    ctx.fill();
    drawText(ctx, (name || "?").slice(0, 1).toUpperCase(), cx, cy, {
      size: 24 * S, weight: "bold", color: PALETTE.usersPanel, align: "center", baseline: "middle",
    });
  }
  ctx.restore();
}

// Ranked game rows (gold/silver/bronze badges), or the empty-state line.
function drawGameRows(ctx, games, x, y, w, emptyText) {
  if (!games.length) {
    drawText(ctx, emptyText, x, y + 20 * S, { size: 14 * S, color: PALETTE.usersDim });
    return;
  }
  const rowH = 32 * S;
  games.forEach((game, i) => {
    const cy = y + i * rowH + 12 * S;
    ctx.fillStyle = RANK_COLORS[i];
    ctx.beginPath();
    ctx.arc(x + 11 * S, cy, 11 * S, 0, Math.PI * 2);
    ctx.fill();
    drawText(ctx, String(i + 1), x + 11 * S, cy + 1 * S, {
      size: 12 * S, weight: "bold", color: PALETTE.usersPanel, align: "center", baseline: "middle",
    });

    const hours = fmtHours(game.minutes);
    const hoursFont = `bold ${15 * S}px UI Bold`;
    ctx.font = hoursFont;
    const hoursW = ctx.measureText(hours).width;
    drawText(ctx, hours, x + w, cy, { size: 15 * S, weight: "bold", color: PALETTE.blue, align: "right", baseline: "middle" });

    const nameFont = `${15 * S}px UI`;
    const name = truncate(ctx, game.name, w - 34 * S - hoursW - 12 * S, nameFont);
    drawText(ctx, name, x + 34 * S, cy, { size: 15 * S, color: PALETTE.usersText, baseline: "middle" });
  });
}

async function renderMeCard({ guildName, stats, avatar }) {
  const H = PAD + HEADER_H + GAP + ROW_H + GAP + ROW_H + PAD;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  drawCanvasBackground(ctx, W, H);
  const innerW = W - PAD * 2;

  // Header: avatar, name, "since tracking began · #N in <guild>".
  let y = PAD;
  panel(ctx, PAD, y, innerW, HEADER_H, PALETTE.usersPanel);
  ctx.fillStyle = PALETTE.pink;
  roundRect(ctx, PAD, y, 4 * S, HEADER_H, 2 * S);
  ctx.fill();
  drawAvatar(ctx, avatar, stats.displayName, PAD + 50 * S, y + HEADER_H / 2, 28 * S);
  const textX = PAD + 92 * S;
  const textW = innerW - 112 * S;
  drawText(ctx, truncate(ctx, stats.displayName, textW, `bold ${22 * S}px UI Bold`), textX, y + 36 * S,
    { size: 22 * S, weight: "bold", color: PALETTE.usersText });
  const rankText = stats.rank ? `#${stats.rank} in ${guildName}` : "unranked";
  drawText(ctx, truncate(ctx, `since tracking began · ${rankText}`, textW, `${13 * S}px UI`), textX, y + 60 * S,
    { size: 13 * S, color: PALETTE.usersMuted });

  // All-time row: voice tile (38%) + top games tile.
  y += HEADER_H + GAP;
  const voiceW = Math.round((innerW - GAP) * 0.38);
  const gamesW = innerW - GAP - voiceW;
  const inset = 18 * S;

  panel(ctx, PAD, y, voiceW, ROW_H, PALETTE.usersPanel);
  label(ctx, "Voice chat · all time", PAD + inset, y + 28 * S);
  drawText(ctx, truncate(ctx, fmtHours(stats.allTime.voiceMinutes), voiceW - inset * 2, `bold ${44 * S}px UI Bold`),
    PAD + inset, y + 92 * S, { size: 44 * S, weight: "bold", color: PALETTE.green });
  drawText(ctx, "across every voice channel", PAD + inset, y + 124 * S, { size: 12 * S, color: PALETTE.usersDim });

  const gamesX = PAD + voiceW + GAP;
  panel(ctx, gamesX, y, gamesW, ROW_H, PALETTE.usersPanel);
  label(ctx, "Top games · all time", gamesX + inset, y + 28 * S);
  drawGameRows(ctx, stats.allTime.topGames, gamesX + inset, y + 44 * S, gamesW - inset * 2, "No games tracked yet");

  // This week strip.
  y += ROW_H + GAP;
  panel(ctx, PAD, y, innerW, ROW_H, PALETTE.usersPanelPrimary);
  label(ctx, "This week", PAD + inset, y + 28 * S);
  drawText(ctx, truncate(ctx, fmtHours(stats.week.voiceMinutes), voiceW - inset * 2, `bold ${32 * S}px UI Bold`),
    PAD + inset, y + 84 * S, { size: 32 * S, weight: "bold", color: PALETTE.green });
  drawText(ctx, "in voice", PAD + inset, y + 110 * S, { size: 12 * S, color: PALETTE.usersDim });
  drawGameRows(ctx, stats.week.topGames, gamesX + inset, y + 44 * S, gamesW - inset * 2, "Nothing yet this week");

  return canvas.toBuffer("image/jpeg");
}

module.exports = { renderMeCard, fmtHours };
