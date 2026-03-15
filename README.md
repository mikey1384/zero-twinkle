# zero-twinkle
Scripts used for automating various tasks for the Twinkle website.

## Robust Production Setup

The robust setup is `systemd` + watchdog timer:

- `systemd/aizero.service`: runs `node index.js` with `Restart=always`
- `systemd/aizero-watchdog.service`: checks process + heartbeat freshness
- `systemd/aizero-watchdog.timer`: runs watchdog every minute

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
- Watchdog script: `scripts/watchdog-aizero.sh`
- Default stale threshold: `180` seconds
- Default recovery command: `bash ./scripts/pm2-aizero.sh start` (override with `RECOVERY_CMD`)

Manual watchdog check:

```bash
npm run watchdog:check
```
