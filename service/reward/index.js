const axios = require("axios");
const { apiTransport } = require("../../helpers/apiTransport");

async function checkAndTriggerRewardCard() {
  try {
    const transport = apiTransport("/zero/reward/card");
    await axios.post(transport.url, null, {
      ...transport.config,
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
