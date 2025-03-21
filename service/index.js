const { tagVideosToPlaylist, setPlaylistRewardLevel } = require("./playlist");
const { checkAndTriggerRewardCard } = require("./reward");
const { checkAndUpdateHints } = require("./hints.js");

module.exports = {
  tagVideosToPlaylist,
  setPlaylistRewardLevel,
  checkAndTriggerRewardCard,
  checkAndUpdateHints,
};
