const axios = require("axios");

async function checkAndTriggerRewardCard() {
  try {
    await axios.post(`${process.env.API_URL}/zero/reward/card`);
  } catch (error) {
    console.error("Failed to trigger reward card:", error.message);
  }
}

module.exports = {
  checkAndTriggerRewardCard,
};
