// Dev-only: render the live-activity image with synthetic data and write to ./preview-live.jpg.
// Usage: node scripts/render-live-preview.js
//
// Icons are stubbed to null so the renderer does not hit Discord's CDN; verify
// layout/palette/text only. Eyeball against
// docs/live-activity-redesign/mockups/01-redesign.html.

const fs = require("fs");
const path = require("path");
const { renderLiveActivity } = require("../src/stats-image");

// Games are ranked (and shown) by *combined* current-player time — a game
// several people are playing right now outranks a longer solo session. That
// aggregation happens upstream (tracker.sumActiveElapsedMinutes); here we
// just author already-combined `minutes` values for a believable preview.
// Marvel Rivals (3 players, 96 combined) outranking Valorant (2 players, 92)
// despite a shorter individual per-player time is the case this is for.
const sections = [
  {
    key: "voice", title: "Voice", emoji: "🎤", memberCount: 4,
    rows: [
      { display: "General", timeStr: "1h 18m", minutes: 78, count: 3, memberNames: ["Helmsy", "mid_diff", "ghosthand"], avatars: [], extraCount: 0 },
      { display: "Music",   timeStr: "16m",    minutes: 16, count: 1, memberNames: ["cordless"], avatars: [], extraCount: 0 },
    ],
  },
  {
    key: "playing", title: "Playing", emoji: "🎮", memberCount: 11,
    rows: [
      { display: "Counter-Strike 2", timeStr: "2h 14m", minutes: 134, count: 4, memberNames: ["Helmsy", "Anon42", "shrimptank", "Dark"], avatars: [], extraCount: 0 },
      { display: "Marvel Rivals",    timeStr: "1h 36m", minutes:  96, count: 3, memberNames: ["Valkyrie_", "FAKKU", "Chayse"], avatars: [], extraCount: 0 },
      { display: "Valorant",         timeStr: "1h 32m", minutes:  92, count: 2, memberNames: ["shrimptank", "ghosthand"], avatars: [], extraCount: 0 },
      { display: "Hollow Knight",    timeStr: "55m",    minutes:  55, count: 1, memberNames: ["Nyxe"], avatars: [], extraCount: 0 },
      { display: "Helldivers 2",     timeStr: "41m",    minutes:  41, count: 2, memberNames: ["blunt force", "Whiskey"], avatars: [], extraCount: 0 },
      { display: "Rocket League",    timeStr: "22m",    minutes:  22, count: 1, memberNames: ["Dondo RF"], avatars: [], extraCount: 0 },
      { display: "Minecraft",        timeStr: "9m",     minutes:   9, count: 1, memberNames: ["spotlessname8"], avatars: [], extraCount: 0 },
    ],
  },
  {
    key: "listening", title: "Listening", emoji: "🎵", memberCount: 1,
    rows: [
      { display: "Spotify", timeStr: "24m", minutes: 24, count: 1, memberNames: ["cordless"], avatars: [], extraCount: 0 },
    ],
  },
];

(async () => {
  const buffer = await renderLiveActivity({
    guildName: "wavwrld",
    totalActive: 14,
    sections,
  });
  const out = path.resolve(__dirname, "..", "preview-live.jpg");
  fs.writeFileSync(out, buffer);
  console.log(`wrote ${out} (${buffer.length} bytes)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
