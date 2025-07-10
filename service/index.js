const { tagVideosToPlaylist, setPlaylistRewardLevel } = require("./playlist");
const { checkAndTriggerRewardCard } = require("./reward");
const { syncChessPuzzles } = require("./chess");

module.exports = {
  tagVideosToPlaylist,
  setPlaylistRewardLevel,
  checkAndTriggerRewardCard,
  syncChessPuzzles,
};
