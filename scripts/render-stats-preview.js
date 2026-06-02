// Dev-only: render the !stats image with synthetic data and write to ./preview.jpg.
// Usage: node scripts/render-stats-preview.js
//
// roleByGameKey is stubbed to () => null so no Discord CDN role-icon fetches happen.
// The rendered image therefore has no role icons — verify layout/palette/text only.

const fs = require("fs");
const path = require("path");
const { renderUsersDefault } = require("../src/stats-image");

const members = [
  { userId: "1",  displayName: "Helmsy",      voiceMinutes: 47 * 60, gameMinutes: 38 * 60, topGame: { key: "Counter-Strike 2",  minutes: 38 * 60 } },
  { userId: "2",  displayName: "Anon42",      voiceMinutes: 32 * 60, gameMinutes: 21 * 60, topGame: { key: "Valorant",           minutes: 21 * 60 } },
  { userId: "3",  displayName: "Valkyrie_",   voiceMinutes: 28 * 60, gameMinutes: 15 * 60, topGame: { key: "Marvel Rivals",      minutes: 15 * 60 } },
  { userId: "4",  displayName: "shrimptank",  voiceMinutes: 19 * 60, gameMinutes: 12 * 60, topGame: { key: "League of Legends",  minutes: 12 * 60 } },
  { userId: "5",  displayName: "ghosthand",   voiceMinutes: 14 * 60, gameMinutes:  9 * 60, topGame: { key: "Hollow Knight",      minutes:  9 * 60 } },
  { userId: "6",  displayName: "mid_diff",    voiceMinutes: 11 * 60, gameMinutes:  7 * 60, topGame: { key: "Apex Legends",       minutes:  7 * 60 } },
  { userId: "7",  displayName: "Nyxe",        voiceMinutes:  9 * 60, gameMinutes:  6 * 60, topGame: { key: "Minecraft",          minutes:  6 * 60 } },
  { userId: "8",  displayName: "blunt force", voiceMinutes:  7 * 60, gameMinutes:  5 * 60, topGame: { key: "Helldivers 2",       minutes:  5 * 60 } },
  { userId: "9",  displayName: "cordless",    voiceMinutes:  6 * 60, gameMinutes:  3 * 60, topGame: { key: "Rocket League",      minutes:  3 * 60 } },
  { userId: "10", displayName: "Whiskey",     voiceMinutes:  4 * 60, gameMinutes:  2 * 60, topGame: { key: "Overwatch 2",        minutes:  2 * 60 } },
];

const totals = {
  voiceDay: 8 * 60 + 30,
  voiceWeek: 64 * 60,
  voiceMonth: 215 * 60,
  voiceLookback: members.reduce((s, m) => s + m.voiceMinutes, 0),
  gameLookback: members.reduce((s, m) => s + m.gameMinutes, 0),
  activeMembers: 23,
};

(async () => {
  const buffer = await renderUsersDefault({
    guildName: "wavwrld",
    title: "Top Members — Last 30 Days",
    lookbackLabel: "30d",
    totals,
    members,
    guild: null,
    roleByGameKey: () => null,
  });
  const out = path.resolve(__dirname, "..", "preview.jpg");
  fs.writeFileSync(out, buffer);
  console.log(`wrote ${out} (${buffer.length} bytes)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
