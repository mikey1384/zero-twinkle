const { poolQuery } = require("../helpers");
const { readCheckpoint, writeCheckpoint } = require("./checkpoint");
const { writeDatabaseHealth } = require("../pool");

// Nightly reconciliation for the earn candidate tables the twinkle-api
// /content/karma/recommend and /content/karma/reward pickers drive their
// scans from: earn_comment_candidates (comments to recommend) and
// earn_reward_candidates (recommendations to reward). The API keeps both in
// sync with write hooks (twinkle-api/helpers/earnCommentCandidates.ts and
// earnRewardCandidates.ts), but hooks can't see every eligibility flip —
// most notably a supermod demotion (userType change or achievementPoints
// recalculation below the teacher threshold) makes comments that user's old
// recommendations/skips had disqualified eligible again, with no hook firing.
// A missing row means the picker never serves that item, so this task re-runs
// the full backfills (INSERT IGNORE) to restore any missing rows, and purges
// rows that are no longer eligible so the pickers' scans stay shallow. Reward
// upserts also refresh the teacher-eligibility selection hint. Source-of-truth
// reads are kept separate from candidate-table writes so reconciliation never
// takes recommendation/user source locks while mutating the derived indexes.
// Cleanup is bracketed by restorative passes: if an API hook inserts a newly
// eligible row while a stale snapshot is being purged, the final canonical
// pass puts it back before reconciliation completes.
//
// The eligibility rules below MUST mirror the canonical copies in
// twinkle-api/helpers/earnCommentCandidates.ts and earnRewardCandidates.ts.
// Literals:
//   length thresholds 700/450/250/100 = expectedResponseLength(5/4/3/default)
//   achievementPoints >= 1000         = levels[TEACHER_LEVEL].ap
//   authLevel + 1 >= TEACHER_LEVEL    = assigned Teacher Level bar
//   reward caps 50/40/30/20/10 (ELSE 5) = per-rewardLevel totalRewards caps
// The tables are provisioned by the add-earn-comment-candidates and
// add-earn-reward-candidates migrations; this task never creates schema.

// Prod ids; ZERO_TWINKLE_ID is already in this service's env, Ciel's id is
// not, hence the documented fallback.
const ZERO_TWINKLE_ID = Number(process.env.ZERO_TWINKLE_ID || 7587);
const CIEL_TWINKLE_ID = Number(process.env.CIEL_TWINKLE_ID || 8411);
const TEACHER_LEVEL = 5;
const REQUIRED_AP_FOR_SUPERMOD = 1000;
const SYNC_CHUNK_SIZE = 500;
const REWARD_TEACHER_ELIGIBILITY_SQL = `COALESCE((r.rewardDisabled = '0' AND (COALESCE(ut.authLevel, 0) + 1 >= ${TEACHER_LEVEL} OR COALESCE(u.achievementPoints, 0) >= ${REQUIRED_AP_FOR_SUPERMOD})), 0)`;

// Start the daily pass at this UTC hour (19:00 UTC = 4am KST). Minute ticks
// resume bounded slices; completed days do no more work.
const RECONCILE_UTC_HOUR = Number(
  process.env.EARN_CANDIDATE_RECONCILE_UTC_HOUR || 19,
);

const ELIGIBILITY_SQL = `
    FROM content_comments b FORCE INDEX (PRIMARY)
    JOIN content_subjects c ON c.id = b.subjectId
    WHERE b.isDeleted = 0
      AND b.userId NOT IN (?, ?)
      AND c.isDeleted = 0
      AND c.rewardLevel > 0
      AND (
        CASE
          WHEN c.rewardLevel = 5 THEN (LENGTH(b.content) > 700)
          WHEN c.rewardLevel = 4 THEN (LENGTH(b.content) > 450)
          WHEN c.rewardLevel = 3 THEN (LENGTH(b.content) > 250)
          ELSE (LENGTH(b.content) > 100)
        END
      )
      AND EXISTS (
        SELECT 1
        FROM noti_feeds a
        WHERE a.contentId = b.id
          AND a.type = 'comment'
          AND a.isHidden != '1'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM content_recommendations cr
        JOIN users u ON u.id = cr.userId
        LEFT JOIN users_types ut ON ut.label = u.userType
        WHERE cr.rootType = 'comment'
          AND cr.isDeleted = 0
          AND cr.rootId = b.id
          AND (COALESCE(ut.authLevel, 0) + 1 >= ${TEACHER_LEVEL}
               OR u.achievementPoints >= ?)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM users_earn_skip_status s
        JOIN users u2 ON u2.id = s.userId
        LEFT JOIN users_types ut2 ON ut2.label = u2.userType
        WHERE s.contentType = 'comment'
          AND s.contentId = b.id
          AND (COALESCE(ut2.authLevel, 0) + 1 >= ${TEACHER_LEVEL}
               OR u2.achievementPoints >= ?)
      )`;

