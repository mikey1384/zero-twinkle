/**
 * Echo Notification Service for zero-twinkle
 *
 * Sends daily reminders and streak notifications to Echo users.
 * Runs hourly via setInterval in zero-twinkle's index.js
 */

const { poolQuery } = require("../helpers");
const { DateTime } = require("luxon");
const fetch = require("node-fetch");

// Expo Push Notification endpoint
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Day resets at 7 AM local time
const DAY_RESET_HOUR = 7;

// ===================================
// DATE HELPERS (ported from TypeScript)
// ===================================

function getEchoDateTime(timezone) {
  const dt = DateTime.now().setZone(timezone);
  if (!dt.isValid) throw new Error("Invalid timezone");
  // If before 7 AM, subtract a day (still yesterday's Echo day)
  if (dt.hour < DAY_RESET_HOUR) {
    return dt.minus({ days: 1 });
  }
  return dt;
}

function getUserLocalDate(timezone) {
  try {
    return getEchoDateTime(timezone).toFormat("yyyy-MM-dd");
  } catch {
    // Invalid timezone, fall back to UTC
    const utc = DateTime.utc();
    if (utc.hour < DAY_RESET_HOUR) {
      return utc.minus({ days: 1 }).toFormat("yyyy-MM-dd");
    }
    return utc.toFormat("yyyy-MM-dd");
  }
}

function getUserPreviousDate(timezone) {
  try {
    return getEchoDateTime(timezone).minus({ days: 1 }).toFormat("yyyy-MM-dd");
  } catch {
    const utc = DateTime.utc();
    if (utc.hour < DAY_RESET_HOUR) {
      return utc.minus({ days: 2 }).toFormat("yyyy-MM-dd");
    }
    return utc.minus({ days: 1 }).toFormat("yyyy-MM-dd");
  }
}

function getCurrentHourInTimezone(timezone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
  } catch {
    // Invalid timezone, default to UTC
    return new Date().getUTCHours();
  }
}

// ===================================
// EXPO PUSH NOTIFICATIONS
// ===================================

async function sendExpoPushNotifications(messages) {
  if (messages.length === 0) return [];

  // Expo recommends sending in batches of 100
  const batches = [];
  for (let i = 0; i < messages.length; i += 100) {
    batches.push(messages.slice(i, i + 100));
  }

  const tickets = [];

  for (const batch of batches) {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      });

      const result = await response.json();
      tickets.push(...(result.data || []));
    } catch (error) {
      console.error("[Echo] Expo push error:", error);
      // Add error tickets for this batch
      tickets.push(
        ...batch.map(() => ({ status: "error", message: "Network error" })),
      );
    }
  }

  return tickets;
}

// ===================================
// GET USERS FOR NOTIFICATIONS
// ===================================

async function getUsersForDailyReminder() {
  // Find users who:
  // 1. Have push tokens
  // 2. Have daily reminders enabled
  // 3. It's their reminder hour in their timezone
  const users = await poolQuery(`
    SELECT DISTINCT
      u.id as userId,
      u.timezone,
      u.dailyReminderHour,
      u.lastDailyReminderDate,
      COALESCE(s.currentStreak, 0) as currentStreak,
      s.lastLocalDate
    FROM echo_users u
    INNER JOIN echo_push_tokens pt ON pt.userId = u.id
    LEFT JOIN echo_streaks s ON s.userId = u.id
    WHERE u.notificationsEnabled = 1
      AND u.dailyReminderEnabled = 1
  `);

  const result = [];

  for (const user of users) {
    const timezone = user.timezone || "UTC";

    // Check if it's the right hour in user's timezone
    // Default to DAY_RESET_HOUR (7 AM) - same time the day resets
    const userHour = getCurrentHourInTimezone(timezone);
    if (userHour !== (user.dailyReminderHour ?? DAY_RESET_HOUR)) {
      continue;
    }

    // Get user's local date (Duolingo-style per-user day)
    const localDate = getUserLocalDate(timezone);

    // Skip if we already sent a reminder for this date (prevents duplicate sends)
    if (user.lastDailyReminderDate === localDate) {
      continue;
    }

    // Check if user has already responded today (in their timezone)
    const [todayResponse] = await poolQuery(
      `SELECT r.id FROM echo_questions q
       JOIN echo_responses r ON r.questionId = q.id AND r.grade != 'Fail'
       WHERE q.userId = ? AND q.localDate = ?`,
      [user.userId, localDate],
    );

    if (todayResponse) {
      // Already responded today, skip
      continue;
    }

    const tokens = await poolQuery(
      `SELECT token FROM echo_push_tokens WHERE userId = ?`,
      [user.userId],
    );

    if (tokens.length > 0) {
      result.push({
        userId: user.userId,
        tokens: tokens.map((t) => t.token),
        currentStreak: user.currentStreak || 0,
        lastLocalDate: user.lastLocalDate || null,
        timezone,
        localDate,
      });
    }
  }

  return result;
}

