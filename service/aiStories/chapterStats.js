const { poolQuery } = require("../helpers");

// ai_stories remains authoritative. Database triggers enqueue immutable old /
// new group identities in ai_story_chapter_dirty_events in the same transaction
// as every source mutation. This worker recomputes only those groups, never
// guesses counter deltas, and removes an event batch only after all projection
// writes succeed. A crash therefore replays work instead of losing it.
const DIRTY_EVENTS_TABLE = "ai_story_chapter_dirty_events";
const STATS_TABLE = "ai_story_chapter_stats";
const SOURCE_GROUP_INDEX =
  "idx_ai_stories_deleted_storyby_difficulty_type_topic";

const EVENT_BATCH_SIZE = 500;
const MAX_BATCHES_PER_RUN = 20;
const MAX_RUN_MS = 20_000;

let isRunning = false;

function dirtyGroupsSql({ bootstrap, includeUnauthored }) {
  return `SELECT e.storyBy, e.difficulty, e.type, e.topicKey
          FROM ${DIRTY_EVENTS_TABLE} e
          WHERE e.isBootstrap = ${bootstrap ? 1 : 0}
            AND e.id IN (?)
            AND e.storyBy ${includeUnauthored ? "=" : "!="} ''
          GROUP BY e.storyBy, e.difficulty, e.type, e.topicKey`;
}

function buildUpsertSql({ bootstrap, includeUnauthored }) {
  const sourceAuthorJoin = includeUnauthored
    ? "(s.storyBy IS NULL OR s.storyBy = '')"
    : "s.storyBy = d.storyBy";

  return `INSERT INTO ${STATS_TABLE}
            (storyBy, difficulty, type, topicKey, sampleTopic, storyCount,
             readingCount, listeningCount, imageCount, questionCount,
             latestStoryId, latestTimeStamp, builtAt)
          SELECT
            d.storyBy,
            d.difficulty,
            d.type,
            d.topicKey,
            LEFT(COALESCE(MAX(s.topic), ''), 255) AS sampleTopic,
            COUNT(*) AS storyCount,
            SUM(CASE WHEN s.isListening = 1 THEN 0 ELSE 1 END) AS readingCount,
            SUM(CASE WHEN s.isListening = 1 THEN 1 ELSE 0 END) AS listeningCount,
            SUM(CASE WHEN s.imagePath IS NOT NULL AND s.imagePath != '' THEN 1 ELSE 0 END) AS imageCount,
            SUM(CASE WHEN s.questions IS NOT NULL AND s.questions != '' THEN 1 ELSE 0 END) AS questionCount,
            MAX(s.id) AS latestStoryId,
            MAX(s.timeStamp) AS latestTimeStamp,
            ? AS builtAt
          FROM (${dirtyGroupsSql({ bootstrap, includeUnauthored })}) d
          STRAIGHT_JOIN ai_stories s FORCE INDEX (${SOURCE_GROUP_INDEX})
            ON s.isDeleted = 0
           AND ${sourceAuthorJoin}
           AND s.difficulty = d.difficulty
           AND s.type = d.type
           AND s.topicKey = d.topicKey
          WHERE s.story IS NOT NULL AND s.story != ''
          GROUP BY d.storyBy, d.difficulty, d.type, d.topicKey
          ON DUPLICATE KEY UPDATE
            sampleTopic = VALUES(sampleTopic),
            storyCount = VALUES(storyCount),
            readingCount = VALUES(readingCount),
            listeningCount = VALUES(listeningCount),
            imageCount = VALUES(imageCount),
            questionCount = VALUES(questionCount),
            latestStoryId = VALUES(latestStoryId),
            latestTimeStamp = VALUES(latestTimeStamp),
            builtAt = VALUES(builtAt)`;
}

function buildDeleteEmptySql({ bootstrap, includeUnauthored }) {
  const sourceAuthorJoin = includeUnauthored
    ? "(s.storyBy IS NULL OR s.storyBy = '')"
    : "s.storyBy = d.storyBy";

  return `DELETE cs
          FROM (${dirtyGroupsSql({ bootstrap, includeUnauthored })}) d
          STRAIGHT_JOIN ${STATS_TABLE} cs
            ON cs.storyBy = d.storyBy
           AND cs.difficulty = d.difficulty
           AND cs.type = d.type
           AND cs.topicKey = d.topicKey
          LEFT JOIN ai_stories s FORCE INDEX (${SOURCE_GROUP_INDEX})
            ON s.isDeleted = 0
           AND ${sourceAuthorJoin}
           AND s.difficulty = d.difficulty
           AND s.type = d.type
           AND s.topicKey = d.topicKey
           AND s.story IS NOT NULL
           AND s.story != ''
          WHERE s.id IS NULL`;
}

