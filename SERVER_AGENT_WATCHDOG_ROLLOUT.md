# Server Agent Watchdog Rollout

Apply these steps after deploying the watchdog hardening changes.

## Goal

The watchdog must run a root-owned installed script, not the checkout copy, while preserving one shared lock between systemd and manual checks.

## Steps

1. Update the checkout at `/home/ec2-user/zero` to the target revision.
2. Reinstall the systemd units and the installed watchdog script:

```bash
cd /home/ec2-user/zero
sudo bash ./scripts/install-aizero-systemd.sh
```

3. Trigger one watchdog run so `systemd` creates the runtime/state directories and the new service definition is exercised:

```bash
sudo systemctl start aizero-watchdog.service
```

4. Verify the service is executing the installed root-owned script:

```bash
sudo systemctl cat aizero-watchdog.service
sudo stat -c '%U:%G %a %n' /usr/local/lib/zero-twinkle/watchdog-aizero.sh
```

Expected state:

- `ExecStart=/usr/local/lib/zero-twinkle/watchdog-aizero.sh`
- `Environment=ALERT_RUN_AS_USER=ec2-user`
- `Environment=LOCK_FILE=/var/lib/aizero-watchdog/watchdog.lock`
- `/usr/local/lib/zero-twinkle/watchdog-aizero.sh` is owned by `root:root`
- mode is `755`

5. Verify the lock and alert-state paths are root-owned:

```bash
sudo stat -c '%U:%G %a %n' /var/lib/aizero-watchdog
sudo stat -c '%U:%G %a %n' /var/lib/aizero-watchdog/watchdog.lock /var/lib/aizero-watchdog/alert.state
```

Expected state:

- `/var/lib/aizero-watchdog` exists with mode `755`
- `/var/lib/aizero-watchdog/watchdog.lock` is `root:ec2-user` with mode `660`
- `/var/lib/aizero-watchdog/alert.state` is `root:root` with mode `600`

6. Check the latest watchdog logs:

```bash
sudo systemctl status aizero-watchdog.service --no-pager
sudo journalctl -u aizero-watchdog.service -n 50 --no-pager
```

7. Verify that a manual check contends with the same lock file:

```bash
cd /home/ec2-user/zero
npm run watchdog:check
```

Expected behavior:

- If the timer-driven run is active, the manual run should print `already running, skipping`.

8. Optional cleanup for the legacy `/tmp` files that are no longer used by the root watchdog:

```bash
sudo rm -f /tmp/aizero-watchdog.lock /tmp/aizero-watchdog-alert.state
```

## Notes

- Do not edit `/usr/local/lib/zero-twinkle/watchdog-aizero.sh` by hand. It is managed by `scripts/install-aizero-systemd.sh`.
- The repo copy at `scripts/watchdog-aizero.sh` is still used for local/manual runs such as `npm run watchdog:check`.
- The watchdog now runs the alert script as `ec2-user` from a login shell to preserve profile-managed Node setups.
- The watchdog records cooldown state only when the external alert script succeeds.
- It still emits the failed-recovery alert path if the restart command exits non-zero.
