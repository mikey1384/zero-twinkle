/**
 * Echo Insights Batch Processing Service
 *
 * Uses Anthropic's Message Batches API for 50% cost savings.
 * Runs every 6 hours via setInterval in zero-twinkle's index.js
 *
 * Flow:
 * 1. Check for pending users in echo_insights_queue
 * 2. Build personality analysis prompts for each user
 * 3. Submit batch to Anthropic API
 * 4. Poll for completion (up to 24 hours)
 * 5. Store results in echo_insights table
 */

const { poolQuery } = require("../helpers");
const axios = require("axios");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const MODEL = "claude-opus-4-5";

// ===================================
// BUILD PERSONALITY PROMPT
// ===================================

function buildPersonalityPrompt(reflections) {
  const reflectionsText = reflections
    .map((r) => `Q: ${r.question}\nA: ${r.response}`)
    .join("\n\n---\n\n");

  return `Analyze this person's personality based on their written reflections. You are an insightful, careful reader.

Important:
- This is for self-reflection, not clinical diagnosis.
- Write ALL outputs in English.
- Be grounded in evidence from the reflections. If something is uncertain, reflect that uncertainty.
- Avoid therapy/jargon terms (e.g., "trauma", "wound", "trigger", "attachment") unless the user explicitly uses that language.

REFLECTIONS (${reflections.length} total):
${reflectionsText}

Based on their writing patterns, thought processes, emotional expressions, and how they approach topics, provide:

1. INTRODUCTION:
- A warm 2-3 sentence paragraph capturing who they are at their core
- 3-4 key strengths (short phrases like "Deep thinker", "Naturally empathetic")
- 2-3 things to watch out for (growth areas, not criticisms). Each item must be concrete and include a tangible downside in real life.
  - Good: "May overthink choices, which can delay decisions or create second-guessing."
  - Good: "Can move fast mentally, which can cause miscommunication when others need more context."
  - Avoid vague advice like "Could benefit from..." without a clear consequence.

2. MBTI ESTIMATE:
- Determine their likely type (e.g., INFJ, ENTP)
- Score each dimension from 0-100 (50 = balanced, 0 = strong first letter, 100 = strong second letter)
  - E/I: 0 = Extraverted, 100 = Introverted
  - S/N: 0 = Sensing, 100 = Intuitive
  - T/F: 0 = Thinking, 100 = Feeling
  - J/P: 0 = Judging, 100 = Perceiving
- Confidence level (how certain you are based on evidence)
- Brief explanation for each dimension based on their writing

3. BIG FIVE SCORES (0-100 for each):
- Openness (curiosity, creativity, openness to new experiences)
- Conscientiousness (organization, dependability, self-discipline)
- Extraversion (sociability, assertiveness, positive emotions)
- Agreeableness (cooperation, trust, empathy)
- Neuroticism (emotional instability, anxiety, moodiness)
- Also include a short combined interpretation that connects the pattern across O/C/E/A/N (2-3 sentences).

4. SUMMARY: A warm, insightful 2-3 sentence summary (can be same as introduction paragraph).

Respond with ONLY valid JSON:
{
  "introduction": {
    "paragraph": "You're a thoughtful person who...",
    "strengths": ["Deep thinker", "Naturally empathetic", "Creative problem-solver"],
    "watchOutFor": ["May overthink choices, which can delay decisions or create second-guessing.", "Needs alone time to recharge, which can look like withdrawal if it's not communicated."]
  },
  "mbti": {
    "type": "XXXX",
    "confidence": 75,
    "breakdown": {
      "EI": { "label": "Introverted", "score": 70, "explanation": "..." },
      "SN": { "label": "Intuitive", "score": 65, "explanation": "..." },
      "TF": { "label": "Feeling", "score": 80, "explanation": "..." },
      "JP": { "label": "Judging", "score": 55, "explanation": "..." }
    },
    "description": "A brief, personalized description of this MBTI type as it shows up in this person (2-4 sentences)."
  },
  "bigFive": {
    "summary": "A short integrated interpretation of their O/C/E/A/N pattern (2-3 sentences).",
    "openness": { "score": 75, "description": "..." },
    "conscientiousness": { "score": 60, "description": "..." },
    "extraversion": { "score": 35, "description": "..." },
    "agreeableness": { "score": 70, "description": "..." },
    "neuroticism": { "score": 40, "description": "..." }
  },
  "summary": "Warm, personalized summary..."
}`;
}

