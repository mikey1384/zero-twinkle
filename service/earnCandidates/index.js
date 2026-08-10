const { poolQuery } = require("../helpers");

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

// Full-scan work runs once a day at this UTC hour (19:00 UTC = 4am KST,
// off-peak for the user base). The scheduler ticks hourly; other hours no-op.
const RECONCILE_UTC_HOUR = Number(
  process.env.EARN_CANDIDATE_RECONCILE_UTC_HOUR || 19,
);

const ELIGIBILITY_SQL = `
    FROM content_comments b
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
    FROM content_recommendations r
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

async function loadEligibleCommentCandidates(query) {
  return query(
    `SELECT b.id AS commentId, b.subjectId
     ${ELIGIBILITY_SQL}`,
    eligibilityParams(),
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

async function loadEligibleRewardCandidates(query) {
  return query(
    `SELECT
       r.id AS recommendationId,
       b.id AS commentId,
       b.subjectId,
       ${REWARD_TEACHER_ELIGIBILITY_SQL} AS teacherEligible
     ${REWARD_ELIGIBILITY_SQL}`,
    rewardEligibilityParams(),
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

async function loadCurrentCommentCandidates(query) {
  return query(
    `SELECT commentId FROM earn_comment_candidates`,
    null,
    true,
    "earn_comment_candidates.reconcile_current",
  );
}

async function loadCurrentRewardCandidates(query) {
  return query(
    `SELECT recommendationId, commentId, subjectId, teacherEligible
     FROM earn_reward_candidates`,
    null,
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

async function reconcileEarnCommentCandidates(options = {}) {
  const now = options.now || new Date();
  const query = options.query || poolQuery;
  if (now.getUTCHours() !== RECONCILE_UTC_HOUR) {
    return;
  }

  const start = Date.now();
  const initialCommentRows = await loadEligibleCommentCandidates(query);
  const currentCommentRows = await loadCurrentCommentCandidates(query);
  const initialCommentRepairs = commentRepairRows(
    currentCommentRows,
    initialCommentRows,
  );
  await restoreCommentCandidates(initialCommentRepairs, query);
  const restoredCount = initialCommentRepairs.length;
  let purgedCount = 0;
  let commentPurgeError;
  try {
    purgedCount = await purgeStaleCandidates({
      query,
      table: "earn_comment_candidates",
      idColumn: "commentId",
      eligibleRows: initialCommentRows,
      eligibleRowId: (row) => row.commentId,
      currentRows: currentCommentRows,
      currentRowId: (row) => row.commentId,
      queryLabel: "earn_comment_candidates",
    });
  } catch (error) {
    commentPurgeError = error;
  }
  // Even a partial purge can have removed a row inserted by a concurrent API
  // hook after the first snapshot. Always make the final canonical repair
  // attempt before propagating cleanup failure.
  const finalCommentRows = await loadEligibleCommentCandidates(query);
  const commentRowsToRepair = commentRepairRows(
    initialCommentRows,
    finalCommentRows,
  );
  await restoreCommentCandidates(commentRowsToRepair, query);
  const finalRestoredCount = commentRowsToRepair.length;
  if (commentPurgeError) throw commentPurgeError;

  const initialRewardRows = await loadEligibleRewardCandidates(query);
  const currentRewardRows = await loadCurrentRewardCandidates(query);
  const initialRewardRepairs = rewardRepairRows(
    currentRewardRows,
    initialRewardRows,
  );
  await restoreRewardCandidates(initialRewardRepairs, query);
  const rewardRestoredCount = initialRewardRepairs.length;
  let rewardPurgedCount = 0;
  let rewardPurgeError;
  try {
    rewardPurgedCount = await purgeStaleCandidates({
      query,
      table: "earn_reward_candidates",
      idColumn: "recommendationId",
      eligibleRows: initialRewardRows,
      eligibleRowId: (row) => row.recommendationId,
      currentRows: currentRewardRows,
      currentRowId: (row) => row.recommendationId,
      queryLabel: "earn_reward_candidates",
    });
  } catch (error) {
    rewardPurgeError = error;
  }
  const finalRewardRows = await loadEligibleRewardCandidates(query);
  const rewardRowsToRepair = rewardRepairRows(
    initialRewardRows,
    finalRewardRows,
  );
  await restoreRewardCandidates(rewardRowsToRepair, query);
  const finalRewardRestoredCount = rewardRowsToRepair.length;
  if (rewardPurgeError) throw rewardPurgeError;

  const durationMs = Date.now() - start;
  if (
    restoredCount > 0 ||
    finalRestoredCount > 0 ||
    rewardRestoredCount > 0 ||
    finalRewardRestoredCount > 0
  ) {
    // Repairs mean an API hook missed a row or a user's level changed the
    // canonical eligibility projection; anything chronic deserves a look.
    console.warn(
      `[earnCandidates] repaired candidate row(s) during reconciliation (comment: initial ${restoredCount}, post-purge ${finalRestoredCount}; reward: initial ${rewardRestoredCount}, post-purge ${finalRewardRestoredCount})`,
    );
  }
  console.log(
    `[earnCandidates] reconciled in ${durationMs}ms (comment: repaired ${restoredCount} + ${finalRestoredCount}, purged ${purgedCount}; reward: repaired ${rewardRestoredCount} + ${finalRewardRestoredCount}, purged ${rewardPurgedCount})`,
  );
}

module.exports = { reconcileEarnCommentCandidates };
