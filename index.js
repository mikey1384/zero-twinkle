require("dotenv").config();

const { tagVideosToPlaylist, setPlaylistRewardLevel } = require("./service");

const tagVideosToPlaylistInterval = 60;
const setPlaylistRewardLevelInterval = 60;

setInterval(tagVideosToPlaylist, tagVideosToPlaylistInterval * 1000);
setInterval(setPlaylistRewardLevel, setPlaylistRewardLevelInterval * 1000);
