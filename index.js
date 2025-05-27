require("dotenv").config();

const {
  tagVideosToPlaylist,
  setPlaylistRewardLevel,
  checkAndTriggerRewardCard,
  syncChessPuzzles,
  cleanupOldPuzzles,
} = require("./service");

const tagVideosToPlaylistInterval = 60;
const setPlaylistRewardLevelInterval = 60;
const checkRewardCardInterval = 30;
const chessPuzzleSyncInterval = 86400; // 24 hours

let syncing = false;

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
      // Optional cleanup: keep DB size manageable
      console.log("🧹 Running puzzle cleanup...");
      await cleanupOldPuzzles({ keepCount: 200000 });
    } else {
      console.log("❌ Chess puzzle sync failed");
    }
  } catch (err) {
    console.error("❌ Chess puzzle sync error:", err);
  } finally {
    syncing = false;
  }
}

setInterval(tagVideosToPlaylist, tagVideosToPlaylistInterval * 1000);
setInterval(setPlaylistRewardLevel, setPlaylistRewardLevelInterval * 1000);
setInterval(checkAndTriggerRewardCard, checkRewardCardInterval * 1000);
setInterval(runChessSync, chessPuzzleSyncInterval * 1000);

// Optional: run chess sync immediately on startup
runChessSync();
