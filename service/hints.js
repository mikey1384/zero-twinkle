const { poolQuery } = require("./helpers");
const {
  getDayIndexAndNextDay,
  getYearFromDayIndex,
} = require("./helpers/time");

async function checkAndUpdateHints() {
  const { dayIndex } = getDayIndexAndNextDay();
  const year = getYearFromDayIndex(dayIndex);

  try {
    const rows = await poolQuery(
      `SELECT id FROM content_words_hints 
       WHERE collectTimeStamp IS NULL
       AND dayIndex = ?
       ORDER BY id DESC`,
      [dayIndex]
    );

    const neededCount = 5 - rows.length;
    if (neededCount > 0) {
      const words = await poolQuery(
        `SELECT cw.id, cw.content, cw.wordLevel
         FROM content_words cw
         WHERE cw.id NOT IN (
           SELECT wordId 
           FROM content_words_feeds 
           WHERE action IN ('hit', 'discovered') 
           AND year = ?
         )
         ORDER BY RAND()
         LIMIT ?`,
        [year, neededCount]
      );

      if (words.length > 0) {
        for (const word of words) {
          await poolQuery(
            `INSERT INTO content_words_hints 
             (wordId, content, dayIndex) 
             VALUES (?, ?, ?)`,
            [word.id, word.content, dayIndex]
          );
        }
      }
    }
  } catch (error) {
    console.error("Error checking/updating uncollected hints:", error);
  }
}

module.exports = { checkAndUpdateHints };
