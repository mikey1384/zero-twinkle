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

## Heartbeat And Recovery

- Heartbeat file: `/tmp/aizero-heartbeat.json`
- Repo watchdog script: `scripts/watchdog-aizero.sh`
- Installed watchdog script used by `systemd`: `/usr/local/lib/zero-twinkle/watchdog-aizero.sh`
- Shared watchdog lock + state: `/var/lib/aizero-watchdog/watchdog.lock`, `/var/lib/aizero-watchdog/alert.state`
- Open-incident state: `/var/lib/aizero-watchdog/outage.state`
- Planned-maintenance state: `/var/lib/aizero-watchdog/maintenance.state`
- Email alert script: `scripts/send-error-report.mjs`
- Default stale threshold: `180` seconds
- Default recovery command: `bash ./scripts/pm2-aizero.sh start` (override with `RECOVERY_CMD`)
- Alert behavior: sends on outage detection, sends again if recovery fails, and sends a recovery email after a previously alerted incident becomes healthy
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

Manual email test:

```bash
node ./scripts/send-error-report.mjs "AIZero/Watchdog" "aizero alert test" "manual test"
```