function eligibilityParams() {
  return [
    ZERO_TWINKLE_ID,
    CIEL_TWINKLE_ID,
    REQUIRED_AP_FOR_SUPERMOD,
    REQUIRED_AP_FOR_SUPERMOD,
  ];
}

// Recommendation-grain eligibility for earn_reward_candidates (one row per
// currently-rewardable recommendation on a comment). Placeholders:
// ZERO_TWINKLE_ID, CIEL_TWINKLE_ID.
const REWARD_ELIGIBILITY_SQL = `
    FROM content_recommendations r FORCE INDEX (PRIMARY)
    JOIN content_comments b ON b.id = r.rootId
    JOIN content_subjects c ON c.id = b.subjectId
    JOIN users u ON u.id = r.userId
    LEFT JOIN users_types ut ON ut.label = u.userType
    WHERE r.rootType = 'comment'
      AND r.isDeleted = 0
      AND b.isDeleted = 0
      AND b.userId NOT IN (?, ?)
      AND c.isDeleted = 0
      AND c.rewardLevel > 0
      AND EXISTS (
        SELECT 1
        FROM noti_feeds f
        WHERE f.type = 'recommendation'
          AND f.contentId = r.id
          AND f.isHidden != '1'
      )
      AND (
        SELECT COALESCE(SUM(ur.rewardAmount), 0)
        FROM users_rewards ur
        WHERE ur.contentType = 'comment' AND ur.contentId = b.id
      ) < (
        CASE c.rewardLevel
          WHEN 5 THEN 50
          WHEN 4 THEN 40
          WHEN 3 THEN 30
          WHEN 2 THEN 20
          WHEN 1 THEN 10
          ELSE 5
        END
      )`;

function rewardEligibilityParams() {
  return [ZERO_TWINKLE_ID, CIEL_TWINKLE_ID];
}

function chunks(rows) {
  const result = [];
  for (let index = 0; index < rows.length; index += SYNC_CHUNK_SIZE) {
    result.push(rows.slice(index, index + SYNC_CHUNK_SIZE));
  }
  return result;
}

async function loadEligibleCommentCandidates(query, after, through) {
  return query(
    `SELECT /*+ MAX_EXECUTION_TIME(5000) */ b.id AS commentId, b.subjectId
     ${ELIGIBILITY_SQL} AND b.id > ? AND b.id <= ?`,
    [...eligibilityParams(), after, through],
    true,
    "earn_comment_candidates.reconcile_eligibility",
  );
}

async function restoreCommentCandidates(rows, query) {
  let affectedRows = 0;
  for (const batch of chunks(rows)) {
    if (batch.length === 0) continue;
    const timeStamp = Math.floor(Date.now() / 1000);
    const result = await query(
      `INSERT IGNORE INTO earn_comment_candidates
         (commentId, subjectId, timeStamp)
       VALUES ${batch.map(() => "(?, ?, ?)").join(", ")}`,
      batch.flatMap((row) => [
        Number(row.commentId),
        Number(row.subjectId),
        timeStamp,
      ]),
      true,
      "earn_comment_candidates.reconcile_restore",
    );
    affectedRows += Number(result?.affectedRows || 0);
  }
  return affectedRows;
}

async function loadEligibleRewardCandidates(query, after, through) {
  return query(
    `SELECT /*+ MAX_EXECUTION_TIME(5000) */
       r.id AS recommendationId,
       b.id AS commentId,
       b.subjectId,
       ${REWARD_TEACHER_ELIGIBILITY_SQL} AS teacherEligible
     ${REWARD_ELIGIBILITY_SQL} AND r.id > ? AND r.id <= ?`,
    [...rewardEligibilityParams(), after, through],
    true,
    "earn_reward_candidates.reconcile_eligibility",
  );
}

