const mysql = require("mysql2");
const writePool = mysql.createPool({
  connectionLimit: 10,
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
  connectionLimit: 10,
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
