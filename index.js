require("dotenv").config();

const {
  tagVideosToPlaylist,
  setPlaylistRewardLevel,
  checkAndTriggerRewardCard,
} = require("./service");

const tagVideosToPlaylistInterval = 60;
const setPlaylistRewardLevelInterval = 60;
const checkRewardCardInterval = 30;

setInterval(tagVideosToPlaylist, tagVideosToPlaylistInterval * 1000);
setInterval(setPlaylistRewardLevel, setPlaylistRewardLevelInterval * 1000);
setInterval(checkAndTriggerRewardCard, checkRewardCardInterval * 1000);
