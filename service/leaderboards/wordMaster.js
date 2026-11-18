const { writePool } = require('../pool');
const { replaceTableContents } = require('../helpers/tableRotation');
const TABLE = 'content_words_rankings_all_time';

let isRunning = false;

async function refreshWordMasterRankings(pool = writePool.promise()) {
  const updatedAt = Math.floor(Date.now() / 1000);

  await replaceTableContents({ pool, table: TABLE, populate: async conn => {
    await conn.query(
    `INSERT INTO ${TABLE} (userId, numWords, globalRank, updatedAt)
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
      [updatedAt]
    );
  }});
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
