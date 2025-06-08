const { tagVideosToPlaylist, setPlaylistRewardLevel } = require("./playlist");
const { checkAndTriggerRewardCard } = require("./reward");
const { syncChessPuzzles, cleanupOldPuzzles } = require("./chess");

module.exports = {
  tagVideosToPlaylist,
  setPlaylistRewardLevel,
  checkAndTriggerRewardCard,
  syncChessPuzzles,
  cleanupOldPuzzles,
};
