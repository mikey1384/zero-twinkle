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
    if (label.endsWith(".reconcile_ceiling")) return [{ maxId: 100 }];
    if (label.endsWith(".reconcile_source_page")) return [];
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
    if (label.endsWith(".reconcile_ceiling")) return [{ maxId: 100 }];
    if (label.endsWith(".reconcile_source_page")) return [];
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

test("bounded pages resume across a restart and retain orphan cleanup and eligibility", async () => {
  let saved = null;
  let clock = 0;
  const source = Array.from({ length: 1201 }, (_, i) => i + 1);
  const candidates = new Set([1, 700, 1201, 2000]);
  const pages = [];
  const query = async (sql, params, writer, label) => {
    assert.equal(writer, true);
    if (label === "earn_reward_candidates.reconcile_ceiling")
      return [{ maxId: 0 }];
    if (label.endsWith(".reconcile_ceiling")) return [{ maxId: 2000 }];
    if (label.endsWith(".reconcile_source_page")) {
      return source
        .filter((id) => id > params[0] && id <= params[1])
        .slice(0, 500)
        .map((cursorId) => ({ cursorId }));
    }
    if (label.endsWith(".reconcile_current")) {
      return [...candidates]
        .sort((a, b) => a - b)
        .filter((id) => id > params[0] && id <= params[1])
        .slice(0, 500)
        .map((commentId) => ({ commentId }));
    }
    if (label.endsWith(".reconcile_eligibility")) {
      const [after, through] = params.slice(-2);
      const rows = source
        .filter((id) => id > after && id <= through && id % 2 === 0)
        .map((commentId) => ({ commentId, subjectId: 10 }));
      assert.ok(rows.length <= 500);
      pages.push([after, through]);
      return rows;
    }
    if (label.endsWith(".reconcile_restore")) {
      for (let i = 0; i < params.length; i += 3) candidates.add(params[i]);
      return { affectedRows: params.length / 3 };
    }
    if (label.endsWith(".reconcile_purge")) {
      for (const id of params) candidates.delete(id);
      return { affectedRows: params.length };
    }
    throw new Error(label);
  };
  const common = {
    query,
    clock: () => clock,
    maxRunMs: 10,
    loadCheckpoint: () => saved && structuredClone(saved),
    saveCheckpoint: (state) => {
      saved = structuredClone(state);
    },
    pause: async () => {
      clock += 10;
    },
  };
  const first = await reconcileEarnCommentCandidates({
    ...common,
    now: new Date("2026-10-14T19:00:00Z"),
  });
  assert.equal(first.status, "paused");
  assert.equal(saved.after, 500);
  assert.ok(candidates.has(2));
  assert.ok(!candidates.has(1));
  assert.ok(candidates.has(2000));
  // A later process/tick, outside the start hour, resumes the saved cursor.
  let result;
  do {
    result = await reconcileEarnCommentCandidates({
      ...common,
      now: new Date("2026-10-15T02:00:00Z"),
    });
  } while (result.status === "paused");
  assert.equal(result.status, "complete");
  assert.equal(result.totals.batches, 3);
  assert.equal(result.totals.repaired, 599);
  assert.equal(result.totals.purged, 3);
  assert.ok(result.totals.pausedSlices > 0);
  assert.deepEqual(
    [...candidates].sort((a, b) => a - b),
    source.filter((id) => id % 2 === 0),
  );
  assert.deepEqual(pages.slice(0, 3), [
    [0, 500],
    [0, 500],
    [500, 1000],
  ]);
  assert.equal(
    pages.filter(([after]) => after === 500).length,
    1,
    "unchanged range does not need a second canonical scan",
  );
  const completed = await reconcileEarnCommentCandidates({
    ...common,
    now: new Date("2026-10-14T20:00:00Z"),
  });
  assert.equal(completed.status, "idle");
  const nextDay = await reconcileEarnCommentCandidates({ ...common, now: new Date('2026-10-15T19:00:00Z') });
  assert.equal(nextDay.checkpoint.lastCompleted.day, '2026-10-14');
  assert.equal(nextDay.checkpoint.lastCompleted.totals.batches, 3);
});

