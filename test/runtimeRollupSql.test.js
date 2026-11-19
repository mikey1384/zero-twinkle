const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createDatabaseConnection,
  createDatabasePool,
} = require("../service/database-connection.cjs");
const {
  refreshWordMasterRankings,
} = require("../service/leaderboards/wordMaster");
const { replaceTableContents } = require("../service/helpers/tableRotation");
const { writePool, readPool } = require("../service/pool");

test("a rollup with uncertain transaction cleanup disconnects before unlocking", async () => {
  const events = [];
  const failure = new Error("rollup write failed");
  const conn = {
    query: async (sql) => {
      if (sql.includes("GET_LOCK")) return [[{ owned: 1 }]];
      if (sql.includes("RELEASE_LOCK")) {
        events.push("unlock");
        return [[{ released: 1 }]];
      }
      throw failure;
    },
    beginTransaction: async () => {},
    rollback: async () => {
      events.push("rollback");
      throw new Error("rollback rejected");
    },
    release: () => events.push("release"),
    destroy: () => events.push("destroy"),
  };
  await assert.rejects(
    replaceTableContents({
      pool: { getConnection: async () => conn },
      table: "fixture",
      populate: async () => {},
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["rollback", "destroy"]);
});

test("real Zero rollup preserves ranking ties, atomic reader visibility, rollback and named-lock exclusion", async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(process.env.MYSQL_HOST));
  assert.ok(!process.env.MYSQL_HOST_PROXY);
  assert.equal(process.env.MYSQL_DATABASE, "twinkle-test");
  const operator = await createDatabaseConnection("operator");
  const schema = `runtime_zero_review_${process.pid}`;
  const table = "content_words_rankings_all_time";
  let created = false,
    db,
    reader;
  try {
    await operator.query(`CREATE DATABASE ${schema}`);
    created = true;
    await operator.query(
      `CREATE TABLE ${schema}.content_words (userId INT) ENGINE=InnoDB`,
    );
    await operator.query(
      `CREATE TABLE ${schema}.${table} (userId INT PRIMARY KEY, numWords INT, globalRank INT, updatedAt INT) ENGINE=InnoDB`,
    );
    const env = { ...process.env, MYSQL_DATABASE: schema };
    db = await createDatabasePool("runtime", env, 3);
    reader = await createDatabaseConnection("runtime", "writer", env);
    await assert.rejects(
      async () => db.query(`TRUNCATE ${table}`),
      /runtime_ddl_forbidden/,
    );
    await db.query("INSERT INTO content_words VALUES (1),(1),(2),(2),(3),(0)");
    await refreshWordMasterRankings(db);
    const read = async () =>
      (
        await reader.query(
          `SELECT userId,numWords,globalRank FROM ${table} ORDER BY userId`,
        )
      )[0];
    const expected = [
      { userId: 1, numWords: 2, globalRank: 1 },
      { userId: 2, numWords: 2, globalRank: 1 },
      { userId: 3, numWords: 1, globalRank: 2 },
    ];
    assert.deepEqual(await read(), expected);
    await assert.rejects(
      replaceTableContents({
        pool: db,
        table,
        populate: async (conn) => {
          // A separate connection still sees the complete old generation after DELETE.
          assert.deepEqual(await read(), expected);
          await conn.query(`INSERT INTO ${table} VALUES (4,4,1,0)`);
          assert.deepEqual(await read(), expected);
          throw new Error("population failed");
        },
      }),
      /population failed/,
    );
    assert.deepEqual(await read(), expected);
    await reader.query(
      "SELECT GET_LOCK(CONCAT('rollup:',DATABASE(),':',?),0)",
      [table],
    );
    let complete = false;
    const refresh = refreshWordMasterRankings(db).then(() => {
      complete = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(complete, false);
    await reader.query(
      "SELECT RELEASE_LOCK(CONCAT('rollup:',DATABASE(),':',?))",
      [table],
    );
    await refresh;
    assert.deepEqual(await read(), expected);
  } finally {
    await reader?.end();
    await db?.end();
    if (created) await operator.query(`DROP DATABASE ${schema}`);
    await operator.end();
    await Promise.all([writePool.promise().end(), readPool.promise().end()]);
  }
});
