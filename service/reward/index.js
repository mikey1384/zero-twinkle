const axios = require("axios");
const {
  getDayIndexAndNextDay,
  getMonthIndexFromDayIndex,
  getYearFromDayIndex,
} = require("../../helpers/time");

let lastProcessedDayIndex = getDayIndexAndNextDay().dayIndex;

async function checkAndTriggerRewardCard() {
  const { dayIndex } = getDayIndexAndNextDay();

  // Skip if we've already processed this day
  if (dayIndex === lastProcessedDayIndex) {
    return;
  }

  const currentMonth = getMonthIndexFromDayIndex(dayIndex);
  const currentYear = getYearFromDayIndex(dayIndex);

  const previousMonth = getMonthIndexFromDayIndex(lastProcessedDayIndex);
  const previousYear = getYearFromDayIndex(lastProcessedDayIndex);

  // Check for year boundary
  if (currentYear > previousYear) {
    try {
      await axios.post(`${process.env.API_URL}/zero/reward/card`, {
        isYearly: true,
        isMonthly: false,
      });
      console.log(`Triggered yearly reward card for year ${previousYear}`);
    } catch (error) {
      console.error("Failed to trigger yearly reward card:", error.message);
    }
  }

  // Check for month boundary
  if (currentMonth !== previousMonth) {
    try {
      await axios.post(`${process.env.API_URL}/zero/reward/card`, {
        isYearly: false,
        isMonthly: true,
      });
      console.log(
        `Triggered monthly reward card for ${previousYear}-${String(
          previousMonth
        ).padStart(2, "0")}`
      );
    } catch (error) {
      console.error("Failed to trigger monthly reward card:", error.message);
    }
  }

  lastProcessedDayIndex = dayIndex;
}

module.exports = {
  checkAndTriggerRewardCard,
};