async function restoreRewardCandidates(rows, query) {
  let affectedRows = 0;
  for (const batch of chunks(rows)) {
    if (batch.length === 0) continue;
    const timeStamp = Math.floor(Date.now() / 1000);
    const result = await query(
      `INSERT INTO earn_reward_candidates
         (recommendationId, commentId, subjectId, timeStamp, teacherEligible)
       VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(", ")}
       ON DUPLICATE KEY UPDATE
         commentId = VALUES(commentId),
         subjectId = VALUES(subjectId),
         teacherEligible = VALUES(teacherEligible)`,
      batch.flatMap((row) => [
        Number(row.recommendationId),
        Number(row.commentId),
        Number(row.subjectId),
        timeStamp,
        Number(row.teacherEligible) === 1 ? 1 : 0,
      ]),
      true,
      "earn_reward_candidates.reconcile_restore",
    );
    affectedRows += Number(result?.affectedRows || 0);
  }
  return affectedRows;
}

async function loadCurrentCommentCandidates(query, after, through) {
  return query(
    `SELECT commentId FROM earn_comment_candidates
     WHERE commentId > ? AND commentId <= ? ORDER BY commentId LIMIT ${SYNC_CHUNK_SIZE}`,
    [after, through],
    true,
    "earn_comment_candidates.reconcile_current",
  );
}

async function loadCurrentRewardCandidates(query, after, through) {
  return query(
    `SELECT recommendationId, commentId, subjectId, teacherEligible
     FROM earn_reward_candidates
     WHERE recommendationId > ? AND recommendationId <= ?
     ORDER BY recommendationId LIMIT ${SYNC_CHUNK_SIZE}`,
    [after, through],
    true,
    "earn_reward_candidates.reconcile_current",
  );
}

async function purgeStaleCandidates({
  query,
  table,
  idColumn,
  eligibleRows,
  eligibleRowId,
  currentRows,
  currentRowId,
  queryLabel,
}) {
  const eligibleIds = new Set(
    eligibleRows
      .map((row) => Number(eligibleRowId(row)))
      .filter((id) => id > 0),
  );
  const staleIds = currentRows
    .map((row) => Number(currentRowId(row)))
    .filter((id) => id > 0 && !eligibleIds.has(id));
  let affectedRows = 0;
  for (const batch of chunks(staleIds)) {
    const result = await query(
      `DELETE FROM ${table}
       WHERE ${idColumn} IN (${batch.map(() => "?").join(", ")})`,
      batch,
      true,
      `${queryLabel}.reconcile_purge`,
    );
    affectedRows += Number(result?.affectedRows || 0);
  }
  return affectedRows;
}

function commentRepairRows(initialRows, finalRows) {
  const initialIds = new Set(
    initialRows.map((row) => Number(row.commentId)).filter((id) => id > 0),
  );
  return finalRows.filter(
    (row) =>
      Number(row.commentId) > 0 && !initialIds.has(Number(row.commentId)),
  );
}

function rewardRepairRows(initialRows, finalRows) {
  const initialState = new Map(
    initialRows.map((row) => [
      Number(row.recommendationId),
      [
        Number(row.commentId),
        Number(row.subjectId),
        Number(row.teacherEligible) === 1 ? 1 : 0,
      ].join(":"),
    ]),
  );
  return finalRows.filter((row) => {
    const recommendationId = Number(row.recommendationId);
    const state = [
      Number(row.commentId),
      Number(row.subjectId),
      Number(row.teacherEligible) === 1 ? 1 : 0,
    ].join(":");
    return recommendationId > 0 && initialState.get(recommendationId) !== state;
  });
}

const phases = [
  {
    table: "earn_comment_candidates",
    source: "content_comments",
    id: "commentId",
    loadEligible: loadEligibleCommentCandidates,
    loadCurrent: loadCurrentCommentCandidates,
    repairs: commentRepairRows,
    restore: restoreCommentCandidates,
  },
  {
    table: "earn_reward_candidates",
    source: "content_recommendations",
    id: "recommendationId",
    loadEligible: loadEligibleRewardCandidates,
    loadCurrent: loadCurrentRewardCandidates,
    repairs: rewardRepairRows,
    restore: restoreRewardCandidates,
  },
];

