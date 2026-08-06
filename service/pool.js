const mysql = require("mysql2");

const mysqlProxyHost = process.env.MYSQL_HOST_PROXY || "";
const mysqlReaderProxyHost = process.env.MYSQL_HOST_READER_PROXY || "";
const mysqlDirectReaderHost = process.env.MYSQL_HOST_READER || "";
const mysqlProxyUser = process.env.MYSQL_USER_PROXY || "";
const mysqlDirectUser = process.env.MYSQL_USER;
const mysqlHost = mysqlProxyHost || process.env.MYSQL_HOST;
const mysqlReaderHost =
  mysqlReaderProxyHost ||
  mysqlDirectReaderHost ||
  mysqlHost;
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

// Optimized pool settings to prevent memory bloat during ETL operations
const writePool = mysql.createPool({
  connectionLimit: 5,
  idleTimeout: 60000,
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
  connectionLimit: 5, // Reduced from 10 for consistency
  idleTimeout: 60000, // 60 seconds - prevent connection caching
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
  let enqueuedRequests = 0;
  let maxQueuedRequests = 0;
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
    maxQueuedRequests = Math.max(
      maxQueuedRequests,
      queuedRequestsAfterEnqueue
    );
  });

  const timer = setInterval(() => {
    intervalCount += 1;
    const current = snapshot();
    const wasPressured =
      enqueuedRequests > 0 ||
      current.queuedRequests > 0 ||
      (current.limit > 0 &&
        current.allConnections >= current.limit &&
        current.freeConnections === 0);
    if (wasPressured || intervalCount % 15 === 0) {
      const payload = {
        message: wasPressured
          ? "Database pool pressure"
          : "Database pool telemetry",
        route,
        ...current,
        enqueuedRequests,
        maxQueuedRequests,
      };
      if (wasPressured) console.warn(payload);
      else console.info(payload);
    }
    enqueuedRequests = 0;
    maxQueuedRequests = 0;
  }, 60_000);
  timer.unref();
}

attachPoolPressureTelemetry(writePool, "writer");
attachPoolPressureTelemetry(readPool, "reader");

module.exports = { writePool, readPool };
