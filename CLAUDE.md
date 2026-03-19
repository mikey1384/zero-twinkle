# CLAUDE.md - zero-twinkle

## Project Overview

zero-twinkle is a dedicated Node.js cron/scheduler service that runs periodic background tasks for the Twinkle Network ecosystem. It runs separately from the main API to ensure scheduled tasks aren't affected by API deployments or load.

**Runtime:** Node.js (CommonJS)
**Production Supervisor:** systemd (`aizero.service`) plus `aizero-watchdog.timer`
**Fallback/Recovery Wrapper:** PM2 scripts still exist and are used by some recovery paths
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
| `runEchoNotifications` | 900s (15min, wall-clock aligned) | Checks on quarter-hour boundaries and only sends at the user's local `:00` |

### Echo Notifications

The Echo notification service (`service/echo/index.js`) handles:

1. **Daily Reminders** - Sent at each user's configured reminder hour (default 7 AM local time)
   - Personalized message based on streak status
   - Only sent if user hasn't already reflected today
   - Tracks `lastDailyReminderDate` to prevent duplicate sends
   - Scheduler checks every 15 minutes, but reminders only send when the user's local minute is `00`

2. **Streak Reminders** - Sent at 8 PM local time
   - Only sent if streak is salvageable (lastLocalDate = yesterday)
   - Only sent if user hasn't reflected yet today
   - Tracks `lastStreakReminderDate` to prevent duplicates
   - Also gated to local minute `00`

**Date System:** Uses Duolingo-style per-user local dates. The "day" resets at 7 AM in each user's timezone, not midnight.

**Important:** Do not assume Echo runs "an hour after startup." The service intentionally aligns checks to wall-clock quarter hours so reminders land at local `x:00` instead of drifting to the server start offset.

**Push Provider:** Expo Push Notifications API (`https://exp.host/--/api/v2/push/send`)

## Development

```bash
# Install dependencies
npm install

# Run locally (for testing)
node index.js

# Production (systemd)
sudo systemctl restart aizero.service
sudo systemctl status aizero.service --no-pager
```

## Operational Notes

### Watchdog Deploy Safety

- Production uses the installed root-owned watchdog script at `/usr/local/lib/zero-twinkle/watchdog-aizero.sh`, not just the repo copy.
- After changing `scripts/watchdog-aizero.sh` or `systemd/aizero-watchdog.*`, run:
  ```bash
  sudo bash ./scripts/install-aizero-systemd.sh
  ```
- Before a planned restart or rollout, enable maintenance so the watchdog does not send a false outage email during the restart window:
  ```bash
  sudo bash ./scripts/watchdog-maintenance-aizero.sh on 180 "deploy restart"
  sudo systemctl restart aizero.service
  sudo bash ./scripts/watchdog-maintenance-aizero.sh off
  ```
- The watchdog now sends:
  - outage detection email
  - failed-recovery email if restart did not fix it
  - recovery email once a previously alerted incident becomes healthy again

### Git Sync On The Server

- Do not run plain `git pull` on a dirty checkout.
- Safe pattern:
  ```bash
  git switch -c wip/<topic>
  git add <intentional-files>
  git commit -m "<message>"
  git stash push -u -m "tmp-local-state" -- bun.lockb zero_err__*.log.gz zero_out__*.log.gz
  git fetch origin
  git rebase origin/main
  git switch main
  git merge --ff-only wip/<topic>
  git stash pop
  ```
- `bun.lockb` and archived `zero_*.log.gz` files often exist as unrelated local state on this host. Do not mix them into functional commits unless intentional.

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