function validateCheckpoint(state) {
  if (
    !state ||
    state.version !== 1 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(state.day) ||
    !Number.isInteger(state.phase) ||
    state.phase < 0 ||
    state.phase > phases.length ||
    !Number.isSafeInteger(state.after) ||
    state.after < 0 ||
    (state.ceiling !== null &&
      (!Number.isSafeInteger(state.ceiling) || state.ceiling < state.after))
  ) {
    throw new Error(
      "Invalid earn reconciliation checkpoint; preserve it for inspection",
    );
  }
  if (
    state.totals &&
    Object.values(state.totals).some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  )
    throw new Error("Invalid earn reconciliation health counters");
  for (const key of ["startedAt", "lastProgressAt"])
    if (state[key] && !Number.isFinite(Date.parse(state[key])))
      throw new Error("Invalid earn reconciliation health timestamp");
  return state;
}

async function reconcileEarnCommentCandidates(options = {}) {
  const date = options.now || new Date();
  const runQuery =
    options.query ||
    ((...args) =>
      poolQuery(...args, {
        acquireTimeoutMs: 5000,
        statementTimeoutMs: 5000,
      }));
  const clock = options.clock || Date.now;
  const load =
    options.loadCheckpoint || (options.query ? () => null : readCheckpoint);
  const save =
    options.saveCheckpoint || (options.query ? () => {} : writeCheckpoint);
  const pause =
    options.pause || (() => new Promise((resolve) => setTimeout(resolve, 25)));
  const today = date.toISOString().slice(0, 10);
  let state = load();
  if (state) validateCheckpoint(state);
  if (!state || state.phase === phases.length) {
    if (state?.day === today || date.getUTCHours() < RECONCILE_UTC_HOUR)
      return { status: "idle" };
    const lastCompleted = state?.phase === phases.length
      ? { day: state.day, totals: state.totals || null }
      : state?.lastCompleted || null;
    state = { version: 1, day: today, phase: 0, after: 0, ceiling: null, lastCompleted };
    save(state);
  }
  const startedAt = clock();
  state.startedAt ||= new Date(startedAt).toISOString();
  let batches = 0,
    repaired = 0,
    purged = 0,
    sourceRows = 0;
  let queryCount = 0,
    queryDurationMs = 0,
    maxQueryMs = 0,
    queryFailures = 0;
  let pausedSlices = 0,
    failedSlices = 0;
  const previous = { ...state.totals };
  const persist = (progress = false) => {
    if (progress) state.lastProgressAt = new Date(clock()).toISOString();
    state.totals = {
      batches,
      repaired,
      purged,
      sourceRows,
      queryCount,
      queryDurationMs,
      queryFailures,
      pausedSlices,
      failedSlices,
      activeMs: clock() - startedAt,
    };
    for (const key of Object.keys(state.totals))
      state.totals[key] += previous[key] || 0;
    state.totals.maxQueryMs = Math.max(previous.maxQueryMs || 0, maxQueryMs);
    save(state);
  };
  const query = async (...args) => {
    const start = clock();
    queryCount++;
    try {
      return await runQuery(...args);
    } catch (error) {
      queryFailures++;
      throw error;
    } finally {
      const ms = clock() - start;
      queryDurationMs += ms;
      maxQueryMs = Math.max(maxQueryMs, ms);
    }
  };
  let nextPressureCheck = 0;
  const shouldPause =
    options.shouldPause ||
    (options.query
      ? async () => false
      : async () => {
          if (clock() < nextPressureCheck) return false;
          nextPressureCheck = clock() + 10_000;
          const rows = await query(
            "SHOW GLOBAL STATUS LIKE 'Threads_running'",
            null,
            true,
            "earn_candidates.pressure",
          );
          // Two-core production database: give interactive work room when more
          // than four statements are already running. Persisted work resumes on
          // the next minute's tick; no batch or eligibility repair is dropped.
          const running = Number(rows[0]?.Value);
          if (!Number.isSafeInteger(running) || running < 0)
            throw new Error("Database pressure sample unavailable");
          return running > 4;
        });
  const reportSlice = (status, reason = null) => {
    pausedSlices += Number(status === "paused");
    failedSlices += Number(status === "failed");
    persist();
    const report = {
      kind: "earn-reconcile",
      status,
      reason,
      day: state.day,
      phase: state.phase,
      after: state.after,
      ceiling: state.ceiling,
      startedAt: state.startedAt,
      lastProgressAt: state.lastProgressAt || null,
      elapsedMs: clock() - Date.parse(state.startedAt),
      durationMs: clock() - startedAt,
      batches,
      repaired,
      purged,
      sourceRows,
      queryCount,
      queryDurationMs,
      maxQueryMs,
      queryFailures,
      totals: { ...state.totals },
    };
    if (!options.query) void writeDatabaseHealth?.(report);
    options.report?.(report);
    console.log(
      `[earnCandidates] ${status} (${state.day}); ${batches} batches, ${repaired} repairs, ${purged} purges, ${report.durationMs}ms`,
    );
    return { ...report, checkpoint: { ...state } };
  };
  try {
    while (state.phase < phases.length) {
      if (clock() - startedAt >= (options.maxRunMs ?? 20_000))
        return reportSlice("paused", "time_budget");
      if (await shouldPause())
        return reportSlice("paused", "database_pressure");
      const phase = phases[state.phase];
      if (state.ceiling === null) {
        const rows = await query(
          `SELECT GREATEST(
        COALESCE((SELECT MAX(id) FROM ${phase.source}), 0),
        COALESCE((SELECT MAX(${phase.id}) FROM ${phase.table}), 0)) AS maxId`,
          null,
          true,
          `${phase.table}.reconcile_ceiling`,
        );
        state.ceiling = Number(rows[0]?.maxId);
        validateCheckpoint(state);
        save(state);
      }
      if (state.after >= state.ceiling) {
        state = { ...state, phase: state.phase + 1, after: 0, ceiling: null };
        persist(true);
        continue;
      }
      // Both source and derived indexes are keyset-paged. The smaller full
      // page boundary bounds *both* sets to 500 rows, including orphaned
      // candidates whose source was deleted. A fixed ceiling prevents new
      // traffic from making the nightly pass run forever.
      const source = await query(
        `SELECT id AS cursorId FROM ${phase.source}
      WHERE id > ? AND id <= ? ORDER BY id LIMIT ${SYNC_CHUNK_SIZE}`,
        [state.after, state.ceiling],
        true,
        `${phase.table}.reconcile_source_page`,
      );
      sourceRows += source.length;
      const current = await phase.loadCurrent(
        query,
        state.after,
        state.ceiling,
      );
      const through = Math.min(
        state.ceiling,
        source.length === SYNC_CHUNK_SIZE
          ? Number(source.at(-1).cursorId)
          : state.ceiling,
        current.length === SYNC_CHUNK_SIZE
          ? Number(current.at(-1)[phase.id])
          : state.ceiling,
      );
      if (!Number.isSafeInteger(through) || through <= state.after)
        throw new Error("Earn reconciliation cursor did not advance");
      const initial = await phase.loadEligible(query, state.after, through);
      if (initial.length > SYNC_CHUNK_SIZE)
        throw new Error("Earn reconciliation exceeded its bounded source page");
      const existing = current.filter(
        (row) => Number(row[phase.id]) <= through,
      );
      const restore = phase.repairs(existing, initial);
      await phase.restore(restore, query);
      repaired += restore.length;
      let purgeError;
      const eligibleIds = new Set(initial.map((row) => Number(row[phase.id])));
      const needsPurge = existing.some(
        (row) => !eligibleIds.has(Number(row[phase.id])),
      );
      try {
        purged += await purgeStaleCandidates({
          query,
          table: phase.table,
          idColumn: phase.id,
          eligibleRows: initial,
          eligibleRowId: (row) => row[phase.id],
          currentRows: existing,
          currentRowId: (row) => row[phase.id],
          queryLabel: phase.table,
        });
      } catch (error) {
        purgeError = error;
      }
      // Preserve the existing race repair, including after a partial purge.
      // Advance the durable cursor only after this whole range succeeds.
      if (needsPurge) {
        const final = await phase.loadEligible(query, state.after, through);
        const finalRepairs = phase.repairs(initial, final);
        await phase.restore(finalRepairs, query);
        repaired += finalRepairs.length;
      }
      if (purgeError) throw purgeError;
      state = { ...state, after: through };
      batches++;
      persist(true);
      await pause();
    }
    return reportSlice("complete");
  } catch (error) {
    // Keep the last completed cursor and the failed slice's health evidence.
    // A telemetry/checkpoint error never changes the original query failure.
    try {
      reportSlice("failed", error?.code || "operation_failed");
    } catch {
      /* original error below */
    }
    throw error;
  }
}

module.exports = { reconcileEarnCommentCandidates };
