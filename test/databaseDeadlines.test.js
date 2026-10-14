const assert = require("node:assert/strict");
const test = require("node:test");
const { queryWithDeadline } = require("../service/helpers/database");

test("a late acquisition is returned without executing an abandoned request", async () => {
  let callback,
    released = 0,
    queried = 0;
  const pool = {
    getConnection(cb) {
      callback = cb;
    },
  };
  await assert.rejects(
    queryWithDeadline(pool, "SELECT 1", [], { acquireTimeoutMs: 5 }),
    { code: "DB_ACQUIRE_TIMEOUT" },
  );
  callback(null, {
    release() {
      released++;
    },
    query() {
      queried++;
    },
  });
  assert.equal(released, 1);
  assert.equal(queried, 0);
});

test("a statement deadline destroys the connection and never replays an ambiguous write", async () => {
  let callback,
    destroyed = 0,
    released = 0,
    calls = 0;
  const conn = {
    query(sql, params, cb) {
      callback = cb;
      calls++;
    },
    destroy() {
      destroyed++;
    },
    release() {
      released++;
    },
  };
  const pool = {
    getConnection(cb) {
      cb(null, conn);
    },
  };
  await assert.rejects(
    queryWithDeadline(pool, "INSERT INTO example VALUES (?)", [1], {
      statementTimeoutMs: 5,
    }),
    { code: "DB_STATEMENT_TIMEOUT" },
  );
  callback(null, { affectedRows: 1 });
  assert.equal(destroyed, 1);
  assert.equal(released, 0);
  assert.equal(calls, 1);
});

test("successful statements release once and preserve their canonical result", async () => {
  let released = 0;
  const result = [{ id: 1 }];
  const conn = {
    query(sql, params, cb) {
      cb(null, result);
    },
    destroy() {
      assert.fail("success");
    },
    release() {
      released++;
    },
  };
  assert.equal(
    await queryWithDeadline(
      {
        getConnection(cb) {
          cb(null, conn);
        },
      },
      "SELECT 1",
      [],
    ),
    result,
  );
  assert.equal(released, 1);
});

test("synchronous acquisition failures and already-closed connections settle cleanly", async () => {
  await assert.rejects(
    queryWithDeadline(
      {
        getConnection() {
          throw new Error("pool closed");
        },
      },
      "SELECT 1",
      [],
    ),
    /pool closed/,
  );
  await assert.rejects(
    queryWithDeadline(
      {
        getConnection(cb) {
          cb(null, {
            query() {},
            destroy() {
              throw new Error("already closed");
            },
          });
        },
      },
      "SELECT 1",
      [],
      { statementTimeoutMs: 5 },
    ),
    { code: "DB_STATEMENT_TIMEOUT" },
  );
});
