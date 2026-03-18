# zero-twinkle
Scripts used for automating various tasks for the Twinkle website.

## Robust Production Setup

The robust setup is `systemd` + watchdog timer:

- `systemd/aizero.service`: runs `node index.js` with `Restart=always`
- `systemd/aizero-watchdog.service`: checks process + heartbeat freshness
- `systemd/aizero-watchdog.timer`: runs watchdog every minute
- `scripts/install-aizero-systemd.sh`: installs the units and a root-owned watchdog script at `/usr/local/lib/zero-twinkle/watchdog-aizero.sh`

Install with root:

```bash
cd /home/ec2-user/zero
sudo bash ./scripts/install-aizero-systemd.sh
```

Check status:

```bash
sudo systemctl status aizero.service --no-pager
sudo systemctl status aizero-watchdog.timer --no-pager
```

Package scripts now target that same detached `systemd` service path:

```bash
bun run start
bun run stop
bun run restart
bun run status
```

## Echo Notification Timing

- `runEchoNotifications` is checked every `900` seconds on wall-clock quarter hours, not every hour from service start.
- Daily reminders and streak reminders only send when the user's local minute is exactly `00`.
- This is intentional so users in full-hour, half-hour, and quarter-hour offsets get notifications at local `x:00`, not at the server start offset like `x:26`.
- After changing Echo scheduling logic in `index.js` or `service/echo/index.js`, restart `aizero.service`.

## Heartbeat And Recovery

- Heartbeat file: `/tmp/aizero-heartbeat.json`
- Repo watchdog script: `scripts/watchdog-aizero.sh`
- Installed watchdog script used by `systemd`: `/usr/local/lib/zero-twinkle/watchdog-aizero.sh`
- Shared watchdog lock + state: `/var/lib/aizero-watchdog/watchdog.lock`, `/var/lib/aizero-watchdog/alert.state`
- Open-incident state: `/var/lib/aizero-watchdog/outage.state`
- Planned-maintenance state: `/var/lib/aizero-watchdog/maintenance.state`
- Email alert script: `scripts/send-error-report.mjs`
- Default stale threshold: `180` seconds
- Default recovery command: `bash ./scripts/aizero-service.sh restart` (override with `RECOVERY_CMD`)
- Alert behavior: sends on outage detection, sends again if recovery fails, and sends a recovery email after a previously alerted incident becomes healthy
- Important operational caveat: a manual `systemctl restart aizero.service` can look like `process_down` to the watchdog unless maintenance mode is enabled first
- Watchdog alert env vars:
  `MAIL_USER`, `MAIL_CLIENT_ID`, `MAIL_PRIVATE_KEY`
  Optional overrides: `ERROR_REPORT_TO`, `ERROR_REPORT_FROM`, `ERROR_REPORT_SUBJECT`

Re-run `sudo bash ./scripts/install-aizero-systemd.sh` after changing the watchdog script or systemd units so the installed root-owned script stays in sync.
The installer provisions the shared lock as `root:<app-group> 0660`, so manual checks contend with the timer-driven watchdog.

Manual watchdog check:

```bash
npm run watchdog:check
```

Planned maintenance before a manual restart or deploy:

```bash
sudo bash ./scripts/watchdog-maintenance-aizero.sh on 180 "deploy restart"
sudo systemctl restart aizero.service
sudo bash ./scripts/watchdog-maintenance-aizero.sh off
```

Maintenance status:

```bash
bash ./scripts/watchdog-maintenance-aizero.sh status
```

If you change `scripts/watchdog-aizero.sh` or `systemd/aizero-watchdog.*`, reinstall before assuming production matches the repo:

```bash
sudo bash ./scripts/install-aizero-systemd.sh
```

Manual email test:

```bash
node ./scripts/send-error-report.mjs "AIZero/Watchdog" "aizero alert test" "manual test"
```

## Safe Git Sync

If the checkout has local changes, do not run plain `git pull` on top of them. Preserve the real work as a commit, fetch, then rebase:

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

This repo often has local `bun.lockb` drift and archived `zero_*.log.gz` files on the server. Keep them out of functional deploy commits unless they are intentionally part of the change.
