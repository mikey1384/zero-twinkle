const axios = require("axios");
const { getDayIndexAndNextDay } = require("../helpers/time");

async function checkAndTriggerRewardCard() {
  const { dayIndex } = getDayIndexAndNextDay();

  try {
    await axios.post(`${process.env.API_URL}/zero/reward/card`, {
      currentDayIndex: dayIndex,
    });
  } catch (error) {
    console.error("Failed to trigger reward card:", error.message);
  }
}

module.exports = {
  checkAndTriggerRewardCard,
};
