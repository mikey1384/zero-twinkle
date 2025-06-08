const { createWriteStream, unlinkSync, existsSync } = require("fs");
const { pipeline } = require("stream/promises");
const { createInterface } = require("readline");
const fetch = require("node-fetch");
const { promises: fs } = require("fs");
const path = require("path");

const { poolQuery } = require("../helpers");

const LICHESS_DUMP_URL =
  "https://database.lichess.org/lichess_db_puzzle.csv.zst";
// Use unique temp directories to prevent path collisions
let TEMP_DIR = null;
let TEMP_FILE_COMPRESSED = null;
let TEMP_FILE_DECOMPRESSED = null;
const BATCH_SIZE = 1000;

// Pre-compile regex patterns to reduce string allocations in hot loop
const QUOTE_REGEX = /"/g;
const G_PREFIX_REGEX = /^g/;

async function syncChessPuzzles({
  maxPuzzles = null,
  ratingMin = 300,
  ratingMax = 3000,
  testMode = false,
} = {}) {
  console.log("🏁 Starting chess puzzle sync...");
  const startTime = Date.now();

  // Create unique temp directory to prevent path collisions
  TEMP_DIR = await fs.mkdtemp("/tmp/lichess-");
  TEMP_FILE_COMPRESSED = path.join(TEMP_DIR, "lichess_puzzles.csv.zst");
  TEMP_FILE_DECOMPRESSED = path.join(TEMP_DIR, "lichess_puzzles.csv");

  try {
    if (!testMode) {
      console.log("📥 Downloading Lichess puzzle dump...");
      await downloadPuzzleDump();
    }

    console.log("📦 Decompressing puzzle data...");
    if (!testMode) {
      await decompressPuzzleDump();
    }

    console.log("💾 Importing puzzles to database...");
    const stats = await importPuzzlesToDatabase({
      maxPuzzles,
      ratingMin,
      ratingMax,
    });

    // Step 4: Cleanup
    console.log("🧹 Cleaning up temporary files...");
    if (!testMode) {
      cleanup();
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ Chess puzzle sync completed successfully!`);
    console.log(
      `📊 Stats: ${stats.imported} imported, ${stats.skipped} skipped, ${stats.errors} errors`
    );
    console.log(`⏱️  Duration: ${duration}s`);

    return {
      success: true,
      stats,
      duration,
    };
  } catch (error) {
    console.error("❌ Chess puzzle sync failed:", error);
    cleanup();
    return {
      success: false,
      error: error.message,
    };
  } finally {
    // Always cleanup temp directory
    cleanup();
  }
}

/**
 * Downloads the compressed puzzle dump from Lichess
 */
async function downloadPuzzleDump() {
  const response = await fetch(LICHESS_DUMP_URL);

  if (!response.ok) {
    throw new Error(`Failed to download puzzle dump: HTTP ${response.status}`);
  }

  await pipeline(response.body, createWriteStream(TEMP_FILE_COMPRESSED));

  console.log(
    `📥 Downloaded ${(
      response.headers.get("content-length") /
      1024 /
      1024
    ).toFixed(1)}MB`
  );
}

/**
 * Decompresses the .zst file to CSV using spawn to prevent stdout buffering
 */
async function decompressPuzzleDump() {
  const { spawn } = require("child_process");

  try {
    // Use spawn with stdio: 'inherit' to prevent stdout buffering issues
    const zstdProcess = spawn(
      "zstd",
      ["-d", TEMP_FILE_COMPRESSED, "-o", TEMP_FILE_DECOMPRESSED],
      {
        stdio: "inherit", // Prevent stdout buffering in Node's heap
      }
    );

    await new Promise((resolve, reject) => {
      zstdProcess.on("close", (code) => {
        if (code === 0) {
          console.log("📦 Decompressed using system zstd");
          resolve();
        } else {
          reject(new Error(`zstd process exited with code ${code}`));
        }
      });
      zstdProcess.on("error", reject);
    });
  } catch (error) {
    console.log("⚠️  System zstd not available, trying alternative...");

    // Fallback: assume it might be gzipped or use different approach
    // For now, we'll create a mock CSV for testing
    if (process.env.NODE_ENV === "development") {
      const mockData = `g0XXXXX,"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","e2e4 e7e5",1422,54,999,"endgame fork",https://lichess.org/XXXXX#0
g0YYYYY,"rnbqkb1r/pppp1ppp/5n2/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3","d1h5 g6 h5c5",1654,72,1205,"mateIn2 sacrifice",https://lichess.org/YYYYY#0`;
      await fs.writeFile(TEMP_FILE_DECOMPRESSED, mockData);
      console.log("📦 Created mock data for testing");
    } else {
      throw new Error(
        "Could not decompress puzzle file. Please install zstd: brew install zstd (macOS) or apt install zstd (Ubuntu)"
      );
    }
  }
}

/**
 * Safe batch insertion that always resets batch array to prevent memory leaks
 */
async function insertBatchSafe(batch) {
  if (!batch.length) return 0;

  try {
    const result = await poolQuery(
      `INSERT IGNORE INTO game_chess_puzzles
       (id, fen, moves, rating, popularity, nbPlays, themes, createdAt, movesCount)
       VALUES ?`,
      [batch]
    );
    return result.affectedRows ?? 0;
  } catch (error) {
    console.error("❌ Batch insert error:", error.message);
    return 0;
  } finally {
    // Always reset batch array to prevent memory retention on failure
    batch.length = 0;
  }
}

