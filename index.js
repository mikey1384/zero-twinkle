require("dotenv").config();
const { checkAndRespondToProfileMessages } = require("./service/response");
const { summarizeMemories } = require("./service/memory");
const { tagVideosToPlaylist } = require("./service/playlist");

setInterval(checkAndRespondToProfileMessages, 60 * 1000);
setInterval(summarizeMemories, 20 * 1000);
setInterval(tagVideosToPlaylist, 60 * 1000);
