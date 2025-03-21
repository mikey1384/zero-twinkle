require("dotenv").config();

const {
  tagVideosToPlaylist,
  setPlaylistRewardLevel,
  checkAndTriggerRewardCard,
  checkAndUpdateHints,
} = require("./service");

const tagVideosToPlaylistInterval = 60;
const setPlaylistRewardLevelInterval = 60;
const checkRewardCardInterval = 30;
const checkAndUpdateHintsInterval = 1;

setInterval(tagVideosToPlaylist, tagVideosToPlaylistInterval * 1000);
setInterval(setPlaylistRewardLevel, setPlaylistRewardLevelInterval * 1000);
setInterval(checkAndTriggerRewardCard, checkRewardCardInterval * 1000);
setInterval(checkAndUpdateHints, checkAndUpdateHintsInterval * 1000);
