const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { reconcileEarnCommentCandidates } = require("../service/earnCandidates");

test("nightly reward reconciliation refreshes the teacher eligibility hint", () => {
  const source = readFileSync(
    path.join(__dirname, "../service/earnCandidates/index.js"),
    "utf8",
  );

  assert.match(source, /teacherEligible/);
  assert.match(source, /rewardDisabled = '0'/);
  assert.match(source, /COALESCE\(u\.achievementPoints, 0\) >=/);
  assert.match(
    source,
    /ON DUPLICATE KEY UPDATE[\s\S]*?teacherEligible = VALUES\(teacherEligible\)/,
  );
  assert.match(source, /JOIN users u ON u\.id = r\.userId/);
  assert.match(source, /LEFT JOIN users_types ut ON ut\.label = u\.userType/);
  assert.doesNotMatch(source, /INSERT[^`]+SELECT/);
  assert.doesNotMatch(source, /DELETE[^`]+NOT EXISTS/);
});

test("nightly reconciliation restores canonical rows after purging a stale snapshot", async () => {
  const commentCandidates = new Set([1, 2]);
  const rewardCandidates = new Map([
    [10, 0],
    [20, 0],
  ]);
  const calls = [];
  const commentEligibilitySnapshots = [
    [{ commentId: 1, subjectId: 100 }],
    [
      { commentId: 1, subjectId: 100 },
      { commentId: 3, subjectId: 300 },
    ],
  ];
  const rewardEligibilitySnapshots = [
    [
      {
        recommendationId: 10,
        commentId: 1,
        subjectId: 100,
        teacherEligible: 0,
      },
    ],
    [
      {
        recommendationId: 10,
        commentId: 1,
        subjectId: 100,
        teacherEligible: 1,
      },
      {
        recommendationId: 30,
        commentId: 3,
        subjectId: 300,
        teacherEligible: 1,
      },
    ],
  ];
  const query = async (sql, params, fromWriter, label) => {
    calls.push({ sql, params, fromWriter, label });
    if (label === "earn_comment_candidates.reconcile_eligibility") {
      return commentEligibilitySnapshots.shift();
    }
    if (label === "earn_reward_candidates.reconcile_eligibility") {
      return rewardEligibilitySnapshots.shift();
    }
    if (label === "earn_comment_candidates.reconcile_restore") {
      for (let index = 0; index < params.length; index += 3) {
        commentCandidates.add(Number(params[index]));
      }
      return { affectedRows: 1 };
    }
    if (label === "earn_reward_candidates.reconcile_restore") {
      for (let index = 0; index < params.length; index += 5) {
        rewardCandidates.set(Number(params[index]), Number(params[index + 4]));
      }
      return { affectedRows: 1 };
    }
    if (label === "earn_comment_candidates.reconcile_current") {
      // Simulate an API hook restoring row 3 after the first canonical read.
      commentCandidates.add(3);
      return [...commentCandidates].map((commentId) => ({ commentId }));
    }
    if (label === "earn_reward_candidates.reconcile_current") {
      rewardCandidates.set(30, 1);
      return [...rewardCandidates].map(
        ([recommendationId, teacherEligible]) => ({
          recommendationId,
          commentId:
            recommendationId === 10 ? 1 : recommendationId === 20 ? 2 : 3,
          subjectId:
            recommendationId === 10 ? 100 : recommendationId === 20 ? 200 : 300,
          teacherEligible,
        }),
      );
    }
    if (label === "earn_comment_candidates.reconcile_purge") {
      params.forEach((id) => commentCandidates.delete(Number(id)));
      return { affectedRows: params.length };
    }
    if (label === "earn_reward_candidates.reconcile_purge") {
      params.forEach((id) => rewardCandidates.delete(Number(id)));
      return { affectedRows: params.length };
    }
    throw new Error(`Unexpected reconciliation query: ${label}`);
  };
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    await reconcileEarnCommentCandidates({
      now: new Date(Date.UTC(2026, 7, 10, 19)),
      query,
    });
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }

  assert.deepEqual(
    [...commentCandidates].sort((a, b) => a - b),
    [1, 3],
  );
  assert.deepEqual([...rewardCandidates.entries()].sort(), [
    [10, 1],
    [30, 1],
  ]);
  assert.equal(
    calls.every(({ fromWriter }) => fromWriter === true),
    true,
  );
  assert.equal(
    calls.some(({ sql }) => /^\s*INSERT\b[\s\S]+SELECT/i.test(sql)),
    false,
  );
  assert.equal(
    calls.some(({ sql }) =>
      /^\s*DELETE\b[\s\S]+(?:JOIN|NOT EXISTS)/i.test(sql),
    ),
    false,
  );
});

test("a partial purge failure still runs the final canonical repair", async () => {
  const candidates = new Set([1, 9]);
  let eligibilityRead = 0;
  const query = async (_sql, params, _fromWriter, label) => {
    if (label === "earn_comment_candidates.reconcile_eligibility") {
      eligibilityRead += 1;
      return eligibilityRead === 1
        ? [{ commentId: 1, subjectId: 100 }]
        : [
            { commentId: 1, subjectId: 100 },
            { commentId: 3, subjectId: 300 },
          ];
    }
    if (label === "earn_comment_candidates.reconcile_restore") {
      for (let index = 0; index < params.length; index += 3) {
        candidates.add(Number(params[index]));
      }
      return { affectedRows: 1 };
    }
    if (label === "earn_comment_candidates.reconcile_current") {
      // The API restores row 3 after the initial canonical snapshot.
      candidates.add(3);
      return [...candidates].map((commentId) => ({ commentId }));
    }
    if (label === "earn_comment_candidates.reconcile_purge") {
      params.forEach((id) => candidates.delete(Number(id)));
      throw new Error("simulated partial purge failure");
    }
    throw new Error(`Unexpected reconciliation query: ${label}`);
  };

  await assert.rejects(
    reconcileEarnCommentCandidates({
      now: new Date(Date.UTC(2026, 7, 10, 19)),
      query,
    }),
    /simulated partial purge failure/,
  );
  assert.deepEqual(
    [...candidates].sort((a, b) => a - b),
    [1, 3],
  );
});
