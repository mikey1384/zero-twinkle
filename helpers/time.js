function getDayIndexAndNextDay() {
  const epochMs = new Date(2022, 0).valueOf();
  const now = Date.now();
  const msInDay = 86400000;
  const dayIndex = Math.floor((now - epochMs) / msInDay);
  const nextDay = (dayIndex + 1) * msInDay + epochMs;
  return { dayIndex, nextDay };
}

function getMonthIndexFromDayIndex(dayIndex) {
  const epochMs = new Date(2022, 0).valueOf();
  const msInDay = 86400000;

  const dateMs = dayIndex * msInDay + epochMs;

  const month = new Date(dateMs).getMonth() + 1;
  return month;
}

function getYearFromDayIndex(dayIndex) {
  const epochMs = new Date(2022, 0).valueOf();
  const msInDay = 86400000;

  const dateMs = dayIndex * msInDay + epochMs;

  const year = new Date(dateMs).getFullYear();
  return year;
}

module.exports = {
  getDayIndexAndNextDay,
  getMonthIndexFromDayIndex,
  getYearFromDayIndex,
};
