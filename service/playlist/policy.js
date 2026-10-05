const OPENAI_REQUEST_TIMEOUT_MS = 60_000;
const OPENAI_INPUT_MAX_CHARS = 12 * 1024;
const OPENAI_OUTPUT_MAX_CHARS = 16 * 1024;
const MAX_VIDEO_TAGS = 100;

function boundText(value, maxChars) {
  return String(value || "").slice(0, maxChars);
}

function getPlaylistOpenAiClientOptions(apiKey) {
  return {
    apiKey,
    maxRetries: 0,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
  };
}

function parsePlaylistRewardResult(rawResult) {
  const normalized = boundText(rawResult, OPENAI_OUTPUT_MAX_CHARS)
    .replace("```json", "")
    .replace("```", "")
    .trim();
  const parsed = JSON.parse(normalized);
  const rewardLevel = Number(parsed?.digit);
  if (!Number.isInteger(rewardLevel) || rewardLevel < 0 || rewardLevel > 5) {
    throw new Error("Playlist reward response contained an invalid digit");
  }
  return {
    rewardLevel,
    explanation: boundText(parsed?.explanation, 2_000),
  };
}

function parseVideoTags(rawTags) {
  const parsed = JSON.parse(boundText(rawTags, OPENAI_INPUT_MAX_CHARS));
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .slice(0, MAX_VIDEO_TAGS)
    .map((tag) => boundText(tag, 100).trim())
    .filter(Boolean);
}

// The label becomes a permanent public playlist title, so accept only a short plain category.
// Anything else (citations, links, a preamble, injected text) leaves the video unmatched.
function cleanSuggestedLabel(text) {
  const label = String(text || "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\([^)]*\)/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";
  const cleaned = label
    .replace(/[‘’ʼ]/g, "'")
    .replace(/^label\s*:\s*/i, "")
    .replace(/["“”.*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 40) return "";
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &'-]*$/u.test(cleaned)) return "";
  if (cleaned.split(" ").length > 3) return "";
  return cleaned;
}

module.exports = {
  OPENAI_INPUT_MAX_CHARS,
  OPENAI_OUTPUT_MAX_CHARS,
  OPENAI_REQUEST_TIMEOUT_MS,
  boundText,
  cleanSuggestedLabel,
  getPlaylistOpenAiClientOptions,
  parsePlaylistRewardResult,
  parseVideoTags,
};
