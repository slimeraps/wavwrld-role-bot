const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const { AttachmentBuilder } = require("discord.js");
const { activityStats, statsResetTimes, saveData } = require("./state");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// colors
const BG        = "#1e1f22";
const PANEL     = "#2b2d31";
const PANEL2    = "#232428";
const ACCENT    = "#5865f2";
const GREEN     = "#23a55a";
const TEXT      = "#dbdee1";
const MUTED     = "#949ba4";
const WHITE     = "#ffffff";
const GOLD      = "#f0b232";
const SILVER    = "#c0c0c0";
const BRONZE    = "#cd7f32";

function checkResets(guildId) {
  const now = Date.now();
  if (!statsResetTimes[guildId]) statsResetTimes[guildId] = { daily: now, weekly: now };
  if (!activityStats[guildId]) activityStats[guildId] = {};
  const times = statsResetTimes[guildId];
  const stats = activityStats[guildId];
  if (now - times.daily >= DAY_MS) {
    for (const name of Object.keys(stats)) stats[name].daily = 0;
    times.daily = now;
  }
  if (now - times.weekly >= WEEK_MS) {
    for (const name of Object.keys(stats)) stats[name].weekly = 0;
    times.weekly = now;
  }
}

function logActivity(guildId, activityName) {
  checkResets(guildId);
  if (!activityStats[guildId][activityName]) {
    activityStats[guildId][activityName] = { daily: 0, weekly: 0 };
  }
  activityStats[guildId][activityName].daily++;
  activityStats[guildId][activityName].weekly++;
  saveData();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function getMedalColor(i) {
  if (i === 0) return GOLD;
  if (i === 1) return SILVER;
  if (i === 2) return BRONZE;
  return MUTED;
}

function buildCard(guildName, sorted, period) {
  const W = 620;
  const H = 420;
  const PAD = 20;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // header panel
  ctx.fillStyle = PANEL2;
  roundRect(ctx, PAD, PAD, W - PAD * 2, 60, 10);
  ctx.fill();

  // header text - title
  ctx.fillStyle = WHITE;
  ctx.font = "bold 22px sans-serif";
  ctx.fillText("🎮  Activity Leaderboard", PAD + 16, PAD + 38);

  // header text - guild + period badge
  const periodLabel = period === "daily" ? "Today" : "This Week";
  ctx.fillStyle = ACCENT;
  roundRect(ctx, W - PAD - 90, PAD + 14, 80, 28, 6);
  ctx.fill();
  ctx.fillStyle = WHITE;
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(periodLabel, W - PAD - 50, PAD + 33);
  ctx.textAlign = "left";

  ctx.fillStyle = MUTED;
  ctx.font = "12px sans-serif";
  ctx.fillText(guildName, PAD + 16, PAD + 55);

  // leaderboard entries
  const top5 = sorted.slice(0, 5);
  const maxCount = top5[0]?.count || 1;
  const entryH = 52;
  const listTop = PAD + 80;

  top5.forEach((entry, i) => {
    const y = listTop + i * (entryH + 6);

    // row bg
    ctx.fillStyle = PANEL;
    roundRect(ctx, PAD, y, W - PAD * 2 - 180, entryH, 8);
    ctx.fill();

    // medal dot
    ctx.fillStyle = getMedalColor(i);
    ctx.beginPath();
    ctx.arc(PAD + 20, y + entryH / 2, 8, 0, Math.PI * 2);
    ctx.fill();

    // rank number
    ctx.fillStyle = getMedalColor(i);
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`#${i + 1}`, PAD + 20, y + entryH / 2 + 4);
    ctx.textAlign = "left";

    // game name
    ctx.fillStyle = TEXT;
    ctx.font = "bold 14px sans-serif";
    const nameMaxW = W - PAD * 2 - 180 - 60;
    let name = entry.name;
    while (ctx.measureText(name).width > nameMaxW && name.length > 0) {
      name = name.slice(0, -1);
    }
    if (name !== entry.name) name += "…";
    ctx.fillText(name, PAD + 40, y + 20);

    // session count
    ctx.fillStyle = MUTED;
    ctx.font = "11px sans-serif";
    ctx.fillText(`${entry.count} session${entry.count !== 1 ? "s" : ""}`, PAD + 40, y + 36);

    // progress bar bg
    const barX = PAD + 40;
    const barY = y + entryH - 8;
    const barW = W - PAD * 2 - 180 - 50;
    ctx.fillStyle = PANEL2;
    roundRect(ctx, barX, barY, barW, 4, 2);
    ctx.fill();

    // progress bar fill
    const fillW = Math.max((entry.count / maxCount) * barW, 6);
    ctx.fillStyle = i === 0 ? ACCENT : GREEN;
    roundRect(ctx, barX, barY, fillW, 4, 2);
    ctx.fill();
  });

  // bar chart panel (right side)
  const chartX = W - PAD - 170;
  const chartY = PAD + 80;
  const chartW = 165;
  const chartH = top5.length * (entryH + 6) - 6;

  ctx.fillStyle = PANEL;
  roundRect(ctx, chartX, chartY, chartW, chartH, 8);
  ctx.fill();

  ctx.fillStyle = MUTED;
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Sessions", chartX + chartW / 2, chartY + 16);
  ctx.textAlign = "left";

  const barAreaH = chartH - 40;
  const barAreaY = chartY + 25;
  const barGroupW = (chartW - 20) / Math.max(top5.length, 1);

  top5.forEach((entry, i) => {
    const bh = Math.max((entry.count / maxCount) * barAreaH, 4);
    const bx = chartX + 10 + i * barGroupW + barGroupW * 0.15;
    const bw = barGroupW * 0.7;
    const by = barAreaY + barAreaH - bh;

    ctx.fillStyle = i === 0 ? ACCENT : GREEN;
    roundRect(ctx, bx, by, bw, bh, 3);
    ctx.fill();

    // count label above bar
    ctx.fillStyle = TEXT;
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(entry.count, bx + bw / 2, by - 4);
    ctx.textAlign = "left";
  });

  // footer
  ctx.fillStyle = PANEL2;
  roundRect(ctx, PAD, H - 36, W - PAD * 2, 24, 6);
  ctx.fill();
  ctx.fillStyle = MUTED;
  ctx.font = "11px sans-serif";
  ctx.fillText(`Use !stats daily or !stats weekly to switch  ·  WAV WRLD Bot`, PAD + 12, H - 19);

  return canvas.toBuffer("image/png");
}

async function statsCmd(ctx, { period } = {}) {
  const guildId = ctx.guild?.id;
  if (!guildId) return ctx.reply("This command only works in a server.");

  checkResets(guildId);
  const stats = activityStats[guildId] || {};
  const key = period === "daily" ? "daily" : "weekly";

  const sorted = Object.entries(stats)
    .map(([name, counts]) => ({ name, count: counts[key] }))
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  if (sorted.length === 0) {
    return ctx.reply(`No activity tracked ${key === "daily" ? "today" : "this week"} yet.`);
  }

  const guildName = ctx.guild.name;
  const buffer = buildCard(guildName, sorted, period || "weekly");
  const attachment = new AttachmentBuilder(buffer, { name: "stats.png" });
  await ctx.reply({ files: [attachment] });
}

module.exports = { logActivity, statsCmd };