async function getUsersWithStreakAtRisk() {
  // Find users who:
  // 1. Have push tokens
  // 2. Have streak reminders enabled
  // 3. Have a streak > 0
  // 4. It's evening (around 8pm) in their timezone
  // 5. Their streak is still salvageable (lastLocalDate = yesterday)
  const users = await poolQuery(`
    SELECT DISTINCT
      u.id as userId,
      u.timezone,
      u.lastStreakReminderDate,
      s.currentStreak,
      s.lastLocalDate
    FROM echo_users u
    INNER JOIN echo_push_tokens pt ON pt.userId = u.id
    INNER JOIN echo_streaks s ON s.userId = u.id AND s.currentStreak > 0
    WHERE u.notificationsEnabled = 1
      AND u.streakReminderEnabled = 1
  `);

  const result = [];

  for (const user of users) {
    const timezone = user.timezone || "UTC";

    // Send streak warning at 8pm local time
    const userHour = getCurrentHourInTimezone(timezone);
    if (userHour !== 20) {
      continue;
    }

    // Get user's local date (Duolingo-style per-user day)
    const localDate = getUserLocalDate(timezone);
    const yesterday = getUserPreviousDate(timezone);

    // Skip if streak is already broken (lastLocalDate is not yesterday)
    // If the user's last response was before yesterday, their streak is gone
    // and we shouldn't send a misleading "Don't lose your streak!" notification
    if (user.lastLocalDate !== yesterday) {
      continue;
    }

    // Skip if we already sent a streak reminder for this date
    if (user.lastStreakReminderDate === localDate) {
      continue;
    }

    // Check if user has already responded today (in their timezone)
    const [todayResponse] = await poolQuery(
      `SELECT r.id FROM echo_questions q
       JOIN echo_responses r ON r.questionId = q.id AND r.grade != 'Fail'
       WHERE q.userId = ? AND q.localDate = ?`,
      [user.userId, localDate],
    );

    if (todayResponse) {
      // Already responded today, streak is safe
      continue;
    }

    const tokens = await poolQuery(
      `SELECT token FROM echo_push_tokens WHERE userId = ?`,
      [user.userId],
    );

    if (tokens.length > 0) {
      result.push({
        userId: user.userId,
        tokens: tokens.map((t) => t.token),
        currentStreak: user.currentStreak,
        timezone,
        localDate,
      });
    }
  }

  return result;
}

// ===================================
// SEND NOTIFICATIONS
// ===================================