/**
 * Imports puzzles from CSV to database with back-pressure control
 */
async function importPuzzlesToDatabase({ maxPuzzles, ratingMin, ratingMax }) {
  const now = Math.floor(Date.now() / 1000);

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 10; // Circuit breaker

  const fileStream = require("fs").createReadStream(TEMP_FILE_DECOMPRESSED);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let batch = [];

  for await (const line of rl) {
    if (maxPuzzles && processed >= maxPuzzles) {
      console.log(`🔢 Reached max puzzles limit: ${maxPuzzles}`);
      break;
    }

    // Circuit breaker: stop processing after too many consecutive failures
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `❌ Too many consecutive failures (${consecutiveFailures}), stopping import`
      );
      break;
    }

    try {
      // Parse CSV line: id,fen,moves,rating,popularity,nbPlays,themes,gameUrl
      const columns = parseCSVLine(line);

      if (columns.length < 7) {
        errors++;
        consecutiveFailures++;
        continue;
      }

      const [id, fen, moves, rating, popularity, nbPlays, themes] = columns;

      // Extract numeric ID (remove 'g' prefix) - use pre-compiled regex
      const puzzleId = parseInt(id.replace(G_PREFIX_REGEX, ""));
      const puzzleRating = parseInt(rating);

      // Clean and prepare data - use pre-compiled regex to reduce allocations
      const cleanFen = fen.replace(QUOTE_REGEX, "");
      const cleanMoves = moves.replace(QUOTE_REGEX, "");
      const cleanThemes = themes ? themes.replace(QUOTE_REGEX, "") : null;

      // Count plies more efficiently to avoid split allocation
      let movesCount = 0;
      if (cleanMoves) {
        // Count spaces + 1 instead of splitting into array
        for (let i = 0; i < cleanMoves.length; i++) {
          if (cleanMoves[i] === " ") movesCount++;
        }
        movesCount++; // Add 1 for the last move
      }

      // Filter by rating range
      if (puzzleRating < ratingMin || puzzleRating > ratingMax) {
        skipped++;
        processed++;
        consecutiveFailures = 0; // Reset on successful processing
        continue;
      }

      batch.push([
        puzzleId,
        cleanFen,
        cleanMoves,
        puzzleRating,
        parseInt(popularity) || 0,
        parseInt(nbPlays) || 0,
        cleanThemes,
        now,
        movesCount,
      ]);

      processed++;
      consecutiveFailures = 0; // Reset on successful processing

      // Insert batch when it reaches BATCH_SIZE with back-pressure control
      if (batch.length >= BATCH_SIZE) {
        // Pause stream to provide back-pressure while MySQL processes batch
        fileStream.pause();

        const batchImported = await insertBatchSafe(batch);
        imported += batchImported;

        // Resume stream after batch is processed
        fileStream.resume();

        if (processed % 10000 === 0) {
          console.log(
            `📈 Processed ${processed} puzzles, imported ${imported}`
          );
        }
      }
    } catch (error) {
      console.error("❌ Error processing line:", error.message);
      errors++;
      consecutiveFailures++;
    }
  }

  // Insert remaining batch
  if (batch.length > 0) {
    const batchImported = await insertBatchSafe(batch);
    imported += batchImported;
  }

  return { imported, skipped, errors, processed };
}

/**
 * Simple CSV line parser that handles quoted fields
 * Note: This is a character-by-character parser which can be memory intensive
 * For production, consider using a streaming CSV library like csv-parse
 */
function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim()); // Add the last field
  return result;
}

/**
 * Cleans up temporary files and directory
 */
function cleanup() {
  try {
    if (TEMP_DIR && existsSync(TEMP_DIR)) {
      // Remove all files in temp directory
      if (existsSync(TEMP_FILE_COMPRESSED)) {
        unlinkSync(TEMP_FILE_COMPRESSED);
      }
      if (existsSync(TEMP_FILE_DECOMPRESSED)) {
        unlinkSync(TEMP_FILE_DECOMPRESSED);
      }
      // Remove the temp directory itself
      require("fs").rmSync(TEMP_DIR, { recursive: true, force: true });
      console.log("🧹 Temporary directory cleaned up");
    }
  } catch (error) {
    console.error("⚠️  Cleanup warning:", error.message);
  }
}

/**
 * Cleans up old puzzles to keep database size manageable
 */
async function cleanupOldPuzzles({ keepCount = 200000 } = {}) {
  try {
    console.log(
      `🧹 Starting puzzle cleanup, keeping ${keepCount} newest puzzles...`
    );

    // Delete older puzzles, keeping only the newest ones by creation date
    const result = await poolQuery(
      `DELETE FROM game_chess_puzzles 
       WHERE id NOT IN (
         SELECT id FROM (
           SELECT id FROM game_chess_puzzles 
           ORDER BY createdAt DESC 
           LIMIT ?
         ) AS newest_puzzles
       )`,
      [keepCount]
    );

    const deletedCount = result.affectedRows ?? 0;
    console.log(
      `🧹 Puzzle cleanup completed: ${deletedCount} old puzzles removed`
    );

    return { deletedCount };
  } catch (error) {
    console.error("❌ Puzzle cleanup error:", error.message);
    return { deletedCount: 0, error: error.message };
  }
}

module.exports = {
  syncChessPuzzles,
  cleanupOldPuzzles,
};
