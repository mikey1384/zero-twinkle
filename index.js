require("dotenv").config();
const { checkAndRespondToProfileMessages } = require("./model/response");
const { summarizeMemories } = require("./model/memory");

setInterval(checkAndRespondToProfileMessages, 60 * 1000);
setInterval(summarizeMemories, 60 * 1000);
