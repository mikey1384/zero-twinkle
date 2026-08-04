const { poolQuery } = require("../helpers");
const { rotatePersistentStagingTable } = require("../helpers/tableRotation");

const TABLE = "content_words_rankings_all_time";
// These names deliberately do not overlap the legacy worker's _next/_prev
// tables, which makes the prerequisite migration safe during a rolling cutover.
const NEXT_TABLE = "content_words_rankings_all_time_staging";
const PREV_TABLE = "content_words_rankings_all_time_swap";

let isRunning = false;

async function refreshWordMasterRankings(query = poolQuery) {
  const updatedAt = Math.floor(Date.now() / 1000);

  await query(`TRUNCATE TABLE ${NEXT_TABLE}`, null, true);

  await query(
    `INSERT INTO ${NEXT_TABLE} (userId, numWords, globalRank, updatedAt)
     SELECT userId, numWords, globalRank, ? AS updatedAt
     FROM (
       SELECT
         userId,
         numWords,
         DENSE_RANK() OVER (ORDER BY numWords DESC) AS globalRank
       FROM (
         SELECT cw.userId, COUNT(*) AS numWords
         FROM content_words cw
         WHERE cw.userId > 0
         GROUP BY cw.userId
       ) counts
     ) ranked`,
    [updatedAt],
    true,
  );

  await rotatePersistentStagingTable({
    query,
    liveTable: TABLE,
    stagingTable: NEXT_TABLE,
    swapTable: PREV_TABLE,
  });
}

async function updateWordMasterRankings() {
  if (isRunning) {
    console.log("⏭️  Word Master rankings already running, skipping...");
    return;
  }

  isRunning = true;
  const startedAt = Date.now();

  try {
    await refreshWordMasterRankings();

    console.log(
      `✅ Word Master rankings updated in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
  } catch (error) {
    console.error("❌ Failed to update Word Master rankings:", error);
    throw error;
  } finally {
    isRunning = false;
  }
}

module.exports = {
  refreshWordMasterRankings,
  updateWordMasterRankings,
};
