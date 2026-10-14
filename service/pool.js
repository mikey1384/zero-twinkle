const mysql = require("mysql2");
const { retireIdleConnections } = require("./poolMaintenance");
const {
  createDatabaseOperationHealth,
  createDatabaseHealthWriter,
} = require("./databaseOperationHealth");
const databaseOperationHealth = createDatabaseOperationHealth();
const writeDatabaseHealth =
  process.env.NODE_ENV === "production"
    ? createDatabaseHealthWriter({ service: "cron" })
    : null;

// A brief queue is normal during a scheduled burst; warn only when it remains
// queued or delays an acquisition long enough to be operationally meaningful.
const DB_POOL_QUEUED_WAIT_PRESSURE_MS = 250;

const mysqlProxyHost = process.env.MYSQL_HOST_PROXY || "";
const mysqlReaderProxyHost = process.env.MYSQL_HOST_READER_PROXY || "";
const mysqlDirectReaderHost = process.env.MYSQL_HOST_READER || "";
const mysqlProxyUser = process.env.MYSQL_USER_PROXY || "";
const mysqlDirectUser = process.env.MYSQL_USER;
const mysqlHost = mysqlProxyHost || process.env.MYSQL_HOST;
const mysqlReaderHost =
  mysqlReaderProxyHost || mysqlDirectReaderHost || mysqlHost;
const mysqlWriteUser =
  (mysqlProxyHost ? mysqlProxyUser : "") || mysqlDirectUser;
const mysqlReadUser = mysqlReaderProxyHost
  ? mysqlProxyUser || mysqlDirectUser
  : mysqlDirectReaderHost
    ? mysqlDirectUser
    : mysqlWriteUser;
const mysqlSslProfile = (
  process.env.MYSQL_SSL_PROFILE ||
  (process.env.NODE_ENV === "production" ? "Amazon RDS" : "")
).trim();
const mysqlSsl = mysqlSslProfile || undefined;

// Idle retirement is handled below with a warm floor. mysql2's idleTimeout
// alone does not start a cleanup timer with its default maxIdle setting.
const writePool = mysql.createPool({
  connectionLimit: 5,
  maxPreparedStatements: 256,
  host: mysqlHost,
  user: mysqlWriteUser,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl: mysqlSsl,
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: "utf8mb4",
  debug: false,
});

const readPool = mysql.createPool({
  connectionLimit: 5,
  maxPreparedStatements: 256,
  host: mysqlReaderHost,
  user: mysqlReadUser,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl: mysqlSsl,
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: "utf8mb4",
  debug: false,
});

function attachPoolPressureTelemetry(pool, route) {
  let retiredConnections = 0;
  let enqueuedRequests = 0;
  let maxQueuedRequests = 0;
  let completedQueuedRequests = 0;
  let maxQueuedWaitMs = 0;
  let intervalCount = 0;

  function snapshot() {
    return {
      allConnections: pool._allConnections?.length || 0,
      freeConnections: pool._freeConnections?.length || 0,
      limit: Number(pool.config?.connectionLimit || 0),
      queuedRequests: pool._connectionQueue?.length || 0,
    };
  }

  pool.on("enqueue", () => {
    enqueuedRequests += 1;
    // mysql2 emits "enqueue" immediately before pushing the pending callback.
    // Include that callback so the high-water mark is not one request low.
    const queuedRequestsAfterEnqueue = snapshot().queuedRequests + 1;
    maxQueuedRequests = Math.max(maxQueuedRequests, queuedRequestsAfterEnqueue);
  });

  const originalGetConnection = pool.getConnection.bind(pool);
  pool.getConnection = (callback) => {
    const acquireStartedAt = Date.now();
    const before = snapshot();
    const enteredQueue =
      before.limit > 0 &&
      before.allConnections >= before.limit &&
      before.freeConnections === 0;
    const queuedAtMs = enteredQueue ? Date.now() : 0;
    return originalGetConnection((error, connection) => {
      databaseOperationHealth.observe(
        route,
        "acquire",
        Date.now() - acquireStartedAt,
        error?.code,
        Boolean(error),
      );
      if (enteredQueue) {
        completedQueuedRequests += 1;
        maxQueuedWaitMs = Math.max(maxQueuedWaitMs, Date.now() - queuedAtMs);
      }
      callback(error, connection);
    });
  };

  const timer = setInterval(() => {
    const retiredThisMinute = retireIdleConnections(pool);
    retiredConnections += retiredThisMinute;
    intervalCount += 1;
    const current = snapshot();
    const hadQueueActivity =
      enqueuedRequests > 0 ||
      completedQueuedRequests > 0 ||
      current.queuedRequests > 0;
    const wasPressured = isActionableDatabasePoolPressure({
      snapshot: current,
      maxQueuedWaitMs,
    });
    void writeDatabaseHealth?.({
      kind: "database-window",
      ...databaseOperationHealth.drain(route),
      pool: {
        ...current,
        enqueuedRequests,
        maxQueuedRequests,
        maxQueuedWaitMs,
        wasPressured,
      },
      maintenance: { retiredConnections: retiredThisMinute, warmReserve: 1 },
    });
    if (hadQueueActivity || wasPressured || intervalCount % 15 === 0) {
      const payload = {
        message: wasPressured
          ? "Database pool pressure"
          : "Database pool telemetry",
        route,
        ...current,
        retiredConnections,
        enqueuedRequests,
        maxQueuedRequests,
        completedQueuedRequests,
        maxQueuedWaitMs,
      };
      if (wasPressured) console.warn(payload);
      else console.info(payload);
    }
    enqueuedRequests = 0;
    maxQueuedRequests = 0;
    completedQueuedRequests = 0;
    maxQueuedWaitMs = 0;
  }, 60_000);
  timer.unref();
}

attachPoolPressureTelemetry(writePool, "writer");
attachPoolPressureTelemetry(readPool, "reader");

function isActionableDatabasePoolPressure({ snapshot, maxQueuedWaitMs }) {
  return (
    snapshot.queuedRequests > 0 ||
    maxQueuedWaitMs >= DB_POOL_QUEUED_WAIT_PRESSURE_MS
  );
}

module.exports = {
  DB_POOL_QUEUED_WAIT_PRESSURE_MS,
  isActionableDatabasePoolPressure,
  writePool,
  readPool,
  databaseOperationHealth,
  writeDatabaseHealth,
};
