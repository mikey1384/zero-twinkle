# Server Agent Maintenance (zero-twinkle on EC2)

How to keep the deployed zero-twinkle service agent up to date and verify it is
healthy. This replaces the old one-time `SERVER_AGENT_WATCHDOG_ROLLOUT.md`
(that migration was applied and verified on the box on 2026-07-13).

## Where it runs

- Host: same EC2 box as the API — `ssh -i ~/twinkle-api.pem ec2-user@api.twinkle.network`
- Checkout: `/home/ec2-user/zero`
- Supervisor: systemd `aizero.service` + `aizero-watchdog.timer`
- The watchdog executes the **installed root-owned copy** at
  `/usr/local/lib/zero-twinkle/watchdog-aizero.sh` — never the checkout copy.
  Do not edit the installed copy by hand; it is managed by
  `scripts/install-aizero-systemd.sh`.

## Standard update (code/task changes, no watchdog changes)

1. Sync the checkout using the safe pattern from `CLAUDE.md` ("Git Sync On The
   Server") — never plain `git pull` on a dirty checkout; keep `bun.lockb` and
   archived `zero_*.log.gz` local state out of functional commits.
2. Run `npm install` if either `package.json` or `package-lock.json` changed.
   Lockfile-only updates can change the deployed dependency resolutions.
3. Restart through the wrapper (it enables watchdog maintenance first and
   clears it after, so you don't get a false `process_down` outage email):

```bash
cd /home/ec2-user/zero
bun run restart
bun run status
```

4. Confirm the service came back and tasks are ticking:

```bash
systemctl is-active aizero.service
journalctl -u aizero.service -n 30 --no-pager
```

## Updating the watchdog itself

After changing `scripts/watchdog-aizero.sh` or `systemd/aizero-watchdog.*`:

```bash
cd /home/ec2-user/zero
sudo bash ./scripts/watchdog-maintenance-aizero.sh on 180 "watchdog update"
sudo bash ./scripts/install-aizero-systemd.sh
sudo systemctl start aizero-watchdog.service   # exercise the new definition once
sudo bash ./scripts/watchdog-maintenance-aizero.sh off
```

## Health verification (run any time; all read-only)

```bash
systemctl is-active aizero.service aizero-watchdog.timer
systemctl cat aizero-watchdog.service | grep -E 'ExecStart|Environment'
stat -c '%U:%G %a %n' /usr/local/lib/zero-twinkle/watchdog-aizero.sh
stat -c '%U:%G %a %n' /var/lib/aizero-watchdog
sudo stat -c '%U:%G %a %n' /var/lib/aizero-watchdog/watchdog.lock
journalctl -u aizero-watchdog.service -n 50 --no-pager
```

Expected state:

| Check | Expected |
|---|---|
| `ExecStart` | `/usr/local/lib/zero-twinkle/watchdog-aizero.sh` |
| Env | `ALERT_RUN_AS_USER=ec2-user`, `LOCK_FILE=/var/lib/aizero-watchdog/watchdog.lock` |
| Installed script | `root:root` mode `755` |
| `/var/lib/aizero-watchdog` | `root:root` mode `755` |
| `watchdog.lock` | `root:ec2-user` mode `660` |
| `alert.state` | `root:root` `600` when present; the installer creates it empty, a sent alert populates it, and a healthy watchdog run removes it |
| `outage.state` | `root:root` `600` when present; exists only while an alerted incident is awaiting successful recovery notification |
| `maintenance.state` | `root:root` `644`, present only while maintenance is on |
| Manual `npm run watchdog:check` during a timer run | prints `already running, skipping` (shared lock works) |

## Alert semantics

- **Outage email** — heartbeat stale or process down; watchdog attempts
  `systemctl restart aizero.service`.
- **Failed-recovery email** — after the restart attempt and
  `RECOVERY_WAIT_SECONDS`, the service is still unhealthy. The restart command
  exit code is included in the alert details but does not by itself determine
  whether this email is sent.
- **Recovery email** — a previously alerted incident became healthy again
  (open-incident state is kept until then).
- False `process_down` alerts almost always mean someone restarted
  `aizero.service` without maintenance mode — use `bun run restart`, or wrap a
  manual restart with `watchdog-maintenance-aizero.sh on/off`.

## Notes

- The repo copy `scripts/watchdog-aizero.sh` is still what local/manual runs
  (`npm run watchdog:check`) use; the installed root-owned copy is what the
  timer runs. Keeping them in sync is exactly what
  `install-aizero-systemd.sh` is for.
- The watchdog runs the alert script as `ec2-user` from a login shell to keep
  profile-managed Node setups working.
- Cooldown state is recorded only when the external alert script succeeds.