async function processAiStoryChapterStatsBatch({
  bootstrap,
  batchSize = EVENT_BATCH_SIZE,
  query = poolQuery,
  now = () => Date.now(),
}) {
  const events = await query(
    `SELECT id, queuedAt
     FROM ${DIRTY_EVENTS_TABLE}
     WHERE isBootstrap = ?
     ORDER BY id ASC
     LIMIT ?`,
    [bootstrap ? 1 : 0, batchSize],
    true,
  );
  if (!events.length) {
    return { processed: 0, oldestAgeSeconds: 0 };
  }

  const eventIds = events.map((event) => Number(event.id));
  const builtAt = Math.floor(now() / 1000);

  // Authored groups retain the exact indexed ref join verified in production.
  // The unauthored branch is separate so its NULL-or-empty compatibility path
  // cannot degrade the common author-index plan.
  for (const includeUnauthored of [false, true]) {
    await query(
      buildUpsertSql({ bootstrap, includeUnauthored }),
      [builtAt, eventIds],
      true,
    );
    await query(
      buildDeleteEmptySql({ bootstrap, includeUnauthored }),
      [eventIds],
      true,
    );
  }

  // Delete only the exact immutable ids selected by this priority batch. Do
  // not use an id range: auto-increment ids can commit out of order, so an
  // older id that was uncommitted (and invisible) during recompute must remain.
  await query(
    `DELETE FROM ${DIRTY_EVENTS_TABLE}
     WHERE id IN (?)`,
    [eventIds],
    true,
  );

  const oldestQueuedAt = Math.min(
    ...events.map((event) => Number(event.queuedAt || builtAt)),
  );
  return {
    processed: events.length,
    eventIds,
    oldestAgeSeconds: Math.max(0, builtAt - oldestQueuedAt),
  };
}

async function refreshAiStoryChapterStats({
  query = poolQuery,
  now = () => Date.now(),
} = {}) {
  if (isRunning) {
    console.log("⏭️  AI Story chapter stats refresh already running, skipping...");
    return;
  }

  isRunning = true;
  const startedAt = now();
  let batches = 0;
  let liveEventsProcessed = 0;
  let bootstrapEventsProcessed = 0;
  let oldestAgeSeconds = 0;

  try {
    while (batches < MAX_BATCHES_PER_RUN && now() - startedAt < MAX_RUN_MS) {
      let madeProgress = false;

      // Live writes always go first, so a one-time bootstrap cannot make newly
      // completed stories wait behind historical reconciliation.
      const liveResult = await processAiStoryChapterStatsBatch({
        bootstrap: false,
        query,
        now,
      });
      if (liveResult.processed) {
        madeProgress = true;
        batches += 1;
        liveEventsProcessed += liveResult.processed;
        oldestAgeSeconds = Math.max(
          oldestAgeSeconds,
          liveResult.oldestAgeSeconds,
        );
      }

      if (batches >= MAX_BATCHES_PER_RUN || now() - startedAt >= MAX_RUN_MS) {
        break;
      }

      // Always give bootstrap one bounded batch per loop as well, preventing
      // continuous live traffic from starving deployment reconciliation.
      const bootstrapResult = await processAiStoryChapterStatsBatch({
        bootstrap: true,
        query,
        now,
      });
      if (bootstrapResult.processed) {
        madeProgress = true;
        batches += 1;
        bootstrapEventsProcessed += bootstrapResult.processed;
      }

      if (!madeProgress) {
        break;
      }
    }

    if (liveEventsProcessed || bootstrapEventsProcessed) {
      const [{ pendingEvents = 0, pendingLiveEvents = 0 } = {}] = await query(
        `SELECT COUNT(*) AS pendingEvents,
                COALESCE(SUM(isBootstrap = 0), 0) AS pendingLiveEvents
         FROM ${DIRTY_EVENTS_TABLE}`,
        null,
        true,
      );
      console.log(
        `✅ AI Story chapter stats refreshed ` +
          `(live=${liveEventsProcessed}, bootstrap=${bootstrapEventsProcessed}, ` +
          `pending=${Number(pendingEvents)}, pendingLive=${Number(
            pendingLiveEvents,
          )}, oldestLive=${oldestAgeSeconds}s, duration=${(
            (now() - startedAt) /
            1000
          ).toFixed(1)}s)`,
      );
    }
  } catch (error) {
    console.error("❌ Failed to refresh AI Story chapter stats:", error);
    throw error;
  } finally {
    isRunning = false;
  }
}

module.exports = {
  buildDeleteEmptySql,
  buildUpsertSql,
  processAiStoryChapterStatsBatch,
  refreshAiStoryChapterStats,
};
