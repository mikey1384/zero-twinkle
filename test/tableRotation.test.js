const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  rotatePersistentStagingTable,
} = require("../service/helpers/tableRotation");

test("persistent table rotation is one writer-owned atomic three-name swap", async () => {
  const calls = [];
  await rotatePersistentStagingTable({
    query: async (sql, params, fromWriter) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params, fromWriter });
    },
    liveTable: "live_table",
    stagingTable: "next_table",
    swapTable: "swap_table",
  });

  assert.deepEqual(calls, [
    {
      sql: "RENAME TABLE `live_table` TO `swap_table`, `next_table` TO `live_table`, `swap_table` TO `next_table`",
      params: null,
      fromWriter: true,
    },
  ]);
});

test("persistent table rotation rejects unsafe or overlapping table names before querying", async () => {
  let queryAttempted = false;
  const query = async () => {
    queryAttempted = true;
  };

  await assert.rejects(
    rotatePersistentStagingTable({
      query,
      liveTable: "live; DROP TABLE users",
      stagingTable: "next_table",
      swapTable: "swap_table",
    }),
    /Invalid table identifier/,
  );
  await assert.rejects(
    rotatePersistentStagingTable({
      query,
      liveTable: "live_table",
      stagingTable: "live_table",
      swapTable: "swap_table",
    }),
    /must be distinct/,
  );
  assert.equal(queryAttempted, false);
});

test("wholesale recurring rollup workers use the shared rotation and perform no runtime schema create or drop", () => {
  for (const relativePath of ["service/leaderboards/wordMaster.js"]) {
    const source = readFileSync(
      path.resolve(__dirname, "..", relativePath),
      "utf8",
    );
    assert.match(source, /rotatePersistentStagingTable\(\{/);
    assert.doesNotMatch(source, /\b(?:CREATE|DROP|ALTER)\s+TABLE\b/i);
  }
});

test("AI Story chapter maintenance is event-driven and owns no runtime schema", () => {
  const source = readFileSync(
    path.resolve(
      __dirname,
      "..",
      "service/aiStories/chapterStats.js",
    ),
    "utf8",
  );
  assert.match(source, /ai_story_chapter_dirty_events/);
  assert.doesNotMatch(source, /rotatePersistentStagingTable|TRUNCATE|RENAME TABLE/i);
  assert.doesNotMatch(source, /\b(?:CREATE|DROP|ALTER)\s+TABLE\b/i);
});
