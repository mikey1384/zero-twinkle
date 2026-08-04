const assert = require("node:assert/strict");
const test = require("node:test");
const {
  refreshWordMasterRankings,
} = require("../service/leaderboards/wordMaster");

const LIVE_TABLE = "content_words_rankings_all_time";
const NEXT_TABLE = "content_words_rankings_all_time_staging";
const SWAP_TABLE = "content_words_rankings_all_time_swap";

function createRankingTableModel() {
  const tables = new Map([
    [LIVE_TABLE, "live-v0"],
    [NEXT_TABLE, "staging-v0"],
  ]);
  const statements = [];
  let generation = 0;

  async function query(sql, _params, fromWriter) {
    assert.equal(fromWriter, true);
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    statements.push(normalized);
    if (normalized === `TRUNCATE TABLE ${NEXT_TABLE}`) {
      assert.equal(tables.has(NEXT_TABLE), true);
      tables.set(NEXT_TABLE, "empty");
      return {};
    }
    if (normalized.startsWith(`INSERT INTO ${NEXT_TABLE}`)) {
      assert.equal(tables.get(NEXT_TABLE), "empty");
      generation += 1;
      tables.set(NEXT_TABLE, `live-v${generation}`);
      return {};
    }
    if (normalized.startsWith("RENAME TABLE ")) {
      assert.equal(
        normalized,
        `RENAME TABLE \`${LIVE_TABLE}\` TO \`${SWAP_TABLE}\`, \`${NEXT_TABLE}\` TO \`${LIVE_TABLE}\`, \`${SWAP_TABLE}\` TO \`${NEXT_TABLE}\``,
      );
      assert.equal(tables.has(SWAP_TABLE), false);
      const previousLive = tables.get(LIVE_TABLE);
      const nextLive = tables.get(NEXT_TABLE);
      assert.notEqual(previousLive, undefined);
      assert.notEqual(nextLive, undefined);
      tables.delete(LIVE_TABLE);
      tables.set(SWAP_TABLE, previousLive);
      tables.delete(NEXT_TABLE);
      tables.set(LIVE_TABLE, nextLive);
      tables.set(NEXT_TABLE, tables.get(SWAP_TABLE));
      tables.delete(SWAP_TABLE);
      return {};
    }
    throw new Error(`Unexpected query: ${normalized}`);
  }

  return { query, statements, tables };
}

test("Word Master refresh preserves reusable live and staging tables across runs", async () => {
  const model = createRankingTableModel();

  await refreshWordMasterRankings(model.query);
  assert.equal(model.tables.get(LIVE_TABLE), "live-v1");
  assert.equal(model.tables.get(NEXT_TABLE), "live-v0");

  await refreshWordMasterRankings(model.query);
  assert.equal(model.tables.get(LIVE_TABLE), "live-v2");
  assert.equal(model.tables.get(NEXT_TABLE), "live-v1");
  assert.equal(model.tables.has(SWAP_TABLE), false);
  assert.equal(
    model.statements.some((statement) =>
      /\b(?:CREATE|DROP|ALTER)\s+TABLE\b/.test(statement),
    ),
    false,
  );
});

test("Word Master population failure leaves the canonical live table unchanged", async () => {
  const model = createRankingTableModel();
  const failingQuery = async (sql, params, fromWriter) => {
    if (String(sql).replace(/\s+/g, " ").trim().startsWith("INSERT INTO ")) {
      throw new Error("population failed");
    }
    return model.query(sql, params, fromWriter);
  };

  await assert.rejects(
    refreshWordMasterRankings(failingQuery),
    /population failed/,
  );
  assert.equal(model.tables.get(LIVE_TABLE), "live-v0");
  assert.equal(model.tables.has(NEXT_TABLE), true);
  assert.equal(model.tables.has(SWAP_TABLE), false);
});
