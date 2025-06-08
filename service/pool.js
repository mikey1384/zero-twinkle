const mysql = require("mysql2");

// Optimized pool settings to prevent memory bloat during ETL operations
const writePool = mysql.createPool({
  connectionLimit: 5,
  acquireTimeout: 60000,
  idleTimeout: 60000,
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: "utf8mb4",
  debug: false,
});

const readPool = mysql.createPool({
  connectionLimit: 5, // Reduced from 10 for consistency
  acquireTimeout: 60000, // 60 seconds
  idleTimeout: 60000, // 60 seconds - prevent connection caching
  host: process.env.MYSQL_HOST_READER,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: "utf8mb4",
  debug: false,
});

module.exports = { writePool, readPool };
