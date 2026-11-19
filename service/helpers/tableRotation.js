const { acquireBoundedConnection } = require("../database-connection.cjs");
// Whole-table rollup replacement, without runtime DDL. Readers see either the
// previous committed generation or the complete new generation through MVCC.
async function replaceTableContents({ pool, table, populate }) {
  if (!/^[a-zA-Z0-9_]+$/.test(table))
    throw new Error("Invalid table identifier");
  const conn = await acquireBoundedConnection(pool, {
    acquireTimeoutMs: 10_000,
    statementTimeoutMs: 10 * 60_000,
  });
  let shouldUnlock = false,
    reusable = false;
  try {
    const [rows] = await conn.query(
      "SELECT GET_LOCK(CONCAT('rollup:',DATABASE(),':',?),10) AS owned",
      [table],
    );
    const owned = rows[0]?.owned;
    if (Number(owned) !== 1) {
      reusable = owned === 0 || owned === "0";
      throw new Error("rollup_busy");
    }
    shouldUnlock = true;
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM \`${table}\``);
      await populate(conn);
      await conn.commit();
    } catch (error) {
      try {
        await conn.rollback();
      } catch {
        // On uncertain rollback, disconnect with the lease still held.
        shouldUnlock = false;
      }
      throw error;
    }
  } finally {
    if (shouldUnlock) {
      try {
        const [rows] = await conn.query(
          "SELECT RELEASE_LOCK(CONCAT('rollup:',DATABASE(),':',?)) AS released",
          [table],
        );
        reusable = Number(rows[0]?.released) === 1;
      } catch {
        reusable = false;
      }
    }
    if (reusable) conn.release();
    else conn.destroy();
  }
}
module.exports = { replaceTableContents };
