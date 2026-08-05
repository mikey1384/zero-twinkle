const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDeleteEmptySql,
  buildUpsertSql,
  processAiStoryChapterStatsBatch,
  refreshAiStoryChapterStats,
} = require("../service/aiStories/chapterStats");

test("dirty-group refresh uses the indexed source group and exact canonical aggregates", () => {
  const upsertSql = buildUpsertSql({
    bootstrap: false,
    includeUnauthored: false,
  });
  const deleteSql = buildDeleteEmptySql({
    bootstrap: false,
    includeUnauthored: false,
  });

  assert.match(
    upsertSql,
    /FORCE INDEX \(idx_ai_stories_deleted_storyby_difficulty_type_topic\)/,
  );
  assert.match(upsertSql, /s\.story IS NOT NULL AND s\.story != ''/);
  assert.match(upsertSql, /SUM\(CASE WHEN s\.isListening = 1/);
  assert.match(upsertSql, /s\.imagePath IS NOT NULL/);
  assert.match(upsertSql, /s\.questions IS NOT NULL/);
  assert.match(upsertSql, /ON DUPLICATE KEY UPDATE/);
  assert.match(deleteSql, /LEFT JOIN ai_stories/);
  assert.match(deleteSql, /WHERE s\.id IS NULL/);
  assert.match(deleteSql, /cs\.topicKey = d\.topicKey/);
  assert.doesNotMatch(deleteSql, /COLLATE/);
  assert.doesNotMatch(upsertSql, /TRUNCATE|RENAME TABLE/i);
});

test("a processed batch deletes only selected immutable event ids", async () => {
  const events = [
    { id: 12, queuedAt: 1_700_000_001, isBootstrap: 0, visible: true },
    { id: 13, queuedAt: 1_700_000_000, isBootstrap: 0, visible: true },
    // Auto-increment allocation can precede commit. This older id is invisible
    // to the SELECT, then commits while projection queries are running.
    { id: 11, queuedAt: 1_699_999_999, isBootstrap: 0, visible: false },
  ];
  const calls = [];
  const nowMs = 1_700_000_100_000;

  async function query(sql, params, fromWriter) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, params, fromWriter });
    if (normalized.startsWith("SELECT id, queuedAt")) {
      const [isBootstrap, limit] = params;
      return events
        .filter(
          (event) => event.isBootstrap === isBootstrap && event.visible,
        )
        .slice(0, limit);
    }
    events.find((event) => event.id === 11).visible = true;
    if (normalized.startsWith("DELETE FROM ai_story_chapter_dirty_events")) {
      const [eventIds] = params;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (eventIds.includes(events[index].id)) {
          events.splice(index, 1);
        }
      }
    }
    return { affectedRows: 0 };
  }

  const result = await processAiStoryChapterStatsBatch({
    bootstrap: false,
    batchSize: 2,
    query,
    now: () => nowMs,
  });

  assert.equal(result.processed, 2);
  assert.deepEqual(result.eventIds, [12, 13]);
  assert.equal(result.oldestAgeSeconds, 100);
  assert.deepEqual(events, [
    { id: 11, queuedAt: 1_699_999_999, isBootstrap: 0, visible: true },
  ]);
  assert.equal(calls.length, 6);
  assert.equal(
    calls[calls.length - 1].sql.startsWith(
      "DELETE FROM ai_story_chapter_dirty_events",
    ),
    true,
  );
  assert.deepEqual(calls[calls.length - 1].params, [[12, 13]]);
  assert.equal(calls.every((call) => call.fromWriter === true), true);
});

test("a failed projection leaves the selected events for restart-safe replay", async () => {
  const calls = [];
  await assert.rejects(
    processAiStoryChapterStatsBatch({
      bootstrap: false,
      query: async (sql, params, fromWriter) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, params, fromWriter });
        if (normalized.startsWith("SELECT id, queuedAt")) {
          return [{ id: 21, queuedAt: 1_700_000_000 }];
        }
        throw new Error("projection interrupted");
      },
    }),
    /projection interrupted/,
  );

  assert.equal(calls.length, 2);
  assert.equal(
    calls.some((call) =>
      call.sql.startsWith("DELETE FROM ai_story_chapter_dirty_events"),
    ),
    false,
  );
});

test("an empty priority batch performs no projection mutation", async () => {
  const calls = [];
  const result = await processAiStoryChapterStatsBatch({
    bootstrap: true,
    query: async (sql, params, fromWriter) => {
      calls.push({ sql, params, fromWriter });
      return [];
    },
  });

  assert.deepEqual(result, { processed: 0, oldestAgeSeconds: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fromWriter, true);
});

test("refresh gives live events first priority while bootstrap still advances", async () => {
  const selectedPriorities = [];
  let liveAvailable = true;
  let bootstrapAvailable = true;

  await refreshAiStoryChapterStats({
    now: () => 1_800_000_000_000,
    query: async (sql, params, fromWriter) => {
      assert.equal(fromWriter, true);
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, queuedAt")) {
        const [isBootstrap] = params;
        selectedPriorities.push(isBootstrap);
        if (isBootstrap && bootstrapAvailable) {
          bootstrapAvailable = false;
          return [{ id: 31, queuedAt: 1_799_999_999 }];
        }
        if (!isBootstrap && liveAvailable) {
          liveAvailable = false;
          return [{ id: 30, queuedAt: 1_799_999_999 }];
        }
        return [];
      }
      if (normalized.startsWith("SELECT COUNT(*) AS pendingEvents")) {
        return [{ pendingEvents: 0, pendingLiveEvents: 0 }];
      }
      return { affectedRows: 1 };
    },
  });

  assert.deepEqual(selectedPriorities, [0, 1, 0, 1]);
});
