const { poolQuery } = require("../helpers");

// Chapter-grain rollup of the AI Story library index. Rebuilt wholesale so it
// can never drift and so the heavy GROUP BY over ai_stories (with the
// story != '' completed-story predicate) runs here in the background, never in
// a user request. twinkle-api reads ai_story_chapter_stats for the author /
// book / chapter landings; ai_stories stays the source for story bodies.
// Both TABLE and NEXT_TABLE are provisioned by the
// add-ai-story-chapter-stats-rollup migration; this task never creates schema.
// TMP_TABLE is only a transient name used inside the atomic 3-way RENAME swap.
const TABLE = "ai_story_chapter_stats";
const NEXT_TABLE = "ai_story_chapter_stats_next";
const TMP_TABLE = "ai_story_chapter_stats_swap_tmp";

let isRunning = false;

async function rebuildAiStoryChapterStats() {
  if (isRunning) {
    console.log("⏭️  AI Story chapter stats already running, skipping...");
    return;
  }

  isRunning = true;
  const startedAt = Date.now();

  try {
    const builtAt = Math.floor(Date.now() / 1000);

    await poolQuery(`TRUNCATE TABLE ${NEXT_TABLE}`, null, true);

    // The one heavy aggregation, run in the background. story != '' keeps the
    // rollup to completed stories so counts/latestStoryId match list/get.
    await poolQuery(
      // No storyBy predicate: unauthored stories (null/empty storyBy, e.g.
      // legacy/imported) belong in the non-author indexes just like the live
      // ai_stories aggregation includes them. NULL storyBy is coalesced to ''
      // so it forms one "unauthored" bucket; the author read excludes it.
      `INSERT INTO ${NEXT_TABLE}
        (storyBy, difficulty, type, topicKey, sampleTopic, storyCount,
         readingCount, listeningCount, imageCount, questionCount,
         latestStoryId, latestTimeStamp, builtAt)
       SELECT
         COALESCE(s.storyBy, '') AS storyBy,
         s.difficulty,
         s.type,
         s.topicKey,
         -- Display-only; COALESCE guards an all-NULL group (NOT NULL column)
         -- and LEFT caps to the column width so one oversized/NULL topic can't
         -- abort the rebuild and leave the rollup stale. Mirrors the migration.
         LEFT(COALESCE(MAX(s.topic), ''), 255) AS sampleTopic,
         COUNT(*) AS storyCount,
         SUM(CASE WHEN s.isListening = 1 THEN 0 ELSE 1 END) AS readingCount,
         SUM(CASE WHEN s.isListening = 1 THEN 1 ELSE 0 END) AS listeningCount,
         SUM(CASE WHEN s.imagePath IS NOT NULL AND s.imagePath != '' THEN 1 ELSE 0 END) AS imageCount,
         SUM(CASE WHEN s.questions IS NOT NULL AND s.questions != '' THEN 1 ELSE 0 END) AS questionCount,
         MAX(s.id) AS latestStoryId,
         MAX(s.timeStamp) AS latestTimeStamp,
         ? AS builtAt
       FROM ai_stories s
       WHERE s.isDeleted = 0
         AND s.story IS NOT NULL AND s.story != ''
         AND s.type IS NOT NULL AND s.type != ''
         AND s.topicKey IS NOT NULL AND s.topicKey != ''
       GROUP BY COALESCE(s.storyBy, ''), s.difficulty, s.type, s.topicKey`,
      [builtAt],
      true
    );

    // Atomic 3-way swap: live <-> next, keeping both persistent tables (TMP is
    // only a transient rename slot). DROP IF EXISTS guards a crashed prior swap;
    // it only ever touches the ephemeral TMP name, never a provisioned table.
    await poolQuery(`DROP TABLE IF EXISTS ${TMP_TABLE}`, null, true);
    await poolQuery(
      `RENAME TABLE ${TABLE} TO ${TMP_TABLE}, ${NEXT_TABLE} TO ${TABLE}, ${TMP_TABLE} TO ${NEXT_TABLE}`,
      null,
      true
    );

    const [{ chapterCount = 0 } = {}] = await poolQuery(
      `SELECT COUNT(*) AS chapterCount FROM ${TABLE}`,
      null,
      true
    );
    console.log(
      `✅ AI Story chapter stats rebuilt (${chapterCount} chapters) in ${(
        (Date.now() - startedAt) /
        1000
      ).toFixed(1)}s`
    );
  } catch (error) {
    console.error("❌ Failed to rebuild AI Story chapter stats:", error);
  } finally {
    isRunning = false;
  }
}

module.exports = {
  rebuildAiStoryChapterStats,
};
