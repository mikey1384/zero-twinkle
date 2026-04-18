/**
 * Echo Notification Service for zero-twinkle
 *
 * Sends daily reminders and streak notifications to Echo users.
 * Runs on aligned quarter-hour checks in zero-twinkle's index.js.
 */

const { poolQuery } = require("../helpers");
const { DateTime } = require("luxon");
const fetch = require("node-fetch");

// Expo Push Notification endpoint
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Day resets at 7 AM local time
const DAY_RESET_HOUR = 7;
const EXPIRED_SUBSCRIPTION_CLEANUP_GRACE_SECONDS = readPositiveIntEnv(
  "ECHO_EXPIRED_SUBSCRIPTION_CLEANUP_GRACE_SECONDS",
  24 * 60 * 60,
);
const EXPIRED_SUBSCRIPTION_CLEANUP_BATCH_SIZE = readPositiveIntEnv(
  "ECHO_EXPIRED_SUBSCRIPTION_CLEANUP_BATCH_SIZE",
  500,
);
const EXPIRED_SUBSCRIPTION_CLEANUP_MAX_BATCHES = readPositiveIntEnv(
  "ECHO_EXPIRED_SUBSCRIPTION_CLEANUP_MAX_BATCHES",
  20,
);
const REVENUECAT_SECRET_KEY = process.env.REVENUECAT_SECRET_KEY || "";
const REVENUECAT_PROJECT_ID = process.env.REVENUECAT_PROJECT_ID || "";
const REVENUECAT_API_BASE_URL = "https://api.revenuecat.com/v2";
const REVENUECAT_RENEWING_STATUSES = new Set([
  "will_renew",
  "will_change_product",
  "has_already_renewed",
]);
const ECHO_RENEWAL_STATUS_RECONCILE_BATCH_SIZE = readPositiveIntEnv(
  "ECHO_RENEWAL_STATUS_RECONCILE_BATCH_SIZE",
  50,
);
const ECHO_RENEWAL_STATUS_RECONCILE_DELAY_MS = readPositiveIntEnv(
  "ECHO_RENEWAL_STATUS_RECONCILE_DELAY_MS",
  150,
);
let renewalStatusReconcileCursor = {
  subscriptionExpiresAt: 0,
  id: 0,
};
let warnedMissingRevenueCatConfig = false;

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRevenueCatCustomerPath(userId, suffix) {
  const projectId = encodeURIComponent(REVENUECAT_PROJECT_ID);
  const customerId = encodeURIComponent(String(userId));
  return `/projects/${projectId}/customers/${customerId}${suffix}`;
}

function epochMsToSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value / 1000);
}

function getRevenueCatSubscriptionExpiresAt(subscription) {
  return epochMsToSeconds(
    subscription?.ends_at ?? subscription?.current_period_ends_at,
  );
}

function findActiveRevenueCatSubscription(subscriptions, now) {
  let activeSubscription = null;

  for (const subscription of subscriptions) {
    if (subscription?.gives_access !== true) continue;

    const expiresAt = getRevenueCatSubscriptionExpiresAt(subscription);
    if (expiresAt !== null && expiresAt < now) continue;

    const candidate = {
      expiresAt,
      autoRenew: REVENUECAT_RENEWING_STATUSES.has(
        subscription.auto_renewal_status || "",
      ),
    };

    const candidateExpiry = candidate.expiresAt ?? Number.MAX_SAFE_INTEGER;
    const activeExpiry =
      activeSubscription?.expiresAt ?? Number.MAX_SAFE_INTEGER;
    if (!activeSubscription || candidateExpiry > activeExpiry) {
      activeSubscription = candidate;
    }
  }

  return activeSubscription;
}

async function fetchRevenueCatSubscriptions(userId) {
  const response = await fetch(
    `${REVENUECAT_API_BASE_URL}${getRevenueCatCustomerPath(
      userId,
      "/subscriptions?limit=20",
    )}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${REVENUECAT_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    throw new Error(`RevenueCat API error: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data?.items) ? data.items : [];
}

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

