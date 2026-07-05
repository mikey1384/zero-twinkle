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
// rows that are no longer eligible so the pickers' scans stay shallow. All
// statements are idempotent and re-evaluate eligibility at execution time,
// so overlapping with the API's per-comment syncs is safe.
//
// The eligibility rules below MUST mirror the canonical copies in
// twinkle-api/helpers/earnCommentCandidates.ts and earnRewardCandidates.ts.
// Literals:
//   length thresholds 700/450/250/100 = expectedResponseLength(5/4/3/default)
//   achievementPoints >= 1000         = levels[TEACHER_LEVEL].ap
//   authLevel > 10                    = supermod bar
//   reward caps 50/40/30/20/10 (ELSE 5) = per-rewardLevel totalRewards caps
// The tables are provisioned by the add-earn-comment-candidates and
// add-earn-reward-candidates migrations; this task never creates schema.

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

// Recommendation-grain eligibility for earn_reward_candidates (one row per
// currently-rewardable recommendation on a comment). Placeholders:
// ZERO_TWINKLE_ID, CIEL_TWINKLE_ID.
const REWARD_ELIGIBILITY_SQL = `
    FROM content_recommendations r
    JOIN content_comments b ON b.id = r.rootId
    JOIN content_subjects c ON c.id = b.subjectId
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

  const rewardInsertResult = await poolQuery(
    `INSERT IGNORE INTO earn_reward_candidates (recommendationId, commentId, subjectId, timeStamp)
     SELECT r.id, b.id, b.subjectId, UNIX_TIMESTAMP()
     ${REWARD_ELIGIBILITY_SQL}`,
    rewardEligibilityParams()
  );
  const rewardRestoredCount = Number(rewardInsertResult?.affectedRows || 0);

  const rewardDeleteResult = await poolQuery(
    `DELETE erc FROM earn_reward_candidates erc
     WHERE NOT EXISTS (
       SELECT 1
       ${REWARD_ELIGIBILITY_SQL}
         AND r.id = erc.recommendationId
     )`,
    rewardEligibilityParams()
  );
  const rewardPurgedCount = Number(rewardDeleteResult?.affectedRows || 0);

  const durationMs = Date.now() - start;
  if (restoredCount > 0 || rewardRestoredCount > 0) {
    // Restores mean the API hooks missed an eligibility flip (expected for
    // supermod demotions; anything chronic beyond that deserves a look).
    console.warn(
      `[earnCandidates] restored missing candidate row(s) during reconciliation (comment: ${restoredCount}, reward: ${rewardRestoredCount})`
    );
  }
  console.log(
    `[earnCandidates] reconciled in ${durationMs}ms (comment: restored ${restoredCount}, purged ${purgedCount}; reward: restored ${rewardRestoredCount}, purged ${rewardPurgedCount})`
  );
}

module.exports = { reconcileEarnCommentCandidates };
