require("dotenv").config();
const { checkAndRespondToProfileMessages } = require("./model/response");

setInterval(checkAndRespondToProfileMessages, 60 * 1000);
