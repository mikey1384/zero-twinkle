const assert = require("node:assert/strict");
const test = require("node:test");
const { retireIdleConnections } = require("../service/poolMaintenance");

function fixture() {
  const list = [];
  const pool = {
    _freeConnections: {
      get: (i) => list[i],
      get length() {
        return list.length;
      },
    },
    _connectionQueue: [],
  };
  for (let i = 0; i < 5; i++) {
    const connection = {
      lastActiveTime: i === 4 ? 59_000 : 0,
      destroy() {
        list.splice(list.indexOf(connection), 1);
      },
    };
    list.push(connection);
  }
  return { pool, list };
}

test("idle cleanup closes surplus sockets but preserves recent use and a warm reserve", () => {
  const { pool, list } = fixture();
  assert.equal(retireIdleConnections(pool, 60_000), 4);
  assert.equal(list.length, 1);
  assert.equal(retireIdleConnections(pool, 120_000), 0);
});

test("cleanup cannot retire busy sockets or compete with waiting work", () => {
  const { pool, list } = fixture();
  pool._connectionQueue.push(() => {});
  assert.equal(retireIdleConnections(pool, 120_000), 0);
  pool._connectionQueue.pop();
  list[0]._command = {};
  list[1]._commands = [{}];
  assert.equal(retireIdleConnections(pool, 120_000), 3);
  assert.equal(list.length, 2);
  pool._closed = true;
  assert.equal(retireIdleConnections(pool, 240_000), 0);
});
