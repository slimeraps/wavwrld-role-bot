// Dev-only: render the live-activity image with synthetic data and write to ./preview-live.jpg.
// Usage: node scripts/render-live-preview.js
//
// Icons are stubbed to null so the renderer does not hit Discord's CDN; verify
// layout/palette/text only. Eyeball against
// docs/live-activity-redesign/mockups/01-redesign.html.

const fs = require("fs");
const path = require("path");
const { renderLiveActivity } = require("../src/stats-image");

const sections = [
  {
    key: "playing", title: "Playing", emoji: "🎮", memberCount: 9,
    rows: [
      { display: "Counter-Strike 2", timeStr: "2h 14m", minutes: 134, count: 4, memberNames: ["Helmsy", "Anon42", "mid_diff", "shrimptank"], icon: null },
      { display: "Valorant",         timeStr: "1h 32m", minutes:  92, count: 2, memberNames: ["shrimptank", "ghosthand"], icon: null },
      { display: "Marvel Rivals",    timeStr: "55m",    minutes:  55, count: 1, memberNames: ["Valkyrie_"], icon: null },
      { display: "Hollow Knight",    timeStr: "33m",    minutes:  33, count: 1, memberNames: ["Nyxe"], icon: null },
      { display: "Helldivers 2",     timeStr: "11m",    minutes:  11, count: 1, memberNames: ["blunt force"], icon: null },
    ],
  },
  {
    key: "voice", title: "Voice", emoji: "🎤", memberCount: 4,
    rows: [
      { display: "General", timeStr: "1h 18m", minutes: 78, count: 3, memberNames: ["Helmsy", "mid_diff", "ghosthand"], icon: null },
      { display: "Music",   timeStr: "16m",    minutes: 16, count: 1, memberNames: ["cordless"], icon: null },
    ],
  },
  {
    key: "listening", title: "Listening", emoji: "🎵", memberCount: 1,
    rows: [
      { display: "Spotify", timeStr: "24m", minutes: 24, count: 1, memberNames: ["Whiskey"], icon: null },
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
