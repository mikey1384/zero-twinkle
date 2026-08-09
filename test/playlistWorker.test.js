const assert = require("node:assert/strict");
const test = require("node:test");
const {
  OPENAI_REQUEST_TIMEOUT_MS,
  getPlaylistOpenAiClientOptions,
  parsePlaylistRewardResult,
  parseVideoTags,
} = require("../service/playlist/policy");
const {
  SELECT_NEXT_PLAYLIST_TAGGING_CANDIDATE,
  completePlaylistTagging,
  loadNextPlaylistTaggingCandidate,
} = require("../service/playlist/progress");

test("playlist worker uses a finite provider request deadline", () => {
  assert.deepEqual(getPlaylistOpenAiClientOptions("secret"), {
    apiKey: "secret",
    maxRetries: 0,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
  });
});

test("playlist reward responses require a canonical digit from zero through five", () => {
  assert.deepEqual(
    parsePlaylistRewardResult(
      '```json{"digit":4,"explanation":"Useful lessons"}```',
    ),
    { rewardLevel: 4, explanation: "Useful lessons" },
  );
  assert.throws(
    () => parsePlaylistRewardResult('{"digit":6,"explanation":"invalid"}'),
    /invalid digit/,
  );
});

test("playlist tags are shape checked and bounded before query fan-out", () => {
  const tags = Array.from({ length: 150 }, (_, index) => `tag-${index}`);
  assert.equal(parseVideoTags(JSON.stringify(tags)).length, 100);
  assert.deepEqual(parseVideoTags('{"tag":"not-an-array"}'), []);
});

function createPlaylistProgressModel(candidates) {
  const outcomes = new Map();
  const assignedVideoIds = new Set();
  const selectionReads = [];

  async function query(sql, params, fromWriter) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT v.id AS videoId")) {
      selectionReads.push({ normalized, fromWriter });
      return candidates
        .filter(
          ({ videoId, ytTags }) =>
            ytTags &&
            !assignedVideoIds.has(videoId) &&
            outcomes.get(videoId)?.outcome !== "unmatched",
        )
        .sort((a, b) => b.videoId - a.videoId)
        .slice(0, 1);
    }
    if (normalized.startsWith("INSERT INTO vq_playlist_tagging_outcomes")) {
      const [videoId, outcome, processedAt] = params;
      outcomes.set(videoId, { outcome, processedAt });
      return {};
    }
    throw new Error(`Unexpected query: ${normalized}`);
  }

  return { assignedVideoIds, outcomes, query, selectionReads };
}

test("playlist progress survives report failures and worker restarts", async () => {
  const model = createPlaylistProgressModel([
    { videoId: 13, ytTags: "" },
    { videoId: 12, ytTags: "[]" },
    { videoId: 11, ytTags: "[]" },
  ]);
  const reportAttempts = [];
  const reportErrors = [];

  const first = await loadNextPlaylistTaggingCandidate(model.query);
  assert.equal(first.videoId, 12);
  const delivered = await completePlaylistTagging({
    query: model.query,
    videoId: first.videoId,
    outcome: "unmatched",
    report: { videoId: first.videoId },
    sendReport: async (report) => {
      assert.equal(model.outcomes.get(report.videoId).outcome, "unmatched");
      reportAttempts.push(report.videoId);
      throw new Error("SMTP unavailable");
    },
    logError: (...args) => reportErrors.push(args),
    processedAt: 100,
  });
  assert.equal(delivered, false);
  assert.deepEqual(model.outcomes.get(12), {
    outcome: "unmatched",
    processedAt: 100,
  });

  // A new worker process has no in-memory cursor. The durable outcome alone
  // must advance it to the next candidate while SMTP remains unavailable.
  const afterRestart = await loadNextPlaylistTaggingCandidate(model.query);
  assert.equal(afterRestart.videoId, 11);
  assert.deepEqual(reportAttempts, [12]);
  assert.equal(reportErrors.length, 1);
  assert.equal(
    model.selectionReads.every(({ fromWriter }) => fromWriter === true),
    true,
  );
  assert.match(
    model.selectionReads[0].normalized,
    /NOT EXISTS \( SELECT 1 FROM vq_playlist_tagging_outcomes outcome WHERE outcome\.videoId = v\.id AND outcome\.outcome = 'unmatched'/,
  );
});

test("matched playlist progress also advances independently of reporting", async () => {
  const model = createPlaylistProgressModel([
    { videoId: 22, ytTags: '["math"]' },
    { videoId: 21, ytTags: '["science"]' },
  ]);
  const first = await loadNextPlaylistTaggingCandidate(model.query);
  model.assignedVideoIds.add(first.videoId);

  await completePlaylistTagging({
    query: model.query,
    videoId: first.videoId,
    outcome: "matched",
    report: { videoId: first.videoId },
    sendReport: async () => {
      throw new Error("SMTP unavailable");
    },
    logError: () => {},
    processedAt: 200,
  });

  assert.equal(
    (await loadNextPlaylistTaggingCandidate(model.query)).videoId,
    21,
  );
  assert.equal(model.outcomes.get(22).outcome, "matched");
  model.assignedVideoIds.delete(22);
  assert.equal(
    (await loadNextPlaylistTaggingCandidate(model.query)).videoId,
    22,
  );
  assert.match(
    SELECT_NEXT_PLAYLIST_TAGGING_CANDIDATE,
    /v\.ytTags IS NOT NULL[\s\S]*v\.ytTags <> ''/,
  );
  assert.match(
    SELECT_NEXT_PLAYLIST_TAGGING_CANDIDATE,
    /FORCE INDEX \(idx_vq_videos_deleted_id\)/,
  );
  assert.match(
    SELECT_NEXT_PLAYLIST_TAGGING_CANDIDATE,
    /NOT EXISTS \([\s\S]*vq_playlistvideos[\s\S]*NOT EXISTS \([\s\S]*vq_playlist_tagging_outcomes/,
  );
});

test("playlist reports do not run before durable progress succeeds", async () => {
  let reportAttempted = false;
  await assert.rejects(
    completePlaylistTagging({
      query: async () => {
        throw new Error("checkpoint unavailable");
      },
      videoId: 31,
      outcome: "unmatched",
      report: { videoId: 31 },
      sendReport: async () => {
        reportAttempted = true;
      },
    }),
    /checkpoint unavailable/,
  );
  assert.equal(reportAttempted, false);
});
