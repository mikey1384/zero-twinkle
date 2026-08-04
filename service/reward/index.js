const axios = require("axios");

async function checkAndTriggerRewardCard() {
  try {
    await axios.post(`${process.env.API_URL}/zero/reward/card`, null, {
      timeout: 20_000,
      maxBodyLength: 16 * 1024,
      maxContentLength: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Failed to trigger reward card: ${String(error?.message || error).slice(0, 200)}`,
    );
  }
}

module.exports = {
  checkAndTriggerRewardCard,
};
