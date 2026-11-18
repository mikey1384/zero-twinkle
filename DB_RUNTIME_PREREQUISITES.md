# Restricted DB runtime prerequisites

Code-only prerequisite. No credentials, accounts, grants, services or host files
changed. This repository runs independently at `/home/ec2-user/zero`; API config
sync never supplies its configuration. At the separately authorized cutover,
update Zero's `.env` to the runtime identity, preserve endpoints/TLS, restart
`aizero.service`, and verify writer and reader CURRENT_USER plus scheduled jobs.
Retire old Zero env backups and inherited process configuration after the agreed
one-day verified rollback window; do not rotate/delete Administrator here.

`service/database-connection.cjs` and `runtime-database-environment.cjs` are exact
copies of the API's canonical `scripts/` modules. Keep both copies byte-identical.
Pools use the canonical proxy writer/direct reader resolution and a single
MYSQL_PASSWORD (or MYSQL_RUNTIME_PASSWORD). MYSQL_PASSWORD_PROXY and the obsolete
MYSQL_HOST_READ spelling are not consulted. Explicit class configuration and
restricted base usernames disable legacy cross-class fallback. Existing Zero
production Amazon RDS TLS default is preserved, with the shared CA/port handling.
IAM is not enabled; Zero refuses an unsupported IAM setting instead of silently
attempting password authentication. Private operator/job/retention env is rejected.

The pool guard rejects runtime DDL before it reaches MySQL. The existing Word
Master worker used TRUNCATE and a three-table RENAME; that would break the
restricted account. It now serializes refreshes with a database-scoped named lock
and replaces rankings with DELETE + INSERT SELECT in one transaction/connection.
Readers see the previous complete ranking until commit, failures roll it back,
and lock-release failure destroys the connection. Existing staging tables can
remain; no schema change is needed. Expected cost: live-table row locks while the
rollup transaction runs, instead of rename metadata locks. Ordinary consistent
reads retain MVCC visibility. Verify refresh duration during later live acceptance.

Tests cover routing/TLS, private-config rejection, runtime DDL refusal, atomic
refresh and rollback. This change requires its own commit deployment and restart;
it is not shipped by deploying the API worktree.
