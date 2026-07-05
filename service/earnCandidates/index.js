const { poolQuery } = require("../helpers");

// Nightly reconciliation for earn_comment_candidates — the candidate table
// the twinkle-api /content/karma/recommend comment picker drives its scan
// from. The API keeps the table in sync with write hooks
// (twinkle-api/helpers/earnCommentCandidates.ts), but hooks can't see every
// eligibility flip — most notably a supermod demotion (userType change or
// achievementPoints recalculation below the teacher threshold) makes comments
// that user's old recommendations/skips had disqualified eligible again, with
// no hook firing. A missing row means the picker never serves that comment,
// so this task re-runs the full backfill (INSERT IGNORE) to restore any
// missing rows, and purges rows that are no longer eligible so the picker's
// scan stays shallow. Both statements are idempotent and re-evaluate
// eligibility at execution time, so overlapping with the API's per-comment
// syncs is safe.
//
// The eligibility rules below MUST mirror
// twinkle-api/helpers/earnCommentCandidates.ts (canonical copy). Literals:
//   length thresholds 700/450/250/100 = expectedResponseLength(5/4/3/default)
//   achievementPoints >= 1000         = levels[TEACHER_LEVEL].ap
//   authLevel > 10                    = supermod bar
// The table is provisioned by the add-earn-comment-candidates migration;
// this task never creates schema.

// Prod ids; ZERO_TWINKLE_ID is already in this service's env, Ciel's id is
// not, hence the documented fallback.
const ZERO_TWINKLE_ID = Number(process.env.ZERO_TWINKLE_ID || 7587);
const CIEL_TWINKLE_ID = Number(process.env.CIEL_TWINKLE_ID || 8411);
const REQUIRED_AP_FOR_SUPERMOD = 1000;

// Full-scan work runs once a day at this UTC hour (19:00 UTC = 4am KST,
// off-peak for the user base). The scheduler ticks hourly; other hours no-op.
const RECONCILE_UTC_HOUR = Number(
  process.env.EARN_CANDIDATE_RECONCILE_UTC_HOUR || 19
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
          AND (COALESCE(ut.authLevel, 0) > 10 OR u.achievementPoints >= ?)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM users_earn_skip_status s
        JOIN users u2 ON u2.id = s.userId
        LEFT JOIN users_types ut2 ON ut2.label = u2.userType
        WHERE s.contentType = 'comment'
          AND s.contentId = b.id
          AND (COALESCE(ut2.authLevel, 0) > 10 OR u2.achievementPoints >= ?)
      )`;

function eligibilityParams() {
  return [
    ZERO_TWINKLE_ID,
    CIEL_TWINKLE_ID,
    REQUIRED_AP_FOR_SUPERMOD,
    REQUIRED_AP_FOR_SUPERMOD,
  ];
}

async function reconcileEarnCommentCandidates() {
  if (new Date().getUTCHours() !== RECONCILE_UTC_HOUR) {
    return;
  }

  const start = Date.now();

  const insertResult = await poolQuery(
    `INSERT IGNORE INTO earn_comment_candidates (commentId, subjectId, timeStamp)
     SELECT b.id, b.subjectId, UNIX_TIMESTAMP()
     ${ELIGIBILITY_SQL}`,
    eligibilityParams()
  );
  const restoredCount = Number(insertResult?.affectedRows || 0);

  const deleteResult = await poolQuery(
    `DELETE ec FROM earn_comment_candidates ec
     WHERE NOT EXISTS (
       SELECT 1
       ${ELIGIBILITY_SQL}
         AND b.id = ec.commentId
     )`,
    eligibilityParams()
  );
  const purgedCount = Number(deleteResult?.affectedRows || 0);

  const durationMs = Date.now() - start;
  if (restoredCount > 0) {
    // Restores mean the API hooks missed an eligibility flip (expected for
    // supermod demotions; anything chronic beyond that deserves a look).
    console.warn(
      `[earnCandidates] restored ${restoredCount} missing candidate row(s) during reconciliation`
    );
  }
  console.log(
    `[earnCandidates] reconciled in ${durationMs}ms (restored ${restoredCount}, purged ${purgedCount})`
  );
}

module.exports = { reconcileEarnCommentCandidates };
