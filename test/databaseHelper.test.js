const assert = require("node:assert/strict");
const test = require("node:test");
const { DB_QUERY_TIMEOUT_MS, describeQuery } = require("../service/helpers");
const {
  DB_POOL_QUEUED_WAIT_PRESSURE_MS,
  isActionableDatabasePoolPressure,
} = require("../service/pool");

test("zero database operations have a finite deadline", () => {
  assert.equal(DB_QUERY_TIMEOUT_MS, 10 * 60 * 1000);
});

test("zero database error metadata identifies a query without retaining SQL or params", () => {
  const description = describeQuery("SELECT * FROM echo_users WHERE email = ?");
  assert.equal(description.queryOperation, "SELECT");
  assert.match(description.queryFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(description).includes("echo_users"), false);
  assert.equal(JSON.stringify(description).includes("email"), false);
});

test("zero pool queue telemetry warns only for a live queue or a material wait", () => {
  const drainedSnapshot = {
    allConnections: 5,
    freeConnections: 5,
    limit: 5,
    queuedRequests: 0,
  };
  assert.equal(
    isActionableDatabasePoolPressure({
      snapshot: drainedSnapshot,
      maxQueuedWaitMs: DB_POOL_QUEUED_WAIT_PRESSURE_MS - 1,
    }),
    false,
  );
  assert.equal(
    isActionableDatabasePoolPressure({
      snapshot: drainedSnapshot,
      maxQueuedWaitMs: DB_POOL_QUEUED_WAIT_PRESSURE_MS,
    }),
    true,
  );
  assert.equal(
    isActionableDatabasePoolPressure({
      snapshot: { ...drainedSnapshot, queuedRequests: 1 },
      maxQueuedWaitMs: 0,
    }),
    true,
  );
});