async function sendDailyReminders() {
  const users = await getUsersForDailyReminder();

  if (users.length === 0) {
    return { sent: 0, errors: 0 };
  }

  const messages = [];
  const userMessageMap = new Map();

  let messageIndex = 0;
  for (const user of users) {
    const yesterday = getUserPreviousDate(user.timezone);
    const isStreakSalvageable =
      user.currentStreak > 0 && user.lastLocalDate === yesterday;
    const body = isStreakSalvageable
      ? `Keep your ${user.currentStreak}-day streak going!`
      : `Take a moment to reflect today.`;

    userMessageMap.set(user.userId, {
      localDate: user.localDate,
      startIndex: messageIndex,
      count: user.tokens.length,
    });

    for (const token of user.tokens) {
      messages.push({
        to: token,
        title: "Your daily Echo awaits",
        body,
        sound: "default",
        data: { type: "daily_reminder" },
      });
      messageIndex++;
    }
  }

  const tickets = await sendExpoPushNotifications(messages);

  const sent = tickets.filter((t) => t.status === "ok").length;
  const errors = tickets.filter((t) => t.status === "error").length;

  // Record lastDailyReminderDate for users who received at least one successful notification
  for (const user of users) {
    const mapping = userMessageMap.get(user.userId);
    if (!mapping) continue;

    // Check if at least one message was sent successfully
    let anySuccess = false;
    for (
      let i = mapping.startIndex;
      i < mapping.startIndex + mapping.count;
      i++
    ) {
      if (tickets[i]?.status === "ok") {
        anySuccess = true;
        break;
      }
    }

    if (anySuccess) {
      // Record that we sent a reminder for this date (prevents duplicate sends)
      await poolQuery(
        `UPDATE echo_users SET lastDailyReminderDate = ? WHERE id = ?`,
        [mapping.localDate, user.userId],
      );
    }
  }

  // Clean up invalid tokens
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    if (
      ticket.status === "error" &&
      ticket.details?.error === "DeviceNotRegistered"
    ) {
      await poolQuery(`DELETE FROM echo_push_tokens WHERE token = ?`, [
        messages[i].to,
      ]);
    }
  }

  return { sent, errors };
}

async function sendStreakReminders() {
  const users = await getUsersWithStreakAtRisk();

  if (users.length === 0) {
    return { sent: 0, errors: 0 };
  }

  const messages = [];
  const userMessageMap = new Map();

  let messageIndex = 0;
  for (const user of users) {
    userMessageMap.set(user.userId, {
      localDate: user.localDate,
      startIndex: messageIndex,
      count: user.tokens.length,
    });

    for (const token of user.tokens) {
      messages.push({
        to: token,
        title: `Don't lose your ${user.currentStreak}-day streak!`,
        body: `You haven't written yet today. Just a few minutes to keep it going.`,
        sound: "default",
        data: { type: "streak_reminder" },
      });
      messageIndex++;
    }
  }

  const tickets = await sendExpoPushNotifications(messages);

  const sent = tickets.filter((t) => t.status === "ok").length;
  const errors = tickets.filter((t) => t.status === "error").length;

  // Record lastStreakReminderDate for users who received at least one successful notification
  for (const user of users) {
    const mapping = userMessageMap.get(user.userId);
    if (!mapping) continue;

    // Check if at least one message was sent successfully
    let anySuccess = false;
    for (
      let i = mapping.startIndex;
      i < mapping.startIndex + mapping.count;
      i++
    ) {
      if (tickets[i]?.status === "ok") {
        anySuccess = true;
        break;
      }
    }

    if (anySuccess) {
      // Record that we sent a streak reminder for this date (prevents duplicate sends)
      await poolQuery(
        `UPDATE echo_users SET lastStreakReminderDate = ? WHERE id = ?`,
        [mapping.localDate, user.userId],
      );
    }
  }

  // Clean up invalid tokens
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    if (
      ticket.status === "error" &&
      ticket.details?.error === "DeviceNotRegistered"
    ) {
      await poolQuery(`DELETE FROM echo_push_tokens WHERE token = ?`, [
        messages[i].to,
      ]);
    }
  }

  return { sent, errors };
}

// ===================================
// MAIN SCHEDULER FUNCTION
// ===================================

async function runEchoNotifications() {
  try {
    const dailyResult = await sendDailyReminders();
    const streakResult = await sendStreakReminders();

    // Only log if we actually sent something
    if (dailyResult.sent > 0 || streakResult.sent > 0) {
      console.log(
        `[Echo] Notifications: daily=${dailyResult.sent}, streak=${streakResult.sent}`,
      );
    }
    if (dailyResult.errors > 0 || streakResult.errors > 0) {
      console.error(
        `[Echo] Notification errors: daily=${dailyResult.errors}, streak=${streakResult.errors}`,
      );
    }
  } catch (error) {
    console.error("[Echo] Notification scheduler error:", error);
  }
}

module.exports = {
  runEchoNotifications,
  sendDailyReminders,
  sendStreakReminders,
};