test("database pressure defers without querying or advancing the saved work", async () => {
  const state = {
    version: 1,
    day: "2026-10-14",
    phase: 0,
    after: 500,
    ceiling: 2000,
  };
  const result = await reconcileEarnCommentCandidates({
    now: new Date("2026-10-14T20:00:00Z"),
    query: () => assert.fail("must yield first"),
    loadCheckpoint: () => structuredClone(state),
    saveCheckpoint: (saved) => {
      assert.equal(saved.after, state.after);
      assert.equal(saved.phase, state.phase);
    },
    shouldPause: async () => true,
  });
  assert.equal(result.status, "paused");
  assert.equal(result.checkpoint.after, state.after);
  assert.equal(result.reason, "database_pressure");
  assert.equal(result.checkpoint.totals.pausedSlices, 1);
});

test("orphan candidates are paged even when the source has a large ID gap", async () => {
  const candidates = new Set(Array.from({ length: 1100 }, (_, i) => i + 1));
  let largestRead = 0;
  const query = async (_sql, params, _writer, label) => {
    if (label === "earn_reward_candidates.reconcile_ceiling")
      return [{ maxId: 0 }];
    if (label.endsWith(".reconcile_ceiling")) return [{ maxId: 9000 }];
    if (label.endsWith(".reconcile_source_page"))
      return params[0] < 9000 ? [{ cursorId: 9000 }] : [];
    if (label.endsWith(".reconcile_current")) {
      const rows = [...candidates]
        .filter((id) => id > params[0] && id <= params[1])
        .slice(0, 500)
        .map((commentId) => ({ commentId }));
      largestRead = Math.max(largestRead, rows.length);
      return rows;
    }
    if (label.endsWith(".reconcile_eligibility"))
      return params.at(-1) === 9000 ? [{ commentId: 9000, subjectId: 10 }] : [];
    if (label.endsWith(".reconcile_purge")) {
      params.forEach((id) => candidates.delete(id));
      return { affectedRows: params.length };
    }
    if (label.endsWith(".reconcile_restore")) {
      for (let i = 0; i < params.length; i += 3) candidates.add(params[i]);
      return { affectedRows: 1 };
    }
    throw new Error(label);
  };
  const result = await reconcileEarnCommentCandidates({
    query,
    now: new Date("2026-10-14T19:00:00Z"),
    pause: async () => {},
  });
  assert.equal(result.status, "complete");
  assert.equal(largestRead, 500);
  assert.deepEqual([...candidates], [9000]);
});

test("the checkpoint survives an unfinished replacement and rejects corrupt committed state", (t) => {
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(
    path.join(__dirname, "../../work/earn-checkpoint-test-"),
  );
  const before = process.env.EARN_CANDIDATE_CHECKPOINT_FILE;
  process.env.EARN_CANDIDATE_CHECKPOINT_FILE = path.join(dir, "state.json");
  t.after(() => {
    if (before === undefined) delete process.env.EARN_CANDIDATE_CHECKPOINT_FILE;
    else process.env.EARN_CANDIDATE_CHECKPOINT_FILE = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const {
    readCheckpoint,
    writeCheckpoint,
  } = require("../service/earnCandidates/checkpoint");
  const state = {
    version: 1,
    day: "2026-10-14",
    phase: 0,
    after: 500,
    ceiling: 1000,
  };
  assert.equal(readCheckpoint(), null);
  writeCheckpoint(state);
  fs.writeFileSync(
    `${process.env.EARN_CANDIDATE_CHECKPOINT_FILE}.999.next`,
    "{partial",
  );
  assert.deepEqual(readCheckpoint(), state);
  assert.equal(
    fs.statSync(process.env.EARN_CANDIDATE_CHECKPOINT_FILE).mode & 0o777,
    0o600,
  );
  fs.writeFileSync(process.env.EARN_CANDIDATE_CHECKPOINT_FILE, "{corrupt");
  assert.throws(readCheckpoint, SyntaxError);
});
