const { poolQuery } = require("../helpers");

const TABLE = "content_words_rankings_all_time";
const NEXT_TABLE = "content_words_rankings_all_time_next";
const PREV_TABLE = "content_words_rankings_all_time_prev";

let isRunning = false;

async function ensureTables() {
  await poolQuery(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      userId INT NOT NULL,
      numWords INT NOT NULL,
      globalRank INT NOT NULL,
      updatedAt INT NOT NULL,
      PRIMARY KEY (userId),
      KEY idx_globalRank (globalRank),
      KEY idx_numWords (numWords)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    null,
    true
  );

  await poolQuery(`CREATE TABLE IF NOT EXISTS ${NEXT_TABLE} LIKE ${TABLE}`, null, true);
}

async function updateWordMasterRankings() {
  if (isRunning) {
    console.log("⏭️  Word Master rankings already running, skipping...");
    return;
  }

  isRunning = true;
  const startedAt = Date.now();

  try {
    await ensureTables();

    const updatedAt = Math.floor(Date.now() / 1000);

    await poolQuery(`TRUNCATE TABLE ${NEXT_TABLE}`, null, true);

    await poolQuery(
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
      true
    );

    await poolQuery(`DROP TABLE IF EXISTS ${PREV_TABLE}`, null, true);
    await poolQuery(
      `RENAME TABLE ${TABLE} TO ${PREV_TABLE}, ${NEXT_TABLE} TO ${TABLE}`,
      null,
      true
    );
    await poolQuery(`DROP TABLE IF EXISTS ${PREV_TABLE}`, null, true);

    console.log(
      `✅ Word Master rankings updated in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );
  } catch (error) {
    console.error("❌ Failed to update Word Master rankings:", error);
  } finally {
    isRunning = false;
  }
}

module.exports = {
  updateWordMasterRankings,
};
