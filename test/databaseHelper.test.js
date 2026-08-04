const assert = require("node:assert/strict");
const test = require("node:test");
const { DB_QUERY_TIMEOUT_MS, describeQuery } = require("../service/helpers");

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
