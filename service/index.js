const { tagVideosToPlaylist, setPlaylistRewardLevel } = require("./playlist");
const { checkAndTriggerRewardCard } = require("./reward");
const { checkAndUpdateHints } = require("./hint.js");

module.exports = {
  tagVideosToPlaylist,
  setPlaylistRewardLevel,
  checkAndTriggerRewardCard,
  checkAndUpdateHints,
};
