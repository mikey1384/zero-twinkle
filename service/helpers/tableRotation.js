// Whole-table rollup replacement, without runtime DDL. Readers see either the
// previous committed generation or the complete new generation through MVCC.
async function replaceTableContents({ pool, table, populate }) {
  if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('Invalid table identifier');
  const conn = await pool.getConnection();
  let owned = false, reusable = true;
  try {
    const [rows] = await conn.query("SELECT GET_LOCK(CONCAT('rollup:',DATABASE(),':',?),10) AS owned", [table]);
    if (Number(rows[0]?.owned) !== 1) throw new Error('rollup_busy');
    owned = true;
    await conn.beginTransaction();
    try {
      await conn.query(`DELETE FROM \`${table}\``);
      await populate(conn);
      await conn.commit();
    } catch (error) {
      try { await conn.rollback(); } catch { reusable = false; }
      throw error;
    }
  } finally {
    if (owned) {
      try {
        const [rows] = await conn.query("SELECT RELEASE_LOCK(CONCAT('rollup:',DATABASE(),':',?)) AS released", [table]);
        reusable = reusable && Number(rows[0]?.released) === 1;
      } catch { reusable = false; }
    }
    if (reusable) conn.release(); else conn.destroy();
  }
}
module.exports = { replaceTableContents };
