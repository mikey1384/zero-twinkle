require("dotenv").config();
const fs = require("fs");
const path = require("path");

const {
  tagVideosToPlaylist,
  setPlaylistRewardLevel,
  checkAndTriggerRewardCard,
  updateWordMasterRankings,
  runEchoNotifications,
  purgeExpiredPendingEchoSignups,
  reconcileEchoSubscriptions,
  // syncChessPuzzles,
} = require("./service");

const HEARTBEAT_FILE = path.resolve(
  process.env.AIZERO_HEARTBEAT_FILE || "/tmp/aizero-heartbeat.json"
);
const HEARTBEAT_INTERVAL_SECONDS = Number(
  process.env.AIZERO_HEARTBEAT_INTERVAL_SECONDS || 15
);
const EXIT_ON_FATAL = process.env.AIZERO_EXIT_ON_FATAL !== "0";
const tasks = [
  {
    name: "tagVideosToPlaylist",
    fn: tagVideosToPlaylist,
    intervalSeconds: 60,
  },
  {
    name: "setPlaylistRewardLevel",
    fn: setPlaylistRewardLevel,
    intervalSeconds: 60,
  },
  {
    name: "checkAndTriggerRewardCard",
    fn: checkAndTriggerRewardCard,
    intervalSeconds: 30,
  },
  {
    name: "updateWordMasterRankings",
    fn: updateWordMasterRankings,
    intervalSeconds: 900,
  },
  {
    name: "runEchoNotifications",
    fn: runEchoNotifications,
    intervalSeconds: 900,
    alignToInterval: true,
    alignmentGraceSeconds: 60,
  },
  {
    name: "purgeExpiredPendingEchoSignups",
    fn: purgeExpiredPendingEchoSignups,
    intervalSeconds: 3600,
    alignToInterval: true,
    alignmentGraceSeconds: 60,
  },
  {
    name: "reconcileEchoSubscriptions",
    fn: reconcileEchoSubscriptions,
    intervalSeconds: 3600,
    alignToInterval: true,
    alignmentGraceSeconds: 60,
  },
];
const taskState = new Map(
  tasks.map((task) => [
    task.name,
    {
      running: false,
      runCount: 0,
      errorCount: 0,
      lastStartAt: null,
      lastFinishAt: null,
      lastDurationMs: null,
      lastErrorAt: null,
      lastErrorMessage: null,
    },
  ])
);
// const chessPuzzleSyncInterval = 86400; // 24 hours

//let syncing = false;
let shuttingDown = false;

function safeErrorMessage(error) {
  if (!error) return "unknown";
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function getDelayUntilNextInterval(task) {
  const intervalMs = task.intervalSeconds * 1000;
  const graceMs = (task.alignmentGraceSeconds || 0) * 1000;
  const remainderMs = Date.now() % intervalMs;

  if (remainderMs === 0) {
    return 0;
  }

  if (graceMs > 0 && remainderMs < graceMs) {
    return 0;
  }

  return intervalMs - remainderMs;
}

function writeHeartbeat(extra = {}) {
  const payload = {
    at: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    shuttingDown,
    taskState: Object.fromEntries(taskState),
    ...extra,
  };

  try {
    fs.writeFileSync(HEARTBEAT_FILE, `${JSON.stringify(payload)}\n`);
  } catch (error) {
    console.error("[heartbeat] failed to write heartbeat:", safeErrorMessage(error));
  }
}

async function runTask(task) {
  if (shuttingDown) {
    return;
  }

  const state = taskState.get(task.name);
  if (!state) {
    return;
  }

  if (state.running) {
    console.warn(`[${task.name}] previous run still active; skipping overlap`);
    writeHeartbeat({ overlapSkippedTask: task.name });
    return;
  }

  const start = Date.now();
  state.running = true;
  state.lastStartAt = new Date(start).toISOString();
  writeHeartbeat({ activeTask: task.name });

  try {
    await task.fn();
    state.runCount += 1;
  } catch (error) {
    state.errorCount += 1;
    state.lastErrorAt = new Date().toISOString();
    state.lastErrorMessage = safeErrorMessage(error);
    console.error(`[${task.name}] task failed:`, error);
  } finally {
    state.running = false;
    state.lastFinishAt = new Date().toISOString();
    state.lastDurationMs = Date.now() - start;
    writeHeartbeat();
  }
}

function scheduleTask(task) {
  const run = () => {
    void runTask(task);
  };

  if (task.alignToInterval) {
    const startAlignedInterval = () => {
      run();

      const interval = setInterval(run, task.intervalSeconds * 1000);
      global.twinkleIntervals.push(interval);
    };

    const delayMs = getDelayUntilNextInterval(task);
    const nextDelayMs =
      task.intervalSeconds * 1000 -
      (Date.now() % (task.intervalSeconds * 1000));

    if (delayMs === 0) {
      run();

      const timeout = setTimeout(startAlignedInterval, nextDelayMs);
      global.twinkleIntervals.push(timeout);
      return;
    }

    const timeout = setTimeout(startAlignedInterval, delayMs);

    global.twinkleIntervals.push(timeout);
    return;
  }

  const interval = setInterval(() => {
    run();
  }, task.intervalSeconds * 1000);
  global.twinkleIntervals.push(interval);
}

function shutdown(signal, code) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[shutdown] received ${signal}, cleaning up intervals...`);
  global.twinkleIntervals.forEach(clearInterval);
  writeHeartbeat({ shutdownSignal: signal });
  process.exit(code);
}

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
tasks.forEach(scheduleTask);

const heartbeatInterval = setInterval(() => {
  writeHeartbeat();
}, HEARTBEAT_INTERVAL_SECONDS * 1000);
global.twinkleIntervals.push(heartbeatInterval);

console.log(`🚀 Started ${global.twinkleIntervals.length} intervals`);
writeHeartbeat({ startup: true });

// Graceful shutdown handler
process.on("SIGINT", () => {
  shutdown("SIGINT", 0);
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM", 0);
});

process.on("uncaughtException", (error) => {
  console.error("[fatal] uncaughtException:", error);
  if (EXIT_ON_FATAL) {
    shutdown("uncaughtException", 1);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
  if (EXIT_ON_FATAL) {
    shutdown("unhandledRejection", 1);
  }
});

// runChessSync();
