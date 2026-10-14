function queryWithDeadline(
  pool,
  sql,
  params,
  { acquireTimeoutMs = 10_000, statementTimeoutMs = 10 * 60_000 } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connection = null;
    let timer;
    const timeout = (code, ms) => {
      if (settled) return;
      settled = true;
      try {
        connection?.destroy();
      } catch {
        /* already closed */
      }
      reject(
        Object.assign(new Error(`Database operation exceeded ${ms}ms`), {
          code,
        }),
      );
    };
    timer = setTimeout(
      () => timeout("DB_ACQUIRE_TIMEOUT", acquireTimeoutMs),
      acquireTimeoutMs,
    );
    const acquiredConnection = (error, acquired) => {
      if (settled) {
        try {
          acquired?.release();
        } catch {
          try {
            acquired?.destroy();
          } catch {
            /* already closed */
          }
        }
        return;
      }
      clearTimeout(timer);
      if (error) {
        settled = true;
        reject(error);
        return;
      }
      connection = acquired;
      timer = setTimeout(
        () => timeout("DB_STATEMENT_TIMEOUT", statementTimeoutMs),
        statementTimeoutMs,
      );
      try {
        connection.query(sql, params, (queryError, rows) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            connection.release();
          } catch {
            try {
              connection.destroy();
            } catch {
              /* already closed */
            }
          }
          if (queryError) reject(queryError);
          else resolve(rows);
        });
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        try {
          connection.destroy();
        } catch {
          /* already closed */
        }
        reject(error);
      }
    };
    try {
      pool.getConnection(acquiredConnection);
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

module.exports = { queryWithDeadline };