// ===================================
// ANTHROPIC BATCH API HELPERS
// ===================================

async function submitBatch(requests) {
  const response = await axios.post(
    `${ANTHROPIC_BASE_URL}/messages/batches`,
    { requests },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    },
  );
  return response.data;
}

async function getBatchStatus(batchId) {
  const response = await axios.get(
    `${ANTHROPIC_BASE_URL}/messages/batches/${batchId}`,
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    },
  );
  return response.data;
}

async function getBatchResults(resultsUrl) {
  const response = await axios.get(resultsUrl, {
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    // Force text to prevent axios auto-parsing JSON (single-item batches are valid JSON)
    responseType: "text",
  });
  // Response is JSONL (one JSON object per line)
  const lines = response.data.trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

// ===================================
// MAIN BATCH PROCESSING
// ===================================

async function processInsightsQueue() {
  try {
    // First, check for any completed batches that need result processing
    await processCompletedBatches();

    // Then, submit new batch if there are queued users
    await submitNewBatch();
  } catch (error) {
    // Top-level catch to prevent unhandled rejections from killing the worker
    console.error("[Insights] Scheduler error:", error);
  }
}

async function processCompletedBatches() {
  // Find batches that are still processing
  const activeBatches = await poolQuery(
    `SELECT id, batchId FROM echo_insights_batches WHERE status = 'processing'`,
  );

  for (const batch of activeBatches) {
    try {
      const status = await getBatchStatus(batch.batchId);

      if (status.processing_status === "ended") {
        // Download and process results
        if (status.results_url) {
          const results = await getBatchResults(status.results_url);
          await storeResults(results, batch.id);
        }

        // Mark batch as completed
        await poolQuery(
          `UPDATE echo_insights_batches SET status = 'completed', completedAt = ? WHERE id = ?`,
          [Math.floor(Date.now() / 1000), batch.id],
        );

        // Clean up batch items now that batch is complete
        await poolQuery(
          `DELETE FROM echo_insights_batch_items WHERE batchId = ?`,
          [batch.id],
        );
      } else if (status.processing_status === "failed") {
        console.error(`[Insights] Batch ${batch.batchId} failed`);
        await poolQuery(
          `UPDATE echo_insights_batches SET status = 'failed' WHERE id = ?`,
          [batch.id],
        );
        // Re-queue the users for next batch
        await poolQuery(
          `INSERT INTO echo_insights_queue (userId, createdAt)
           SELECT userId, ? FROM echo_insights_batch_items WHERE batchId = ?
           ON DUPLICATE KEY UPDATE createdAt = VALUES(createdAt)`,
          [Math.floor(Date.now() / 1000), batch.id],
        );
        // Clean up batch items after re-queuing
        await poolQuery(
          `DELETE FROM echo_insights_batch_items WHERE batchId = ?`,
          [batch.id],
        );
      }
      // If still processing, do nothing - will check again next run
    } catch (error) {
      console.error(
        `[Insights] Error checking batch ${batch.batchId}:`,
        error.message,
      );
    }
  }
}

async function submitNewBatch() {
  // Get queued users (limit to 100 per batch for manageability)
  const queuedUsers = await poolQuery(
    `SELECT userId FROM echo_insights_queue ORDER BY createdAt ASC LIMIT 100`,
  );

  if (queuedUsers.length === 0) {
    return;
  }

  // Build batch requests
  const requests = [];
  const userReflectionsMap = new Map();

  for (const { userId } of queuedUsers) {
    // Pro-only: never generate insights for free users (no silent caching behind a lock screen).
    const [user] = await poolQuery(
      `SELECT subscriptionTier, subscriptionExpiresAt, proExpiresAt
       FROM echo_users
       WHERE id = ?`,
      [userId],
    );
    if (!user) {
      await poolQuery(`DELETE FROM echo_insights_queue WHERE userId = ?`, [
        userId,
      ]);
      continue;
    }

    const now = Math.floor(Date.now() / 1000);
    const isPromoPro = user.proExpiresAt && Number(user.proExpiresAt) > now;
    const isSubscribedPro =
      user.subscriptionTier === "pro" &&
      (!user.subscriptionExpiresAt || Number(user.subscriptionExpiresAt) > now);

    if (!isPromoPro && !isSubscribedPro) {
      await poolQuery(`DELETE FROM echo_insights_queue WHERE userId = ?`, [
        userId,
      ]);
      continue;
    }

    // Get user's reflections (capped at 30)
    const reflections = await poolQuery(
      `SELECT q.question, r.response
       FROM echo_responses r
       JOIN echo_questions q ON r.questionId = q.id
       WHERE r.userId = ? AND r.isThoughtful = 1
       ORDER BY r.submittedAt DESC
       LIMIT 30`,
      [userId],
    );

    if (reflections.length < 5) {
      // Not enough reflections, remove from queue
      await poolQuery(`DELETE FROM echo_insights_queue WHERE userId = ?`, [
        userId,
      ]);
      continue;
    }

    userReflectionsMap.set(userId, reflections.length);

    requests.push({
      custom_id: `user_${userId}`,
      params: {
        model: MODEL,
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: buildPersonalityPrompt(reflections),
          },
        ],
      },
    });
  }

  if (requests.length === 0) {
    return;
  }

  try {
    // Submit batch
    const batch = await submitBatch(requests);

    const now = Math.floor(Date.now() / 1000);

    // Store batch record
    const batchRecord = await poolQuery(
      `INSERT INTO echo_insights_batches (batchId, status, createdAt)
       VALUES (?, 'processing', ?)`,
      [batch.id, now],
    );

    // Store batch items with reflection count (for re-queuing on failure + accurate metadata)
    for (const { userId } of queuedUsers) {
      if (userReflectionsMap.has(userId)) {
        await poolQuery(
          `INSERT INTO echo_insights_batch_items (batchId, userId, reflectionCount) VALUES (?, ?, ?)`,
          [batchRecord.insertId, userId, userReflectionsMap.get(userId)],
        );
      }
    }

    // Remove processed users from queue
    const processedUserIds = Array.from(userReflectionsMap.keys());
    if (processedUserIds.length > 0) {
      await poolQuery(`DELETE FROM echo_insights_queue WHERE userId IN (?)`, [
        processedUserIds,
      ]);
    }
  } catch (error) {
    console.error("[Insights] Error submitting batch:", error.message);
  }
}

