# CLAUDE.md - zero-twinkle

## Project Overview

zero-twinkle is a dedicated Node.js cron/scheduler service that runs periodic background tasks for the Twinkle Network ecosystem. It runs separately from the main API to ensure scheduled tasks aren't affected by API deployments or load.

**Runtime:** Node.js (CommonJS)
**Process Manager:** PM2
**Database:** Same MySQL database as twinkle-api (via mysql2)

## Directory Structure

```
zero-twinkle/
├── index.js              # Main entry point, sets up all intervals
├── service/
│   ├── index.js          # Exports all service functions
│   ├── playlist/         # YouTube playlist automation
│   ├── reward/           # Vocabulary reward card generation
│   ├── chess/            # Chess puzzle sync (disabled)
│   ├── leaderboards/     # Word Master rankings
│   └── echo/             # Echo app notifications
│       └── index.js      # Daily reminders & streak notifications
├── helpers/
│   └── index.js          # Database helpers (poolQuery)
└── package.json
```

## Scheduled Tasks

| Task | Interval | Description |
|------|----------|-------------|
| `tagVideosToPlaylist` | 60s | Tags videos to YouTube playlists |
| `setPlaylistRewardLevel` | 60s | Sets reward levels for playlists |
| `checkAndTriggerRewardCard` | 30s | Checks and triggers vocabulary reward cards |
| `updateWordMasterRankings` | 900s (15min) | Updates Word Master leaderboard rankings |
| `runEchoNotifications` | 3600s (1hr) | Sends Echo app push notifications |
| `processInsightsQueue` | 21600s (6hr) | Batch processes personality insights (50% cost savings) |

### Echo Insights Batch Processing

The Echo insights service (`service/echo/insights.js`) handles:

1. **Queue Processing** - Checks `echo_insights_queue` for users needing personality analysis
2. **Batch Submission** - Submits requests to Anthropic's Message Batches API (50% cost savings)
3. **Result Polling** - Checks active batches for completion (up to 24 hours)
4. **Result Storage** - Parses JSONL results and stores in `echo_insights` table

**Requires:** `ANTHROPIC_API_KEY` environment variable

### Echo Notifications

The Echo notification service (`service/echo/index.js`) handles:

1. **Daily Reminders** - Sent at each user's configured reminder hour (default 7 AM local time)
   - Personalized message based on streak status
   - Only sent if user hasn't already reflected today
   - Tracks `lastDailyReminderDate` to prevent duplicate sends

2. **Streak Reminders** - Sent at 8 PM local time
   - Only sent if streak is salvageable (lastLocalDate = yesterday)
   - Only sent if user hasn't reflected yet today
   - Tracks `lastStreakReminderDate` to prevent duplicates

**Date System:** Uses Duolingo-style per-user local dates. The "day" resets at 7 AM in each user's timezone, not midnight.

**Push Provider:** Expo Push Notifications API (`https://exp.host/--/api/v2/push/send`)

## Development

```bash
# Install dependencies
npm install

# Run locally (for testing)
node index.js

# Production (via PM2)
pm2 start index.js --name zero-twinkle
pm2 save
```

## Database Access

Uses the same MySQL database as twinkle-api via the `poolQuery` helper:

```javascript
const { poolQuery } = require("../helpers");
const users = await poolQuery(`SELECT * FROM users WHERE id = ?`, [userId]);
```

**Note:** Unlike twinkle-api, there's no primary/replica distinction here. All queries go through a single connection pool.

## Environment Variables

Requires a `.env` file with database credentials:

```env
DB_HOST=...
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
```

## PM2 Hot-Reload Safety

The `index.js` uses `global.twinkleIntervals` to prevent interval stacking when PM2 hot-reloads:

```javascript
if (global.twinkleIntervals) {
  global.twinkleIntervals.forEach(clearInterval);
}
global.twinkleIntervals = [];
```

## Relationship to Other Projects

- **twinkle-api**: Main backend API. Set `ECHO_SCHEDULER_DISABLED=true` in production to use zero-twinkle for Echo notifications instead of the in-process scheduler.
- **echo**: React Native app that relies on this service for push notifications
- **twinkle-vite**: Frontend (no direct relationship)

## Adding New Scheduled Tasks

1. Create service module in `service/yourFeature/index.js`
2. Export function from `service/index.js`
3. Import and add interval in `index.js`:
   ```javascript
   const { yourTask } = require("./service");
   const yourTaskInterval = 300; // seconds
   global.twinkleIntervals.push(
     setInterval(yourTask, yourTaskInterval * 1000)
   );
   ```
