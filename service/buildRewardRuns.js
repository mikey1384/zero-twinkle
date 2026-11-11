const { writePool } = require("./pool");

const RETENTION_SECONDS = 30 * 86400;
const SCAN_LIMIT = 250;
let cursor = { expiresAt: 0, id: "" };

// Scheduled maintenance, never a reward-request side effect. Each tick scans
// only one indexed page, including retained receipts, so old paid runs cannot
// starve later unclaimed runs. A process restart safely restarts the scan.
async function pruneBuildRewardRuns() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
  const connection = await writePool.promise().getConnection();
  const query = (sql, values = []) => connection.query({ sql, values, timeout: 5000 });
  let previousLockWait;
  let transaction = false;
  try {
    const [[settings]] = await query("SELECT @@SESSION.innodb_lock_wait_timeout AS lockWait");
    previousLockWait = Number(settings.lockWait);
    await query("SET SESSION innodb_lock_wait_timeout = 5");
    await connection.beginTransaction();
    transaction = true;
    const [runs] = await query(
      `SELECT id, expiresAt FROM build_reward_runs FORCE INDEX (run_expiry)
       WHERE expiresAt < ? AND (expiresAt > ? OR (expiresAt = ? AND id > ?))
       ORDER BY expiresAt, id LIMIT ${SCAN_LIMIT} FOR UPDATE`,
      [cutoff, cursor.expiresAt, cursor.expiresAt, cursor.id],
    );
    let removed = 0;
    if (runs.length) {
      const ids = runs.map((run) => run.id);
      const [receipts] = await query(
        "SELECT DISTINCT proofRunId FROM build_reward_claims WHERE proofRunId IN (?)",
        [ids],
      );
      const paid = new Set(receipts.map((receipt) => receipt.proofRunId));
      const expired = ids.filter((id) => !paid.has(id));
      if (expired.length) {
        await query("DELETE FROM build_reward_run_challenges WHERE runId IN (?)", [expired]);
        const [result] = await query(
          `DELETE FROM build_reward_runs WHERE id IN (?) AND expiresAt < ?
           AND NOT EXISTS (SELECT 1 FROM build_reward_claims c WHERE c.proofRunId = build_reward_runs.id)`,
          [expired, cutoff],
        );
        removed = result.affectedRows;
        // Do not commit a partial parent/membership removal if a receipt was
        // concurrently added by maintenance outside normal expired-run rules.
        if (removed !== expired.length) throw new Error("Reward run retention changed during deletion");
      }
    }
    await connection.commit();
    transaction = false;
    const last = runs[runs.length - 1];
    cursor = runs.length === SCAN_LIMIT
      ? { expiresAt: Number(last.expiresAt), id: last.id }
      : { expiresAt: 0, id: "" };
    if (runs.length) console.info("[build-reward-run-retention]", { scanned: runs.length, removed, complete: runs.length < SCAN_LIMIT });
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    // Never return modified session settings to unrelated cron work.
    try {
      if (Number.isSafeInteger(previousLockWait)) {
        await query("SET SESSION innodb_lock_wait_timeout = ?", [previousLockWait]);
      }
      connection.release();
    } catch {
      connection.destroy();
    }
  }
}

module.exports = { pruneBuildRewardRuns };
