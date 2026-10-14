// mysql2 only starts its idle timer when maxIdle < connectionLimit, and that
// timer can empty the pool entirely. Preserve one warm socket per route while
// closing genuinely idle surplus sockets, never a borrowed/in-flight one.
function retireIdleConnections(pool, now = Date.now(), idleMs = 60_000) {
  if (pool._closed || pool._connectionQueue?.length) return 0;
  const free = pool._freeConnections;
  if (!free) return 0;
  const connections = Array.from({ length: free.length }, (_, i) =>
    free.get(i),
  );
  let retired = 0;
  for (const connection of connections) {
    if (free.length <= 1) break;
    if (connection._command || connection._commands?.length) continue;
    if (
      !Number.isFinite(connection.lastActiveTime) ||
      now - connection.lastActiveTime < idleMs
    )
      continue;
    connection.destroy();
    retired++;
  }
  return retired;
}

module.exports = { retireIdleConnections };
