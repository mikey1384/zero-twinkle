const mysql = require("mysql2");

const mysqlHost = process.env.MYSQL_HOST_PROXY || process.env.MYSQL_HOST;
const mysqlReaderHost =
  process.env.MYSQL_HOST_READER_PROXY ||
  process.env.MYSQL_HOST_READER ||
  mysqlHost;
const mysqlUser = process.env.MYSQL_USER_PROXY || process.env.MYSQL_USER;

// Optimized pool settings to prevent memory bloat during ETL operations
const writePool = mysql.createPool({
  connectionLimit: 5,
  idleTimeout: 60000,
  host: mysqlHost,
  user: mysqlUser,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: "utf8mb4",
  debug: false,
});

const readPool = mysql.createPool({
  connectionLimit: 5, // Reduced from 10 for consistency
  idleTimeout: 60000, // 60 seconds - prevent connection caching
  host: mysqlReaderHost,
  user: mysqlUser,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: "utf8mb4",
  debug: false,
});

module.exports = { writePool, readPool };
