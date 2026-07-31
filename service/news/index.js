const axios = require("axios");
const { auth } = require("../../config");

async function processTwinkleNewspaper() {
  try {
    await axios.post(
      `${process.env.API_URL}/zero/news/process`,
      null,
      auth
    );
  } catch (error) {
    console.error(
      "Failed to process Twinkle newspaper:",
      error.response?.data?.error || error.message
    );
    throw error;
  }
}

module.exports = {
  processTwinkleNewspaper,
};
