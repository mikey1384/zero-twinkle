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

// The precheck (eligible COUNT / MAX(id) / id-set fingerprint) cannot see
// edits that change rollup columns without changing row eligibility — e.g. an
// imagePath backfill on an already-complete story
// (controllers/content/routes/aiStory/images.ts). This clamp bounds that
// staleness: after 6h a rebuild runs even if the precheck says nothing
// changed. It also backstops the fingerprint's ~2^-32 collision odds.
const FORCE_REBUILD_INTERVAL_MS = 6 * 60 * 60 * 1000;

let isRunning = false;
// Precheck snapshot taken just before the last successful rebuild. Stored
// pre-rebuild on purpose: a write racing the rebuild makes next tick's
// precheck mismatch and rebuild again (extra rebuild, never a missed one).
// In-memory by design — a process restart clears it and the next tick rebuilds.
let lastRebuildSnapshot = null;

async function rebuildAiStoryChapterStats() {
  if (isRunning) {
    console.log("⏭️  AI Story chapter stats already running, skipping...");
    return;
  }

  isRunning = true;
  const startedAt = Date.now();

  try {
    const builtAt = Math.floor(Date.now() / 1000);

    // Skip-no-op precheck: same eligibility predicate as the rebuild, encoded as
    // the isChapterEligible generated column so it reads from the covering index
    // idx_ai_stories_chapter_eligible (isChapterEligible, id) instead of
    // dereferencing every row's story TEXT to test the story != '' completion
    // check (see migration add-ai-stories-chapter-eligible-index.sql). The
    // BIT_XOR(CRC32(id)) fingerprint changes whenever the *set* of eligible ids
    // changes — inserts, deletes (listening.ts hard-deletes stale attempt
    // stories), draft->complete fills (socket/aiStory.ts), and balanced
    // remove-one/add-one swaps that keep COUNT and MAX(id) stable. Runs on the
    // read pool (no fromWriter) so quiet ticks never touch the writer at all;
    // a lagged replica read can only under-claim, which causes an extra
    // rebuild next tick, never a skipped change.
    const [
      { eligibleCount = 0, maxEligibleId = 0, eligibleIdsHash = 0 } = {},
    ] = await poolQuery(
      `SELECT COUNT(*) AS eligibleCount,
              COALESCE(MAX(s.id), 0) AS maxEligibleId,
              COALESCE(BIT_XOR(CRC32(s.id)), 0) AS eligibleIdsHash
       FROM ai_stories s
       WHERE s.isChapterEligible = 1`
    );

    if (
      lastRebuildSnapshot &&
      Number(lastRebuildSnapshot.eligibleCount) === Number(eligibleCount) &&
      Number(lastRebuildSnapshot.maxEligibleId) === Number(maxEligibleId) &&
      Number(lastRebuildSnapshot.eligibleIdsHash) === Number(eligibleIdsHash) &&
      startedAt - lastRebuildSnapshot.rebuiltAtMs < FORCE_REBUILD_INTERVAL_MS
    ) {
      console.log(
        "⏭️  AI Story chapter stats unchanged, skipping rebuild"
      );
      return;
    }

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

    lastRebuildSnapshot = {
      eligibleCount,
      maxEligibleId,
      eligibleIdsHash,
      rebuiltAtMs: Date.now(),
    };

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