function getCurrentTimePartsInTimezone(timezone) {
  try {
    const dt = DateTime.now().setZone(timezone);
    if (!dt.isValid) throw new Error("Invalid timezone");
    return { hour: dt.hour, minute: dt.minute };
  } catch {
    const utc = DateTime.utc();
    return { hour: utc.hour, minute: utc.minute };
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
    const { hour: userHour, minute: userMinute } =
      getCurrentTimePartsInTimezone(timezone);
    if (
      userHour !== (user.dailyReminderHour ?? DAY_RESET_HOUR) ||
      userMinute !== 0
    ) {
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
    const { hour: userHour, minute: userMinute } =
      getCurrentTimePartsInTimezone(timezone);
    if (userHour !== 20 || userMinute !== 0) {
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

async function purgeExpiredPendingEchoSignups() {
  const now = Math.floor(Date.now() / 1000);
  const batchSize = 500;
  const maxBatchesPerRun = 20;
  let totalDeleted = 0;

  for (let batch = 0; batch < maxBatchesPerRun; batch += 1) {
    try {
      const result = await poolQuery(
        `DELETE FROM echo_pending_signups
         WHERE expiresAt < ?
         ORDER BY expiresAt ASC
         LIMIT ${batchSize}`,
        [now],
      );
      const deletedRows = Number(result?.affectedRows || 0);
      totalDeleted += deletedRows;

      if (deletedRows < batchSize) {
        break;
      }
    } catch (error) {
      if (error?.code === "ER_NO_SUCH_TABLE") {
        return { deleted: 0 };
      }
      throw error;
    }
  }

  if (totalDeleted > 0) {
    console.log(`[Echo] Purged ${totalDeleted} expired pending signups`);
  }

  if (totalDeleted === batchSize * maxBatchesPerRun) {
    console.warn(
      `[Echo] Pending signup purge hit the per-run cap (${maxBatchesPerRun} batches)`,
    );
  }

  return { deleted: totalDeleted };
}

async function reconcileExpiredEchoSubscriptions() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - EXPIRED_SUBSCRIPTION_CLEANUP_GRACE_SECONDS;
  let totalUpdated = 0;

  for (
    let batch = 0;
    batch < EXPIRED_SUBSCRIPTION_CLEANUP_MAX_BATCHES;
    batch += 1
  ) {
    const result = await poolQuery(
      `UPDATE echo_users
       SET subscriptionTier = 'free',
           subscriptionExpiresAt = NULL,
           autoRenew = 0
       WHERE subscriptionTier = 'pro'
         AND subscriptionExpiresAt IS NOT NULL
         AND subscriptionExpiresAt < ?
       ORDER BY subscriptionExpiresAt ASC
       LIMIT ${EXPIRED_SUBSCRIPTION_CLEANUP_BATCH_SIZE}`,
      [cutoff],
    );
    const updatedRows = Number(result?.affectedRows || 0);
    totalUpdated += updatedRows;

    if (updatedRows < EXPIRED_SUBSCRIPTION_CLEANUP_BATCH_SIZE) {
      break;
    }
  }

  if (totalUpdated > 0) {
    console.log(
      `[Echo] Reconciled ${totalUpdated} expired subscription user rows`,
    );
  }

  if (
    totalUpdated ===
    EXPIRED_SUBSCRIPTION_CLEANUP_BATCH_SIZE *
      EXPIRED_SUBSCRIPTION_CLEANUP_MAX_BATCHES
  ) {
    console.warn(
      `[Echo] Subscription cleanup hit the per-run cap (${EXPIRED_SUBSCRIPTION_CLEANUP_MAX_BATCHES} batches)`,
    );
  }

  return { updated: totalUpdated };
}

async function selectEchoRenewalStatusGraceBatch(now, cutoff, limit) {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit <= 0) return [];

  return poolQuery(
    `SELECT id, subscriptionExpiresAt, autoRenew
     FROM echo_users
     WHERE subscriptionTier = 'pro'
       AND autoRenew = 1
       AND subscriptionExpiresAt IS NOT NULL
       AND subscriptionExpiresAt >= ?
       AND subscriptionExpiresAt < ?
     ORDER BY subscriptionExpiresAt ASC, id ASC
     LIMIT ${normalizedLimit}`,
    [cutoff, now],
  );
}

async function selectEchoRenewalStatusActiveBatch(now, limit) {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit <= 0) return [];

  const cursorExpiresAt = renewalStatusReconcileCursor.subscriptionExpiresAt;
  const cursorId = renewalStatusReconcileCursor.id;

  const rows = await poolQuery(
    `SELECT id, subscriptionExpiresAt, autoRenew
     FROM echo_users
     WHERE subscriptionTier = 'pro'
       AND autoRenew = 1
       AND subscriptionExpiresAt IS NOT NULL
       AND subscriptionExpiresAt >= ?
       AND (
         subscriptionExpiresAt > ?
         OR (subscriptionExpiresAt = ? AND id > ?)
       )
     ORDER BY subscriptionExpiresAt ASC, id ASC
     LIMIT ${normalizedLimit}`,
    [now, cursorExpiresAt, cursorExpiresAt, cursorId],
  );

  if (
    rows.length === 0 &&
    (renewalStatusReconcileCursor.subscriptionExpiresAt > 0 ||
      renewalStatusReconcileCursor.id > 0)
  ) {
    renewalStatusReconcileCursor = { subscriptionExpiresAt: 0, id: 0 };
    return selectEchoRenewalStatusActiveBatch(now, normalizedLimit);
  }

  return rows;
}

async function selectEchoRenewalStatusReconcileBatch(now) {
  const cutoff = now - EXPIRED_SUBSCRIPTION_CLEANUP_GRACE_SECONDS;
  const graceRows = await selectEchoRenewalStatusGraceBatch(
    now,
    cutoff,
    ECHO_RENEWAL_STATUS_RECONCILE_BATCH_SIZE,
  );
  const remaining =
    ECHO_RENEWAL_STATUS_RECONCILE_BATCH_SIZE - graceRows.length;
  const activeRows = await selectEchoRenewalStatusActiveBatch(now, remaining);
  return [...graceRows, ...activeRows];
}

async function reconcileEchoSubscriptionRenewalStatus() {
  if (!REVENUECAT_SECRET_KEY || !REVENUECAT_PROJECT_ID) {
    if (!warnedMissingRevenueCatConfig) {
      console.warn(
        "[Echo] Skipping renewal status reconciliation: RevenueCat config is missing",
      );
      warnedMissingRevenueCatConfig = true;
    }
    return { checked: 0, updated: 0, errors: 0, skipped: true };
  }

  const now = Math.floor(Date.now() / 1000);
  const rows = await selectEchoRenewalStatusReconcileBatch(now);
  let checked = 0;
  let updated = 0;
  let errors = 0;

  for (const row of rows) {
    const rowSubscriptionExpiresAt = Number(row.subscriptionExpiresAt || 0);
    if (rowSubscriptionExpiresAt >= now) {
      renewalStatusReconcileCursor = {
        subscriptionExpiresAt: rowSubscriptionExpiresAt,
        id: Number(row.id || 0),
      };
    }
    checked += 1;

    try {
      const subscriptions = await fetchRevenueCatSubscriptions(row.id);
      const activeSubscription = findActiveRevenueCatSubscription(
        subscriptions,
        now,
      );
      const nextAutoRenew = activeSubscription?.autoRenew === true ? 1 : 0;
      const nextSubscriptionExpiresAt =
        activeSubscription?.expiresAt ?? rowSubscriptionExpiresAt;

      if (
        nextAutoRenew !== Number(row.autoRenew || 0) ||
        nextSubscriptionExpiresAt !== rowSubscriptionExpiresAt
      ) {
        await poolQuery(
          `UPDATE echo_users
           SET autoRenew = ?,
               subscriptionExpiresAt = ?
           WHERE id = ?
             AND subscriptionTier = 'pro'`,
          [nextAutoRenew, nextSubscriptionExpiresAt, row.id],
        );
        updated += 1;
      }
    } catch (error) {
      errors += 1;
      console.error(
        `[Echo] Failed to reconcile RevenueCat renewal status for user ${row.id}:`,
        error?.message || error,
      );
    }

    if (ECHO_RENEWAL_STATUS_RECONCILE_DELAY_MS > 0) {
      await sleep(ECHO_RENEWAL_STATUS_RECONCILE_DELAY_MS);
    }
  }

  if (checked > 0 && (updated > 0 || errors > 0)) {
    console.log(
      `[Echo] Reconciled RevenueCat renewal status: checked=${checked}, updated=${updated}, errors=${errors}`,
    );
  }

  if (checked === ECHO_RENEWAL_STATUS_RECONCILE_BATCH_SIZE) {
    console.warn(
      `[Echo] Renewal status reconciliation hit the per-run cap (${ECHO_RENEWAL_STATUS_RECONCILE_BATCH_SIZE})`,
    );
  }

  return { checked, updated, errors, skipped: false };
}

async function reconcileEchoSubscriptions() {
  const renewalStatus = await reconcileEchoSubscriptionRenewalStatus();
  const expiredSubscriptions = await reconcileExpiredEchoSubscriptions();
  return { renewalStatus, expiredSubscriptions };
}

module.exports = {
  runEchoNotifications,
  sendDailyReminders,
  sendStreakReminders,
  purgeExpiredPendingEchoSignups,
  reconcileExpiredEchoSubscriptions,
  reconcileEchoSubscriptionRenewalStatus,
  reconcileEchoSubscriptions,
};
