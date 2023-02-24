require("dotenv").config();
const { checkAndRespondToProfileMessages } = require("./model/response");
const { summarizeMemories } = require("./model/memory");
// const { tagVideosToPlaylist } = require("./model/playlist");

setInterval(checkAndRespondToProfileMessages, 60 * 1000);
setInterval(summarizeMemories, 20 * 1000);
// setInterval(tagVideosToPlaylist, 60 * 1000);
