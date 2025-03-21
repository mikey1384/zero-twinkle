const epochMs = Date.UTC(2022, 0, 1, 0, 0, 0);
const msInDay = 86400000;

function getDayIndexAndNextDay() {
  const now = Date.now();
  const dayIndex = Math.floor((now - epochMs) / msInDay);
  const nextDay = (dayIndex + 1) * msInDay + epochMs;
  return { dayIndex, nextDay };
}

function getMonthIndexFromDayIndex(dayIndex) {
  const dateMs = epochMs + dayIndex * msInDay;
  const date = new Date(dateMs);
  return date.getUTCMonth() + 1;
}

function getYearFromDayIndex(dayIndex) {
  const dateMs = epochMs + dayIndex * msInDay;
  const date = new Date(dateMs);
  return date.getUTCFullYear();
}

module.exports = {
  getDayIndexAndNextDay,
  getMonthIndexFromDayIndex,
  getYearFromDayIndex,
};
