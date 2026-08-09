const SELECT_NEXT_PLAYLIST_TAGGING_CANDIDATE = `
  SELECT v.id AS videoId, v.ytTags, v.ytChannelName, v.rewardLevel,
         v.title AS videoTitle, v.content
  FROM vq_videos v
    FORCE INDEX (idx_vq_videos_deleted_id)
  WHERE v.isDeleted = 0
    AND v.ytTags IS NOT NULL
    AND v.ytTags <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM vq_playlistvideos pv
      WHERE pv.videoId = v.id
      LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM vq_playlist_tagging_outcomes outcome
      WHERE outcome.videoId = v.id
        AND outcome.outcome = 'unmatched'
      LIMIT 1
    )
  ORDER BY v.id DESC
  LIMIT 1
`;

async function loadNextPlaylistTaggingCandidate(query) {
  const [candidate = null] = await query(
    SELECT_NEXT_PLAYLIST_TAGGING_CANDIDATE,
    null,
    true,
  );
  return candidate;
}

async function deliverReportBestEffort({
  description,
  deliver,
  logError = console.error,
}) {
  try {
    await deliver();
    return true;
  } catch (error) {
    logError(`Failed to deliver ${description}:`, error);
    return false;
  }
}

async function completePlaylistTagging({
  query,
  videoId,
  outcome,
  report,
  sendReport,
  logError,
  processedAt = Math.floor(Date.now() / 1000),
}) {
  if (outcome !== "matched" && outcome !== "unmatched") {
    throw new Error("Invalid playlist tagging outcome");
  }
  await query(
    `INSERT INTO vq_playlist_tagging_outcomes
       (videoId, outcome, processedAt)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       outcome = VALUES(outcome),
       processedAt = VALUES(processedAt)`,
    [videoId, outcome, processedAt],
  );
  return deliverReportBestEffort({
    description: `playlist tagging report for video ${videoId}`,
    deliver: () => sendReport(report),
    logError,
  });
}

module.exports = {
  SELECT_NEXT_PLAYLIST_TAGGING_CANDIDATE,
  completePlaylistTagging,
  deliverReportBestEffort,
  loadNextPlaylistTaggingCandidate,
};
