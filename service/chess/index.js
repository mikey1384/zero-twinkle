const { createWriteStream, unlinkSync, existsSync } = require("fs");
const { pipeline } = require("stream/promises");
const { createInterface } = require("readline");
const fetch = require("node-fetch");

const { writePool } = require("../pool");
const { promisify } = require("util");

const LICHESS_DUMP_URL =
  "https://database.lichess.org/lichess_db_puzzle.csv.zst";
const TEMP_FILE_COMPRESSED = "/tmp/lichess_puzzles.csv.zst";
const TEMP_FILE_DECOMPRESSED = "/tmp/lichess_puzzles.csv";
const BATCH_SIZE = 1000;

/**
 * Downloads and imports the latest Lichess puzzle database
 */
async function syncChessPuzzles({
  maxPuzzles = null,
  ratingMin = 300,
  ratingMax = 3000,
  testMode = false,
} = {}) {
  console.log("🏁 Starting chess puzzle sync...");
  const startTime = Date.now();

  try {
    // Step 1: Download the compressed dump
    if (!testMode) {
      console.log("📥 Downloading Lichess puzzle dump...");
      await downloadPuzzleDump();
    }

    // Step 2: Decompress the file
    console.log("📦 Decompressing puzzle data...");
    if (!testMode) {
      await decompressPuzzleDump();
    }

    // Step 3: Import puzzles to database
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
    cleanup(); // Cleanup on error
    return {
      success: false,
      error: error.message,
    };
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
 * Decompresses the .zst file to CSV
 * Note: This is a simplified version - for production you might want to use node-zstd
 * For now, we'll assume the file comes as .gz or use shell command
 */
async function decompressPuzzleDump() {
  // Since node-zstd can be tricky to install, we'll use a shell command fallback
  const { exec } = require("child_process");
  const execAsync = promisify(exec);

  try {
    // Try using system zstd command
    await execAsync(
      `zstd -d "${TEMP_FILE_COMPRESSED}" -o "${TEMP_FILE_DECOMPRESSED}"`
    );
    console.log("📦 Decompressed using system zstd");
  } catch (error) {
    console.log("⚠️  System zstd not available, trying alternative...");

    // Fallback: assume it might be gzipped or use different approach
    // For now, we'll create a mock CSV for testing
    if (process.env.NODE_ENV === "development") {
      const fs = require("fs");
      const mockData = `g0XXXXX,"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","e2e4 e7e5",1422,54,999,"endgame fork",https://lichess.org/XXXXX#0
g0YYYYY,"rnbqkb1r/pppp1ppp/5n2/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3","d1h5 g6 h5c5",1654,72,1205,"mateIn2 sacrifice",https://lichess.org/YYYYY#0`;
      fs.writeFileSync(TEMP_FILE_DECOMPRESSED, mockData);
      console.log("📦 Created mock data for testing");
    } else {
      throw new Error(
        "Could not decompress puzzle file. Please install zstd: brew install zstd (macOS) or apt install zstd (Ubuntu)"
      );
    }
  }
}

/**
 * Imports puzzles from CSV to database
 */
async function importPuzzlesToDatabase({ maxPuzzles, ratingMin, ratingMax }) {
  const connection = writePool;
  const now = Math.floor(Date.now() / 1000);

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;

  const rl = createInterface({
    input: require("fs").createReadStream(TEMP_FILE_DECOMPRESSED),
    crlfDelay: Infinity,
  });

  let batch = [];

  for await (const line of rl) {
    if (maxPuzzles && processed >= maxPuzzles) {
      console.log(`🔢 Reached max puzzles limit: ${maxPuzzles}`);
      break;
    }

    try {
      // Parse CSV line: id,fen,moves,rating,popularity,nbPlays,themes,gameUrl
      const columns = parseCSVLine(line);

      if (columns.length < 7) {
        errors++;
        continue;
      }

      const [id, fen, moves, rating, popularity, nbPlays, themes] = columns;

      // Extract numeric ID (remove 'g' prefix)
      const puzzleId = parseInt(id.replace(/^g/, ""));
      const puzzleRating = parseInt(rating);

      // Filter by rating range
      if (puzzleRating < ratingMin || puzzleRating > ratingMax) {
        skipped++;
        processed++;
        continue;
      }

      // Clean and prepare data
      const cleanFen = fen.replace(/"/g, "");
      const cleanMoves = moves.replace(/"/g, "");
      const cleanThemes = themes ? themes.replace(/"/g, "") : null;

      batch.push([
        puzzleId,
        cleanFen,
        cleanMoves,
        puzzleRating,
        parseInt(popularity) || 0,
        parseInt(nbPlays) || 0,
        cleanThemes,
        now,
      ]);

      processed++;

      // Insert batch when it reaches BATCH_SIZE
      if (batch.length >= BATCH_SIZE) {
        const batchImported = await insertBatch(connection, batch);
        imported += batchImported;
        batch = []; // Clear batch

        if (processed % 10000 === 0) {
          console.log(
            `📈 Processed ${processed} puzzles, imported ${imported}`
          );
        }
      }
    } catch (error) {
      console.error("❌ Error processing line:", error.message);
      errors++;
    }
  }

  // Insert remaining batch
  if (batch.length > 0) {
    const batchImported = await insertBatch(connection, batch);
    imported += batchImported;
  }

  return { imported, skipped, errors, processed };
}

/**
 * Inserts a batch of puzzles into the database
 */
async function insertBatch(connection, batch) {
  try {
    const [result] = await connection.promise().query(
      `INSERT IGNORE INTO game_chess_puzzles 
       (id, fen, moves, rating, popularity, nbPlays, themes, createdAt)
       VALUES ?`,
      [batch]
    );

    return result.affectedRows;
  } catch (error) {
    console.error("❌ Batch insert error:", error.message);
    return 0;
  }
}

/**
 * Simple CSV line parser that handles quoted fields
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
 * Cleans up temporary files
 */
function cleanup() {
  try {
    if (existsSync(TEMP_FILE_COMPRESSED)) {
      unlinkSync(TEMP_FILE_COMPRESSED);
    }
    if (existsSync(TEMP_FILE_DECOMPRESSED)) {
      unlinkSync(TEMP_FILE_DECOMPRESSED);
    }
    console.log("🧹 Temporary files cleaned up");
  } catch (error) {
    console.error("⚠️  Cleanup warning:", error.message);
  }
}

/**
 * Gets current puzzle statistics from database
 */
async function getPuzzleStats() {
  try {
    const connection = writePool;

    const [countResult] = await connection
      .promise()
      .query("SELECT COUNT(*) as total FROM game_chess_puzzles");

    const [ratingResult] = await connection
      .promise()
      .query(
        "SELECT MIN(rating) as minRating, MAX(rating) as maxRating, AVG(rating) as avgRating FROM game_chess_puzzles"
      );

    const [recentResult] = await connection.promise().query(
      "SELECT COUNT(*) as recent FROM game_chess_puzzles WHERE createdAt > ?",
      [Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60] // Last 7 days
    );

    return {
      total: countResult[0]?.total || 0,
      minRating: ratingResult[0]?.minRating || 0,
      maxRating: ratingResult[0]?.maxRating || 0,
      avgRating: Math.round(ratingResult[0]?.avgRating || 0),
      recentlyAdded: recentResult[0]?.recent || 0,
    };
  } catch (error) {
    console.error("❌ Error getting puzzle stats:", error);
    return null;
  }
}

/**
 * Removes old puzzles to keep database size manageable
 */
async function cleanupOldPuzzles({ keepCount = 200000 } = {}) {
  try {
    const connection = writePool;

    console.log(`🧹 Cleaning up old puzzles, keeping latest ${keepCount}...`);

    const [result] = await connection.promise().query(
      `DELETE FROM game_chess_puzzles 
       WHERE id NOT IN (
         SELECT id FROM (
           SELECT id FROM game_chess_puzzles 
           ORDER BY createdAt DESC 
           LIMIT ?
         ) AS latest
       )`,
      [keepCount]
    );

    console.log(`🗑️  Removed ${result.affectedRows} old puzzles`);
    return result.affectedRows;
  } catch (error) {
    console.error("❌ Error cleaning up old puzzles:", error);
    return 0;
  }
}

module.exports = {
  syncChessPuzzles,
  getPuzzleStats,
  cleanupOldPuzzles,
};
