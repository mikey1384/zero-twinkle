require("dotenv").config();

const {
  tagVideosToPlaylist,
  setPlaylistRewardLevel,
  checkAndTriggerRewardCard,
  // syncChessPuzzles,
} = require("./service");

const tagVideosToPlaylistInterval = 60;
const setPlaylistRewardLevelInterval = 60;
const checkRewardCardInterval = 30;
// const chessPuzzleSyncInterval = 86400; // 24 hours

//let syncing = false;

// Prevent interval stacking on PM2 hot-reloads
if (global.twinkleIntervals) {
  console.log("🔄 Clearing existing intervals to prevent stacking...");
  global.twinkleIntervals.forEach(clearInterval);
}
global.twinkleIntervals = [];

/*
async function runChessSync() {
  if (syncing) {
    console.log("⏭️  Chess puzzle sync already running, skipping...");
    return;
  }

  syncing = true;
  try {
    console.log("🚀 Starting chess puzzle sync...");
    const { success, stats } = await syncChessPuzzles({
      maxPuzzles: null, // full import
      ratingMin: 300,
      ratingMax: 3000,
      testMode: false,
    });

    if (success) {
      console.log("✅ Chess puzzle sync completed successfully", stats);
    } else {
      console.log("❌ Chess puzzle sync failed");
    }
  } catch (err) {
    console.error("❌ Chess puzzle sync error:", err);
  } finally {
    syncing = false;
  }
}

*/

// Setup intervals and track them to prevent stacking
global.twinkleIntervals.push(
  setInterval(tagVideosToPlaylist, tagVideosToPlaylistInterval * 1000),
  setInterval(setPlaylistRewardLevel, setPlaylistRewardLevelInterval * 1000),
  setInterval(checkAndTriggerRewardCard, checkRewardCardInterval * 1000)
);

console.log(`🚀 Started ${global.twinkleIntervals.length} intervals`);

// Graceful shutdown handler
process.on("SIGINT", () => {
  console.log("🛑 Received SIGINT, cleaning up intervals...");
  global.twinkleIntervals.forEach(clearInterval);
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("🛑 Received SIGTERM, cleaning up intervals...");
  global.twinkleIntervals.forEach(clearInterval);
  process.exit(0);
});

// runChessSync();
