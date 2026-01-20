const { tagVideosToPlaylist, setPlaylistRewardLevel } = require("./playlist");
const { checkAndTriggerRewardCard } = require("./reward");
const { syncChessPuzzles } = require("./chess");
const { updateWordMasterRankings } = require("./leaderboards/wordMaster");

module.exports = {
  tagVideosToPlaylist,
  setPlaylistRewardLevel,
  checkAndTriggerRewardCard,
  syncChessPuzzles,
  updateWordMasterRankings,
};