async function storeResults(results, batchDbId) {
  const now = Math.floor(Date.now() / 1000);

  for (const result of results) {
    let userId = null;
    try {
      // Extract userId from custom_id (format: "user_123")
      userId = parseInt(result.custom_id.replace("user_", ""), 10);

      // Anthropic batch JSONL schema (per docs.anthropic.com/en/api/retrieving-message-batch-results):
      // { "custom_id": "...", "result": { "type": "succeeded", "message": { "content": [...] } } }
      if (result.result?.type === "succeeded") {
        const message = result.result.message;
        const textBlock = message.content.find((b) => b.type === "text");

        if (textBlock) {
          // Parse JSON response
          const insights = JSON.parse(textBlock.text.trim());

          // Validate required fields
          if (insights.introduction && insights.mbti && insights.bigFive) {
            // Get reflection count from batch item (what the model actually saw)
            const [batchItem] = await poolQuery(
              `SELECT reflectionCount FROM echo_insights_batch_items WHERE batchId = ? AND userId = ?`,
              [batchDbId, userId],
            );

            // Add metadata (use stored count, fallback to 30 if missing)
            insights.basedOnCount = batchItem?.reflectionCount || 30;
            insights.generatedAt = now;

            // Store in database
            await poolQuery(
              `INSERT INTO echo_insights (userId, insights, generatedAt)
               VALUES (?, ?, ?)
               ON DUPLICATE KEY UPDATE insights = VALUES(insights), generatedAt = VALUES(generatedAt)`,
              [userId, JSON.stringify(insights), now],
            );
          } else {
            await requeueUser(userId, now);
          }
        } else {
          await requeueUser(userId, now);
        }
      } else {
        await requeueUser(userId, now);
      }
    } catch (error) {
      console.error(
        `[Insights] Error processing result for user ${userId}:`,
        error.message,
      );
      if (userId) {
        await requeueUser(userId, Math.floor(Date.now() / 1000));
      }
    }
  }
}

async function requeueUser(userId, now) {
  try {
    await poolQuery(
      `INSERT INTO echo_insights_queue (userId, createdAt)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE createdAt = VALUES(createdAt)`,
      [userId, now],
    );
  } catch (err) {
    console.error(`[Insights] Failed to requeue user ${userId}:`, err.message);
  }
}

module.exports = {
  processInsightsQueue,
};
