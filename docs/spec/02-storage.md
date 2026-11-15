# Storage on the data volume

This part covers everything chad keeps on its one data volume: the directory tree, the SQLite database and its tables, the files kept outside the database, backup and restore, the commands that look inside the database, pruning, and what chad does when the database cannot be used. The mount point, the image and the environment variables are in 01-image-and-volume.md. What a session and a turn are is in 03-sessions-and-turns.md, the commands and the daemon lock are in 10-cli.md, the git repo is in 09-repo-and-recovery.md, and timers are in 13-timers-and-cron.md. The log's format, the notices, failed turns and what chad does when the volume is full are in 16-failures-logs-status.md, and the tests are in 17-testing.md.

A few terms are used throughout. The daemon is the long-running process started by `chad serve`. The owner is the person whose chat ids are allowed to trigger chad. The agent is the model-driven worker inside a session, built on the clanka library, which runs shell commands as the same operating system user as the daemon. Cluster is effect cluster, the library that runs each session as an entity and stores the requests sent to it in the database. dfx is the Discord library that effect/chat uses for the gateway connection.

## The directory tree

The volume is one directory, mounted at `/data` in the image. Paths in this part are written relative to it. The tree has four kinds of content: the database under `db/`, the git repo under `repo/`, small files that must be readable with no database and no daemon under `secrets/` and `state/`, and working space under `sessions/`, `home/`, `cache/` and `logs/`.

```
db/
  chad.db                      the SQLite database
  chad.db-wal, chad.db-shm     SQLite's write-ahead log and its index
  chad.db.before-migration     the copy taken before a migration, latest only
  (the version of that copy)   a small file beside the copy, see STO-192
repo/                          the git repo and what chad builds from it, see 09-repo-and-recovery.md
  work/                        the git checkout the agent edits, with its .git
  versions/<tree>/             the exported tree that is live
  live                         symlink to the live tree under versions/
  node_modules                 symlink to the image's node_modules
  examples                     symlink to the bundled plugins' source
  package.json                 says "type": "module"
secrets/                       mode 0700, files 0600
  connections.json             chat connections
  secrets.json                 named secrets
  mcp-oauth.json               MCP OAuth tokens and client registrations
  auth/                        model login tokens and clanka's models.dev cache
state/
  safe-mode                    the safe mode flag
  boot-count                   the unclean boot counter
  model                        the model override
  (two more model overrides)   the sub-agent and summarizer models, see 05-model-and-login.md
  timezone                     the owner's timezone
  version                      the chad version that last wrote the volume
  migrating                    present while an upgrade is unfinished
  db-unusable                  present once the unusable database message was sent
  bundled-skills.json          the hash of each bundled skill
  notice-thread                the thread a notice outside a turn is posted in
  daemon.lock                  the daemon lock
run/                           mode 0700
  chad.sock                    the CLI's unix socket, mode 0600
  local.sock                   the local dev adapter's socket, see 17-testing.md
sessions/
  <session-id>/                one session's working directory
    inbox/                     files the owner sent in that session
home/                          $HOME, shared by every session
cache/                         npm and uv caches, anything that can be downloaded again
logs/
  chad.log                     the daemon's log, JSON lines
  chad.log.1 to chad.log.3     the rotated files of that log
```

- **STO-1** The volume holds exactly the top-level directories `db/`, `repo/`, `secrets/`, `state/`, `run/`, `sessions/`, `home/`, `cache/` and `logs/`, with the files shown in the tree above.
- **STO-2** `chad serve` starts on an empty volume and creates the directories it finds missing.
- **STO-3** Every file and directory on the volume is owned by the daemon's user. `secrets/` has mode 0700 and the files in it have mode 0600. The modes are hygiene and no barrier to the agent, which runs as the same user.
- **STO-4** `run/` has mode 0700, set by the daemon on every start, and `run/chad.sock` is set to mode 0600 after the daemon starts listening. The socket itself is described in 10-cli.md.
- **STO-122** `run/local.sock` is the fixed path at which the local dev adapter looks for its chat platform. Nothing in the image listens there. See 17-testing.md.
- **STO-5** The volume has to be a local filesystem, because the database runs in write-ahead log mode. A volume backed by NFS is unsupported. The list of supported volume types and the warning `chad serve` prints are in 01-image-and-volume.md.
- **STO-6** `cache/` holds only what can be downloaded again, with `XDG_CACHE_HOME=/data/cache` and `NPM_CONFIG_CACHE=/data/cache/npm`.
- **STO-7** The daemon writes its log as JSON lines to `logs/chad.log`, in addition to standard output. chad renames `chad.log` to `chad.log.1` when it passes 10 MB and keeps `chad.log.1` to `chad.log.3`, so the logs take at most 40 MB of the volume. Only the daemon writes the file. The line formats, the rotation and flush rules and `chad logs` are in 16-failures-logs-status.md.
- **STO-188** In the image the volume is at `/data`. `CHAD_DATA` moves the daemon's files, the socket and the two links under `repo/`, and nothing else. It does not move `HOME` (STO-22) or the caches (STO-6), which the image fixes under `/data`, so it is not a supported way to move the volume inside the image. See 01-image-and-volume.md.
- **STO-8** Under `repo/`, only `work/` with its `.git` is source of record. chad creates `versions/`, `live`, `node_modules`, `examples` and `package.json` again at boot when they are missing. See 09-repo-and-recovery.md and 07-plugin-loading.md.

## Files outside the database

Anything chad has to read before the database is open, or write with no daemon running, is a plain file. That is what lets first setup save a chat connection on a volume that has never had a daemon, and what lets safe mode and the unclean boot rule work when the database is the thing that broke. Safe mode is chad running with nothing loaded from the repo, and an unclean boot is a start that follows a crash or a kill. Both are specified in 09-repo-and-recovery.md.

- **STO-9** Secrets are files under `secrets/`, outside the repo and outside the database.
- **STO-10** `secrets/connections.json` holds the chat connections, each one a platform's token and its owner ids. The CLI writes it, and first setup can save a connection before any daemon or database exists.
- **STO-137** `secrets/connections.json` is one JSON object with a format number and a list of connections. The format number is what lets an older CLI refuse a newer file.
- **STO-138** Each connection in the list carries its unique name, its kind, its token and its owner ids. A connection of kind `local` has no token. The name is what tells two connections of one platform apart.
- **STO-11** `secrets/auth/` is Effect's file system `KeyValueStore` (a store that writes one file per key), and it is the one store chad gives clanka for model logins. A Codex login writes its token there under the key prefix `codex.auth/`, and that key is the only one chad's rules rest on. clanka's Copilot and xAI logins use the same store, with xAI tokens under `xai.auth/`, and clanka keeps its models.dev cache under `models-dev/` in whatever store it is given. Those keys land in this directory when clanka writes them. chad does not write them itself and does not promise that any path of chad makes clanka write them. The CLI can write the store with no daemon running. See 05-model-and-login.md.
- **STO-139** chad sets mode 0600 on each file under `secrets/` with a chmod after the write, and never changes the process umask. See 01-image-and-volume.md and 05-model-and-login.md.
- **STO-12** `secrets/secrets.json` holds the named secrets managed by `chad secret`, with a kind (`totp` or plain) and a note for each secret. See 15-credentials.md.
- **STO-13** The unclean boot counter, the safe mode flag and the model override are the small files `state/boot-count`, `state/safe-mode` and `state/model`.
- **STO-14** The files in STO-13 are written by writing a temporary file and renaming it over the old one.
- **STO-15** The files in STO-13 are read before SQLite is opened, so safe mode and the rule that three unclean boots start safe mode still work when the database cannot be opened.
- **STO-140** `state/boot-count` holds one line of plain text, the count as one decimal number.
- **STO-141** `state/safe-mode` holds one word, `on` for safe mode turned on by hand or `auto` for safe mode that chad started itself. The file is absent when safe mode is off. See 09-repo-and-recovery.md.
- **STO-142** `state/model` holds one line of plain text, the model value in the form 05-model-and-login.md gives.
- **STO-143** The sub-agent and summarizer model overrides are kept under `state/`, beside `state/model`. See 05-model-and-login.md.
- **STO-16** `state/timezone` holds the owner's timezone set by `chad timezone`. See 10-cli.md.
- **STO-144** `state/timezone` holds one line of plain text, the IANA zone name.
- **STO-17** `chad serve` writes `state/version` after its migrations have run. The file records the chad version that last wrote the volume.
- **STO-145** `state/version` holds one line of plain text, the chad version.
- **STO-121** `state/notice-thread` holds the thread in which chad posts a notice outside a turn, as the one JSON line `{"connection": "<name>", "thread": "<thread>"}`. `connection` is the name of the chat connection that posts, and `thread` is the thread string of STO-153. The connection's name is stored and not the platform, because two connections can share a platform and the file is read when the database cannot be. chad rewrites the file by temporary file and rename whenever that destination changes. Which thread that is is in 09-repo-and-recovery.md, and how a notice is sent is in 16-failures-logs-status.md.
- **STO-18** chad keeps a hash of each bundled skill in `state/bundled-skills.json`. What the hash covers and the file's shape are in 12-skills-and-mcp.md.
- **STO-19** Tokens and client registrations for MCP servers that sign in with OAuth are kept in `secrets/mcp-oauth.json`, a file of its own apart from `secrets/secrets.json`, outside the repo. The file has one entry for each server, keyed by the server's name, and an entry records the URL it was issued for. See 12-skills-and-mcp.md.
- **STO-146** `chad secret` and the `${NAME}` expansion never read or list what `secrets/mcp-oauth.json` holds.
- **STO-20** A session works in `sessions/<session-id>/`, which is the startup directory of that session's clanka Agent.
- **STO-21** Files the owner sends in a session are saved under `inbox/` inside that session's directory. Which attachments are saved and which go to the model as images is in 03-sessions-and-turns.md.
- **STO-22** `$HOME` is `home/` on the volume. It is shared by every session and is the place for work that should outlast one session.
- **STO-23** A direct message session that is never reset keeps its directory under `sessions/` for good.
- **STO-24** A plugin has no directory of its own on the volume.
- **STO-25** chad does not defend the volume against deliberate damage by the agent. Backups are the answer to that, and they cover the git repo because the agent can delete `.git`.

## The daemon lock

Cluster keeps a lock row keyed by runner address in the database. Two daemons with the same address do not exclude each other through it, so chad has a lock of its own.

- **STO-26** The daemon takes a lock at boot, and a second daemon on the same volume exits with an error. The lock is one the operating system drops when the process dies.
- **STO-27** The lock is a SQLite lock on `state/daemon.lock`, opened with `journal_mode=MEMORY` so that no journal file is ever written next to it. The daemon keeps the lock's handle until the process exits. The full mechanism, the timeouts and the CLI's test of the same lock are in 10-cli.md.
- **STO-28** With no daemon running, a CLI command that writes files on the volume holds the lock while it writes. `chad backup` and `chad restore` hold it for the whole copy.

## The SQLite database

All structured state is in one SQLite file, `db/chad.db`. SQLite comes with the Node runtime, so the image carries no native database module. Write-ahead log mode (WAL) is SQLite's mode where writes go to a side file first, which lets a second process read the database while the daemon writes. That is what `chad db query` and `chad backup` rely on next to a running daemon.

- **STO-29** The database driver is the runtime's built-in SQLite, `node:sqlite`, through effect's package `@effect/sql-sqlite-node`.
- **STO-30** The database is the single file `db/chad.db`, with SQLite's `-wal` and `-shm` files next to it.
- **STO-31** WAL stays on.
- **STO-32** Queries are synchronous and block the daemon's event loop, so a slow query stalls the daemon. This cost is accepted.
- **STO-33** The daemon opens one serialized connection with a 5 second busy timeout, which is what `@effect/sql-sqlite-node` does by default.
- **STO-34** The database holds what the table after these rules lists, and nothing else.
- **STO-35** dfx's gateway shard state, which is what lets the Discord connection resume after a restart, is stored in the database. dfx's `ShardStateStore.KVSLive` sits on a `KeyValueStore`, and chad gives it a core table made with `KeyValueStore.layerSql`. See 04-discord.md.
- **STO-147** The dfx shard state table is named `core_discord_shards`, a fixed name that no plugin's table can take. The key-value layer creates the table (STO-40), so no migration of chad's creates it.
- **STO-148** Each chat connection's shard state store is prefixed with the connection's name. dfx's keys are `dfx-shard-state-<id>-<count>` and carry no connection, so two Discord connections would otherwise overwrite each other's resume state.
- **STO-149** With the daemon running, `chad connection remove` has the daemon delete that connection's rows from `core_discord_shards`. With no daemon running the command leaves the rows, because no write made with no daemon needs the database, and the next boot deletes the rows of every connection that is no longer in `secrets/connections.json`. Nothing else deletes rows of that table. See 10-cli.md.
- **STO-36** Cluster's `entityMessagePollInterval` is 1 second, so cluster reads its message table every second. An idle daemon uses 0.2 to 0.3 percent of one core doing so. See 13-timers-and-cron.md for why.
- **STO-150** chad's own tables are created `STRICT`, because a table cannot be made strict afterwards without a rebuild.
- **STO-151** In chad's own tables ids are text, times are integer milliseconds since the epoch, JSON is text, booleans are 0 or 1, and table and column names are snake_case.
- **STO-152** A column beyond the ones this part names is added by the builder, and is written into this part in the same change that carries its migration.
- **STO-153** Every stored thread column holds the thread string `ChatThread.toString(thread)`, which is `discord:<channel id>` on Discord. That covers the thread columns of `sessions` and `timers`. The string is defined in 03-sessions-and-turns.md.

| Table | Created by | Holds | When rows go |
| --- | --- | --- | --- |
| `sessions` | chad's migrations | One row per session | Never. The prune clears two fields (STO-106). |
| `session_messages` | chad's migrations | Each session's history | Swapped on a compaction, deleted by the prune |
| `turns` | chad's migrations | One row per turn | Never |
| `steers` | chad's migrations | One row per owner message that joined a running turn | Never |
| `timers` | chad's migrations | One row per plugin timer | See 13-timers-and-cron.md, and `chad plugin purge` |
| `notices` | chad's migrations | One row per notice key, with the time its notice was last sent | Not when the condition clears (STO-130) |
| `session_updates` | chad's migrations | Per session, what chad posted that the model has not been told yet | In the transaction that writes the history holding them (STO-132), and by the prune (STO-171) |
| `chad_meta` | The shard count check (STO-161) | The shard count the database was made with | Never |
| `cluster_messages`, `cluster_replies`, `cluster_runners`, `cluster_locks`, `cluster_migrations` | effect cluster, under its default prefix `cluster` | Stored requests and replies for the `Session` entity, the `Timer` entity and the prune, plus runner and lock rows | Requests by `MessageRetention` (STO-110, STO-112 and STO-113) |
| `plugin_kv_<name>`, one table per plugin | `KeyValueStore.layerSql` | That plugin's keys | By the plugin, and `chad plugin purge` |
| `core_discord_shards` | `KeyValueStore.layerSql` | The gateway's resume state, for each connection | By `chad connection remove`, or by the next boot when no daemon was running (STO-149) |
| `effect_sql_migrations` | effect's `Migrator` | Which of chad's migrations have run | Never |

## Migrations and the order of a boot

effect's `Migrator` records applied migrations in a table and runs the pending ones in a transaction. It skips any migration whose id is not above the latest one recorded and does not object to a database that is ahead of the code, so the refusal in STO-41 is a check chad writes itself.

- **STO-37** chad's own tables are created and changed by effect's `Migrator`, with the migrations compiled into the image.
- **STO-154** The migrations table is `effect_sql_migrations`, which is `Migrator`'s default name.
- **STO-38** Migrations run at boot, before any session starts.
- **STO-39** Migrations only go forward. There is no down migration.
- **STO-40** Cluster and the key-value layer create their own tables. chad writes no migration for them.
- **STO-187** Every build slice that changes the schema appends a new migration, from the first slice on, and a migration that a delivered slice added is never edited. The migrations of the delivered slices are the fixtures for the tests that migrate an older database (see 17-testing.md).
- **STO-41** chad refuses to start sessions on a database that holds a migration the image does not know. The check is chad's own code.
- **STO-42** A boot touches storage in this order: take the lock on `state/daemon.lock`, check `state/version` (STO-48), raise `state/boot-count`, start listening on the socket, check the shard count row, copy the database when STO-44 asks for it, with the copy's version beside it (STO-192), and write `state/migrating`, run the migrations, write `state/version` and remove `state/migrating`, start sessions.
- **STO-155** The full boot order, with the start-up check, the boot counter and what puts the counter back after a refused boot, is the numbered list in 01-image-and-volume.md.
- **STO-43** The daemon listens on its socket before it opens, copies or migrates the database, so `chad status` and `chad health` answer while a long copy runs.
- **STO-44** The first boot of a new image copies the database to `db/chad.db.before-migration` before anything migrates. A boot is such a boot when `db/chad.db` exists and `state/version` is older than the running version or is absent.
- **STO-156** The copy is written under a temporary name and renamed to `db/chad.db.before-migration` when it is complete, so a kill during the copy cannot leave a truncated file under the fixed name.
- **STO-157** The boot writes `state/migrating` once the copy is in place, and removes it when it writes `state/version`.
- **STO-158** A boot that finds `state/migrating` skips the copy. A migration that crashes is retried by the restart policy with `state/version` still old, and a second copy would replace the good one with a half-migrated database that the older image refuses.
- **STO-159** When the database cannot be opened, chad skips the copy, leaves the previous copy in place and goes to the state of STO-117.
- **STO-190** A boot that migrated the database writes the event `database.migrated`, which carries both versions and the path of the copy. The table of events is in 16-failures-logs-status.md.
- **STO-45** chad keeps only the most recent such copy. It is replaced at the next migration.
- **STO-46** The copy is made with `node:sqlite`'s stepped online backup, so the daemon keeps answering pings while it runs.
- **STO-47** The copy is for rolling back on the volume it sits on. It is not part of `chad backup`.
- **STO-48** An older `chad serve` that finds a newer version in `state/version` exits 1 with a message that names the copy, `db/chad.db.before-migration`. When the version written beside the copy (STO-192) is the running chad's own, the message gives the steps of STO-193. When it is another version, the message gives no steps and names the version the copy belongs to. The check runs straight after the lock is taken and before the boot counter goes up, the socket, the shard count check and the database, so the refused boot opens no database and writes nothing on the volume but its lines in `logs/chad.log`, which it writes because it holds the lock (see 16-failures-logs-status.md). It runs after the lock so that a `chad restore` that finishes between an unlocked read and the lock cannot slip a newer volume past it, and the lock itself writes no data. That boot does not count as unclean. This check is separate from the unusable database state of STO-117, and both stand.
- **STO-192** A boot that copies the database (STO-44) writes the version the copy was taken from in a file beside the copy, under `db/`. That version is the one `state/version` held before the migration, and it is what lets an older `chad serve` tell whether the copy is its own. The file is replaced together with the copy.
- **STO-193** The steps in the exit message of STO-48 are to put `db/chad.db.before-migration` back as `db/chad.db`, to delete `db/chad.db-wal` and `db/chad.db-shm`, and to write the older version back into `state/version`. The two deletions are among the steps because a restored database that is opened under the newer database's write-ahead log is corrupted. The version is among them because restoring the copy alone leaves the newer `state/version` in place, and the older image then refuses again.
- **STO-49** With no daemon running, a CLI that is older than the version in `state/version` refuses to write to the volume. See 10-cli.md.

## The shard count row

Cluster stores each message under a shard number. If the number of shards changes, the runner never polls the old shards again. Nothing errors and the stored messages are never delivered. Two timers stored at 300 shards were not delivered in 60 seconds after a restart at 1 shard, with nothing logged. The shards of this section are cluster's. They are not the Discord gateway's shards, whose count is dfx's own and is part of the key in STO-148.

- **STO-50** `chad serve` runs cluster's `SingleRunner` with `shardsPerGroup: 1` from the first release. See 03-sessions-and-turns.md.
- **STO-51** The shard count the database was made with is kept in the database, in a row of its own, written the first time the database is opened.
- **STO-160** The shard count row is in the table `chad_meta`, which has the columns `key` and `value`.
- **STO-161** The shard count check creates `chad_meta` itself, with `CREATE TABLE IF NOT EXISTS`, because the check runs before the migrations (STO-54). No migration creates or changes `chad_meta`.
- **STO-52** The count is kept in the database and not under `state/`, so that a database restored without `state/` still carries the guard.
- **STO-53** A daemon that finds a different shard count in that row refuses to start, exits 1 and names both numbers.
- **STO-54** The shard count check runs before the database copy and before the migrations, so a refused boot copies nothing, migrates nothing and changes nothing in the database. The boot holds the lock by then, so its `boot.refused` line goes to the log file as well as to standard output (see 16-failures-logs-status.md).
- **STO-55** A boot refused by the shard count check does not count as unclean.

The message, as the prototype printed it for a database made at 300 shards:

```
chad serve: this database was made with 300 shards and this chad uses 1. Messages stored under the old count would never be delivered, so chad will not start.
```

The table as the check creates it. The key `shards` and the row are the prototype's.

```sql
CREATE TABLE IF NOT EXISTS chad_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- the row as the prototype patch on TIM-553 wrote it, evidence and not a decision
INSERT INTO chad_meta VALUES ('shards', '1');
```

## Per-plugin key-value tables

A plugin's only storage is `PluginContext.store`, an Effect `KeyValueStore` that only that plugin can see (see 06-plugin-api.md). Each plugin has a table of its own because a store built as a prefix over one shared table lists every plugin's keys on each `keys`, `size` or `isEmpty` call and filters them in JavaScript. That listing took 1 ms at 1,000 keys, 10 ms at 10,000 and 120 ms at 100,000, and the call is synchronous, so it stalls the daemon. The cron plugin keeps one entry per job in its store (13-timers-and-cron.md), and the asphodel plugin keeps three kinds of key (18-asphodel-plugin.md).

- **STO-56** Plugins get key-value storage only in v1. A plugin has no `SqlClient`.
- **STO-57** Each plugin has its own table, built with `KeyValueStore.layerSql({ table })`.
- **STO-162** A plugin's table is named `plugin_kv_<name>`, with the plugin's name as written, and the identifier is always quoted. A hyphen in a name therefore needs no mapping, and two plugin names can never land on one table. Which names a plugin may have, and where chad refuses a name that breaks the rule, is in 07-plugin-loading.md.
- **STO-58** A plugin's table belongs to the plugin's name. A bundled plugin and a repo plugin with the same name share one table, and renaming a repo plugin does not move its data.
- **STO-59** The store has no expiry. A plugin prunes its own keys.
- **STO-60** A plugin that is removed from the repo or turned off keeps its table and its timers.
- **STO-61** `chad plugin purge <name>` drops the plugin's key-value table and its timers. It refuses a repo plugin that is still in the applied repo, which includes one that is turned off. It refuses a bundled plugin that is on and allows one that is turned off, because a bundled plugin cannot be deleted from the repo and off is its nearest state to deleted. The agent may run it. The purge rule is in 11-settings.md and the command is in 10-cli.md.

## The session tables

A session's row and its history are what let a session be restored after a restart or after it was unloaded for being idle. The rules for when they are written are in 03-sessions-and-turns.md. This section fixes what is stored.

- **STO-62** `sessions` has one row per session: its id, its chat thread, its kind, its created and ended times, clanka's environment, the system prompt last sent, the prompt chunk text last seen, the generation, a fingerprint, and a mark of the last message chad handled in the thread. The fingerprint is a hash of the system prompt as chad would render it, with the plugin chunks left out (see 08-apply-and-swap.md). The mark is what the catch-up after a restart reads forward from (see 03-sessions-and-turns.md).
- **STO-163** The `kind` of a `sessions` row is the plugin API's value for the session's thread, one of `direct`, `channel` or `thread` (see 06-plugin-api.md), so the row and what a plugin sees agree. Which session gets which value is in 03-sessions-and-turns.md.
- **STO-63** A session id is a fresh id for each reset, so one chat thread has one `sessions` row per reset.
- **STO-64** A `sessions` row is never deleted.
- **STO-65** `session_messages` is append-only. A row is written on every `HistoryAppended` event from clanka, and the session's rows are swapped in one transaction on `HistoryReplaced`, which is clanka's compaction.
- **STO-66** The history of a session that was reset stays in the database for 30 days and is then pruned. chad never loads it again.
- **STO-67** An image the owner sends is stored inside the history as base64, so a 10 MB image is a row of about 13 MB until its session is pruned or compacted. It is written once, and again if a compaction keeps it. This is accepted.
- **STO-68** History rows are stored as written, with no masking of secret values.
- **STO-123** At the end of every turn, however it ends, chad makes the stored history of the session equal to the Agent's history, before it records the turn's end. That can write rows, or swap the session's rows, that no event delivered. See 16-failures-logs-status.md.

The tables as the prototype created them. The prototype kept one `sessions` row per thread and had no reset history, so its primary key and its missing columns do not match STO-62 and STO-63.

```sql
-- from chad/host.ts in the TIM-543 prototype, evidence and not a decision
CREATE TABLE IF NOT EXISTS sessions (thread TEXT PRIMARY KEY, id TEXT NOT NULL, environment TEXT, system TEXT, chunks TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS session_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, message TEXT NOT NULL);
```

## The turns table

A turn is one run of the agent in a session, started by an owner message or by a plugin. Each turn is asked for by a stored cluster request, and that request has a key. chad keeps its own record of every turn, because cluster forgets a request once `MessageRetention` has pruned it and then delivers a replayed chat event a second time. How turns are resumed and when chad gives up on one is in 03-sessions-and-turns.md.

- **STO-69** `turns` has one row per turn, keyed by the key of the request that asked for it. The key column is `request_key`, because `chad_meta` and `notices` each have a `key` column that means something else and the model writes its queries from the column list.
- **STO-70** A row holds the turn's id and session, its origin (the owner's message, or a plugin and its label), its start and end times, its outcome and the reason of a failed turn, the id of its status message, the model, and its token usage. The columns are the ones in the schema below. `ended_at` and `outcome` are null while the turn runs.
- **STO-71** A row holds two counts: `starts`, the number of times chad started the turn, and `graceful_cuts`, the number of those starts that a graceful stop cut. chad increments `starts` before the model runs, and saves a cut to the row before the process exits.
- **STO-72** A row holds the first attempt's turn id and origin. A turn resumed after a restart reuses them, and that is where a resumed turn's hooks get them.
- **STO-73** The `turns` row is the record of which requests have run. When a request arrives whose row says the turn has ended, chad does not start a second turn.
- **STO-74** `turns` rows are never deleted. That keeps the record in STO-73 alive past anything that can be replayed, and lets usage be added up later.
- **STO-75** The id of a running turn's status message lives in its `turns` row, so a resumed turn edits the same message and a turn chad gives up on has its message removed. See 04-discord.md.
- **STO-76** `turns` rows, including the reason of a failed turn in `failure` and `failure_detail`, are stored as written, with no masking of secret values.
- **STO-124** `started_at` and `ended_at` are integer milliseconds since the epoch.
- **STO-125** `turns` has an index on `started_at` and an index on `(session_id, started_at)`.
- **STO-126** `turns` has no cost column. A row keeps the token counts and the model value. What the usage columns count and when chad writes them is in 16-failures-logs-status.md.
- **STO-164** `starts`, `graceful_cuts` and the five token columns are `INTEGER NOT NULL DEFAULT 0`, so sums need no null handling.
- **STO-165** `model` holds the model value that the turn's Agent was built with, in the full `<provider>/<model>[/<effort>]` form of 05-model-and-login.md. The effort is part of the stored value when one was set, because the column records what ran.
- **STO-127** After a restart, a row that is still running and has a later row in the same session is closed as failed with the reason `Internal` and is not resumed. See 16-failures-logs-status.md.

| Column | Holds |
| --- | --- |
| `request_key` | Key of the stored request that asked for the turn. Primary key. |
| `turn_id` | The first attempt's turn id |
| `session_id` | The session the turn ran in |
| `origin` | `message` for an owner's message, `plugin` for a turn a plugin started |
| `origin_plugin` | The plugin that started the turn |
| `origin_label` | The label the plugin gave the turn |
| `started_at` | When the turn started |
| `ended_at` | When the turn ended. Null while it runs. |
| `outcome` | Null while the turn runs, then `answered`, `failed` or `stopped` |
| `failure` | The tag of a failed turn's reason. The set of tags is in 16-failures-logs-status.md. |
| `failure_detail` | That reason as JSON |
| `status_message_id` | The Discord message edited while the turn runs |
| `starts` | How many times chad started the turn |
| `graceful_cuts` | How many of those starts a graceful stop cut |
| `model` | The model value the Agent was built with on the last attempt, effort included. A sub-agent on another model is inside the same totals. |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `context_tokens` | The turn's token usage, see 16-failures-logs-status.md |

The schema. The column names, the primary key, the integer times, the defaults of the counts and the token columns, `STRICT` and the two indexes are decided. Which of the other columns may be null and the names of the indexes are the builder's.

```sql
CREATE TABLE turns (
  request_key TEXT PRIMARY KEY,  -- the key of the request that asked for the turn
  turn_id TEXT,
  session_id TEXT,
  origin TEXT,                 -- 'message' or 'plugin'
  origin_plugin TEXT,
  origin_label TEXT,
  started_at INTEGER,          -- milliseconds since the epoch
  ended_at INTEGER,            -- milliseconds since the epoch, null while the turn runs
  outcome TEXT,                -- null while the turn runs, then 'answered', 'failed' or 'stopped'
  failure TEXT,                -- the reason tag of a failed turn
  failure_detail TEXT,         -- the reason as JSON
  status_message_id TEXT,
  starts INTEGER NOT NULL DEFAULT 0,
  graceful_cuts INTEGER NOT NULL DEFAULT 0,
  model TEXT,                  -- '<provider>/<model>[/<effort>]'
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX turns_started_at ON turns (started_at);
CREATE INDEX turns_session_started_at ON turns (session_id, started_at);
```

The prototype kept a `state` column in this table, with the values `new`, `running`, `steered` and `ended`. `steered` marked a message that had joined a running turn, so that a redelivery after a crash did not put it into the history twice. The decided columns have no `state`. That mark is kept in a table of its own, `steers`, so `turns` stays one row per turn and the status and `diagnose` queries need no filter.

- **STO-166** chad records each owner message that joined a running turn as one row of the table `steers`, keyed by that message's request key in `request_key` and naming the turn it joined. What chad does with the row when a message is delivered again is in 03-sessions-and-turns.md.
- **STO-167** chad recognises the `HistoryAppended` batch that carries steering messages into the history: every message in it is a user message with string content, and the contents equal, in order, those of chad's oldest outstanding steers. chad writes the `steers` rows of those messages, and the event `turn.steered` for each, in the transaction that stores that batch. `steer` returning is not the trigger, because the batch can be stored before chad sees `steer` return (STO-189), and two separate writes with a kill between them would make the redelivery drop a message the history never got. The process test, with a kill before the commit and a kill after it, is in 03-sessions-and-turns.md.
- **STO-189** clanka takes every waiting steering message in one step, resumes each `steer` call, and appends the messages as one `HistoryAppended` batch of user messages with string content, in call order. Nothing orders a resumed `steer` against chad's consumer of the turn's stream. This was read in clanka 0.28.0, at `src/Agent.ts:1144-1157` and `1529-1535`, and its own test sends two steers and expects one batch that holds both in order.
- **STO-168** `steers` rows are never deleted, for the reason STO-74 gives for `turns` rows.

```sql
CREATE TABLE steers (
  request_key TEXT PRIMARY KEY,  -- the key of the request that carried the steering message
  turn_id TEXT                   -- the turn the message joined, as in turns.turn_id
) STRICT;
```

## The timers table

A plugin timer is a scheduled run that a plugin asked the core to hold, through `Turns.schedule`. Cluster stores the wake-up message, and chad's own table stores what the timer is. The behaviour is in 13-timers-and-cron.md.

- **STO-77** `timers` has one row per plugin timer, with the columns `plugin`, `name`, `cron`, `timezone`, `thread`, `prompt`, `label`, `mention` and `next_run`. `timezone`, `label` and `mention` are text, `next_run` is integer milliseconds since the epoch, and there is no fixed-interval column.
- **STO-78** The `timers` row decides whether a timer runs. The timer's handler checks the row before it starts the turn and again before it saves the next run, and `Turns.scheduled()` reads the table. Cluster's stored message is only the wake-up.

The table as the prototype created it. The prototype ran one-shot times and fixed intervals only, so it has an `every_ms` column, which the decided table drops, and lacks the timezone, the label and the mention.

```sql
-- from chad/host.ts in the TIM-543 prototype, evidence and not a decision
CREATE TABLE IF NOT EXISTS timers (plugin TEXT NOT NULL, name TEXT NOT NULL, thread TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT, every_ms INTEGER, next_run INTEGER NOT NULL, PRIMARY KEY (plugin, name));
```

## The notice table and the lines waiting to be told

A notice is a message chad posts on its own account outside a turn, for example that the volume is short of space. Each notice about a condition has a key, such as `disk-low`, and chad has to remember across restarts which conditions it has already announced. chad also has to remember, for each session, what it posted in the thread that the model has not been told about, because those posts are not in the session's history. Both records are tables in the database. Their behaviour is in 16-failures-logs-status.md, and their schema is below.

- **STO-128** The database holds one table of notice keys, `notices`, with one row per key and the key as its primary key.
- **STO-169** A `notices` row holds whether the condition holds now, the time chad recorded it as holding, the time the key's notice was last sent, the notice's text, and whether the last post was delivered. Both times are integer milliseconds since the epoch. The recorded time is kept apart from the send time, because a condition can begin with no notice sent (see 16-failures-logs-status.md). "Problems" in `chad status` reads a row only for a table key, which is a key that records something only the row remembers, such as a failed prune or a notice that was not delivered. For a live key, which is one the running daemon can answer from memory or from files, "Problems" never reads the row, and the row only decides whether a notice is sent. The class of each key is in 16-failures-logs-status.md.
- **STO-129** The notice table is in the database so that a restart does not send again a notice whose condition still holds. The keys, the check that clears each one and the rule for sending are in 16-failures-logs-status.md.
- **STO-130** A row of the notice table is kept when its condition clears, with the time its notice was last sent.
- **STO-131** The lines waiting to be told to the model are kept in the table `session_updates`, for each session, so they survive the session being unloaded for being idle. How the next turn tells the model is in 16-failures-logs-status.md.
- **STO-170** A `session_updates` row holds the session id, a sequence number and one line. A turn's line holds the turn id, the outcome and the reason tag, and no rendered text, because the update message prints the latest turn in full and older turns as a count for each reason. A notice's line holds the notice key and the text.
- **STO-132** A session's `session_updates` rows are deleted in the same transaction that writes the history that holds them, so a crash between the two can neither lose an update nor tell it twice.
- **STO-171** The prune deletes a session's `session_updates` rows together with the session's history (STO-105).

The two tables. The table names, the primary keys and what a row holds are decided. Which columns may be null is the builder's.

```sql
CREATE TABLE notices (
  key TEXT PRIMARY KEY,        -- the notice key, for example 'disk-low'
  last_sent_at INTEGER,        -- milliseconds since the epoch
  holds INTEGER,               -- 1 while the condition holds, 0 once it cleared
  recorded_at INTEGER,         -- when the row was written as holding, milliseconds since the epoch
  text TEXT,                   -- the notice's text, which "Problems" prints for a table key
  delivered INTEGER            -- 1 when the last post reached the thread, else 0
) STRICT;
CREATE TABLE session_updates (
  session_id TEXT,
  seq INTEGER,                 -- the sequence number within the session
  turn_id TEXT,                -- a turn's line
  outcome TEXT,                -- a turn's line
  failure TEXT,                -- a turn's line, the reason tag
  notice_key TEXT,             -- a notice's line
  text TEXT,                   -- a notice's line
  PRIMARY KEY (session_id, seq)
) STRICT;
```

## Looking inside the database

The owner and the agent read the database through the CLI. A second process can open the database read-only while the daemon is writing in WAL mode. It reads rows and is refused a write.

```
chad db query "<sql>" [--limit <n>] [--json]
chad db check
```

- **STO-79** `chad db query "<sql>"` runs the statement on a read-only connection. A statement that writes is refused.
- **STO-80** `chad db query` and `chad db check` open their own read-only connection in the CLI's process and take no place in the daemon's queue. They work with a daemon running and with none.
- **STO-81** `chad db query` prints at most 200 rows unless `--limit` is given, and takes `--json`.
- **STO-172** Without `--json`, `chad db query` prints a header line and then one line for each row, with the values separated by tabs.
- **STO-173** In that output a tab, a newline and a backslash inside a value are escaped, so a row is always one line. `session_messages` holds text of many lines and would otherwise break the rows.
- **STO-82** `chad db check` runs an integrity check on request. Nothing checks integrity at boot.
- **STO-174** `chad db check` prints SQLite's own lines.
- **STO-175** `chad db query` exits 1 on a failed statement, and `chad db check` exits 1 on a failed check.
- **STO-83** The agent may run `chad db query` and `chad db check`. `chad db query` is the way to read the database that the bundled `self-edit` skill teaches. See 14-self-edit-skill.md.
- **STO-133** There is no `chad turns` command. `chad db query` reads the `turns` table with a daemon running or with none, and the bundled `diagnose` skill carries the queries. See 16-failures-logs-status.md.
- **STO-84** The `sqlite3` binary ships in the image for the owner's repairs. chad does not stop the agent from writing to the database through it.

## Backup and restore

A backup is one tar file made by the CLI. chad makes no backups by itself, so something outside chad has to run the command and move the tar off the volume. The Kubernetes and Compose examples that do so are in 01-image-and-volume.md.

```
chad backup <path> [--no-home] [--sessions]
chad backup -                    the tar goes to standard output
chad restore <tar>
```

- **STO-85** `chad backup` writes one tar, to a path or to standard output.
- **STO-176** `chad backup` with no path is a usage error and exits 2, so a tar full of tokens never lands on a terminal by accident.
- **STO-177** `chad backup -` exits 2 when standard output is a terminal.
- **STO-86** The tar holds an online copy of the database, `repo/work/` with its `.git` and nothing else from `repo/`, `secrets/`, `state/`, and `home/` without `home/.cache`. Drafts in `repo/work/` that were never applied are in the tar.
- **STO-87** `--no-home` leaves `home/` out of the tar.
- **STO-88** `sessions/` goes into the tar only when `--sessions` is given.
- **STO-89** The tar carries a manifest, `manifest.json` at the root of the tar, with the chad version and a format number.
- **STO-178** `manifest.json` is the first entry in the tar, so `chad restore` can read it before anything else when the tar arrives on a pipe.
- **STO-90** The tar never holds `cache/`, `logs/` or the copy of the database taken before a migration.
- **STO-91** The tar holds tokens, so it is a secret.
- **STO-92** `chad backup` copies the database in the CLI's own process, on a read-only connection, with SQLite's online backup.
- **STO-93** With a daemon running, `chad backup` first takes a place in the daemon's queue and holds it until the tar is written. The queue is the one that orders everything that changes what is loaded (see 10-cli.md).
- **STO-94** `chad backup` works with no daemon running.
- **STO-95** The agent may run `chad backup <path>`. `chad backup` to standard output is an owner command and is refused with exit code 3 when `CHAD_SESSION` is set. See 10-cli.md.
- **STO-191** A `chad backup` that fails is recorded as the event `backup.failed`. The table of events is in 16-failures-logs-status.md.
- **STO-96** chad schedules no backups. A Kubernetes CronJob or a volume snapshot does that, and the copy has to leave the volume.
- **STO-97** Directories the owner mounts next to the volume, such as a vault, are not chad's to back up. The asphodel daemon's volume is not in `chad backup` either.
- **STO-98** Browser state that a sign-in tool keeps under `home/` is in `chad backup`. A Chromium sidecar's profile is not, and neither is anything a tool keeps under the cache directory. See 15-credentials.md.
- **STO-99** `chad restore <tar>` works only on an empty volume with no daemon running. It refuses while the daemon's lock is held, so the owner restores from a one-off container with the daemon stopped.
- **STO-179** For `chad restore` a volume is empty when it holds nothing an owner made, which means no file under `secrets/` and no row in `sessions`. A `chad serve` that booted once leaves `db/chad.db` and `repo/work/` with its first commit, so those two alone do not make a volume count as used.
- **STO-180** A volume whose database cannot be read is not empty.
- **STO-181** `chad restore` replaces `db/`, `repo/` and `state/` on the volume.
- **STO-182** `chad restore` refuses a tar whose manifest names a newer chad, before it writes anything.
- **STO-100** `chad restore` is an owner command and is refused with exit code 3 when `CHAD_SESSION` is set.
- **STO-101** The first boot after a restore rebuilds `repo/versions/`, `repo/live` and the `repo/node_modules` link from the head of the `applied` branch.
- **STO-102** A restore into a newer image migrates the database forward on first boot.
- **STO-103** A restore into an older image is refused by `chad restore` itself, from the version in the manifest (STO-182). The rule in STO-41 still refuses such a database at boot when it reaches the volume another way.

## Pruning and retention

The prune is the only job in chad that deletes old session data. It runs on `ClusterCron`, effect cluster's fixed-schedule job, which stores each run as a message with a delivery time. Besides the prune, cluster's `MessageRetention` deletes completed requests, and each plugin prunes its own keys (STO-59). Everything else is kept.

- **STO-104** The prune is a `ClusterCron` at 04:00 in the owner's timezone, in UTC until a timezone is set, in `ClusterCron`'s default mode.
- **STO-105** For each session that was reset more than 30 days ago, the prune deletes the session's working directory under `sessions/` first and its history rows last.
- **STO-183** The prune deletes each session's rows in a small transaction of that session's own, the same transaction that clears its `sessions` row (STO-106). SQLite has one writer, and one large delete at 04:00 would block every session's history writes for as long as it ran.
- **STO-184** The prune has no wait of its own when the daemon stops. The exit cuts it, and no measurement of the prune gates the stop sequence. The stop order is in 01-image-and-volume.md.
- **STO-185** The next run finishes a prune that an exit cut. A session whose directory is gone and whose `sessions` row is not yet cleared is still selected.
- **STO-106** The prune leaves the `sessions` row in place, with its prompt and environment cleared.
- **STO-107** The prune never deletes `turns` rows.
- **STO-108** The database file is never vacuumed.
- **STO-109** A restart does not run the prune. A run that came due while chad was down fires when chad returns. A run more than a day overdue is skipped and the next one is scheduled from the current time. A run that fails is logged and the next run is still scheduled.
- **STO-110** Each run of the prune leaves one request and one reply in cluster's tables for good, 365 of each a year, because `MessageRetention` is not used on `ClusterCron` entities.
- **STO-111** A change of the owner's timezone reaches the prune at the next restart, because a `ClusterCron` fixes its schedule when it is built.
- **STO-112** Stored requests of the `Session` entity are kept for one day by `MessageRetention`.
- **STO-113** Completed requests of the `Timer` entity are pruned with `MessageRetention`. A run scheduled for a later time is not completed, so it stays stored until it is due.

## The free space check

- **STO-114** The free space check is a plain timer in the daemon. It runs at boot, then hourly, and at once when a write fails with SQLite's full error. It is kept off `ClusterCron` because an hourly job there would leave 8,760 requests and replies a year.
- **STO-115** The check has two thresholds. Less than 1 GB free is the condition of the notice key `disk-low`, and less than 100 MB free is the condition of the notice key `disk-critical`. Each key clears at a higher level than the one it begins at, so free space that sits at a threshold does not send a notice at every check. The clearing levels, when each notice is sent, when it may be sent again and its wording are in 16-failures-logs-status.md.
- **STO-116** The check reads free space with `node:fs` `statfs`, because Effect's `FileSystem` has no call that reports it. Free space is `bavail * bsize`, the bytes the daemon's user can use.
- **STO-134** chad enters no special mode when free space is low or gone. What chad does when a write fails because the volume is full is in 16-failures-logs-status.md.
- **STO-135** The hourly interval of the free space check, the prune's time of day (STO-104) and the 30 days of STO-105 are defaults of the `Timings` service, which the shipped binary cannot change. See 17-testing.md.

## An unusable database

A database is unusable when it cannot be opened or cannot be migrated. Safe mode cannot fix a database, so chad neither enters it nor counts the boot towards it. The owner still needs to be told, and the chat connection does not depend on the database, so chad stays reachable.

- **STO-117** When the database cannot be opened or migrated, for any reason other than the newer `state/version` of STO-48, chad stays up without sessions. A corrupt file and a database that holds a migration the image does not know (STO-41) are both this case.
- **STO-118** In that state chad connects to Discord from `secrets/connections.json` and answers any owner message with the message below.
- **STO-136** At a boot that ends in that state chad sends the same message without waiting for an owner message, to the thread recorded in `state/notice-thread` (STO-121), unless `state/db-unusable` exists. What chad does when no thread is recorded, when the post fails or when `state/db-unusable` cannot be written is in 16-failures-logs-status.md.
- **STO-186** chad writes `state/db-unusable` when it sends the message of STO-136, and a boot that opens and migrates the database removes the file. A crash loop on an unusable database therefore posts the message once and not at every restart.
- **STO-119** In that state `chad status` and `/status` show the error under "Problems", and `/status` renders with no database. Its key, `database-unusable`, is a live key (STO-169), so "Problems" shows it without reading the `notices` table. See 16-failures-logs-status.md.
- **STO-120** A boot that could not open the database does not count as unclean. The same holds for a boot that was refused the lock, found a newer `state/version`, or was refused by the shard count check.

The message of STO-118 and STO-136:

```
chad's database can't be used: <error>. Sessions are off until it is fixed. `chad status` has the detail.
```

## Gaps

- **STO-G10** [builder] The column names and types of `sessions`, `session_messages` and `timers` beyond the fields the tickets name. TIM-536 ("Not settled here") and the TIM-543 prototype.
- **STO-G15** [builder] How long `MessageRetention` keeps completed requests of the `Timer` entity. TIM-543 only says they can be pruned.
- **STO-G26** [builder] When `sessions/<session-id>/` is created. TIM-536 item 10.
- **STO-G27** [builder] Whether the 1 GB and 100 MB of STO-115 are decimal or binary units. TIM-557 item 31.
- **STO-G29** [builder] Whether a `chad backup` that fails with no daemon running leaves a `backup.failed` line (STO-191), and how a running daemon learns of the failure. The copy is made in the CLI's own process (STO-92) and only the daemon writes `logs/chad.log` (STO-7), so as the rules stand a backup that fails with no daemon leaves no line. TIM-559 round 2 R4 names the event and not its writer, and TIM-557 item 10 came closest.
- **STO-G30** [builder] The name of the file that holds the version of the copy (STO-192), and what a boot writes in it when it copies the database of a volume that has no `state/version`. An older image reads the file, so the name does not change once a release has shipped it. TIM-559 round 3 on IMG-G19 and STO-G28 says only that the version is written beside the copy.
- **STO-G31** [builder] The words of the exit message of STO-48 in its two forms, and what it says when the volume holds no copy or no version beside the copy. TIM-559 round 3 on IMG-G19 and STO-G28 gives what the message carries and not its text.
- **STO-G32** [builder] Which of chad's own tables the `harness` slice creates, and where the Agent of its one turn starts. `harness` delivers the thinnest storage open and migrate and one turn, and STO-37, STO-150, STO-151 and STO-187 are tested there, but the session tables arrive in `turns` (STO-62 to STO-65). As tagged, `harness` has no table for a migration to create, or for `STRICT` and the column conventions to be checked on. Recommended: the first migration creates a `sessions` table with only the id, the thread and the created time, a fresh id is made on a thread's first message and the Agent starts in `sessions/<session-id>/`, the one turn's history stays in memory, and `turns` adds the other columns and tables in a new migration. TIM-559 round 1 Q9 item 8, and TIM-559 cold read, harness reader.
- **STO-G33** [builder] At which step of the boot `chad serve` creates the directories it finds missing (STO-2). The boot order of STO-42 and the numbered list in 01-image-and-volume.md give it no place. The lock file is under `state/`, and a boot that is refused up to the check for a newer `state/version` has to write nothing but its log lines (STO-48). Recommended: `state/` is created when the lock is taken, and the other directories once the check of STO-48 has passed. TIM-542 item 32, and TIM-559 cold read, harness reader.
- **STO-G34** [builder] The form of the prefix that STO-148 puts before dfx's key. The next boot deletes rows by connection (STO-149), so without a separator the rows of a connection named `discord` cannot be told from those of one named `discord2`. Recommended: the key is `<name>/dfx-shard-state-<id>-<count>`. Which characters a connection's name may hold (STO-138) is a gap of 10-cli.md, whose recommendation keeps `/` out of a name. TIM-559 ruling on STO-G8, and TIM-559 cold read, wire and cli readers.
- **STO-G35** [builder] How two chad versions are ordered, and what a missing or unreadable `state/version` means for a write made with no daemon. STO-44, STO-48, STO-49 and STO-182 compare versions as older and newer, and STO-145 says only that the file holds the chad version. Recommended: the version is the package version, two versions are ordered by semver precedence, a CLI with no daemon does not refuse when the file is absent, and it exits 1 when the file cannot be read. TIM-541 item 14 and TIM-542 item 5, and TIM-559 cold read, cli reader.
- **STO-G36** [builder] What the refusal behind the format number of STO-137 covers. It is not said whether an older CLI that finds a newer format number refuses reads such as `chad connection list` and `chad status` as well as writes, or what an older daemon does at boot. `state/version` does not catch the case, because a write made with no daemon never touches that file. Recommended: the CLI refuses reads and writes with exit 1, and the daemon refuses the boot with exit 1 and a `boot.refused` line. TIM-559 ruling on STO-G17, and TIM-559 cold read, cli reader.
- **STO-G37** [builder] The details of what `chad db query` prints, which the model and the `diagnose` skill read. They are the escapes of STO-173, how NULL and a blob print, the shape of `--json`, and whether a cut at the row limit of STO-81 is announced. Recommended: `\t`, `\n` and `\\` for a tab, a newline and a backslash, NULL as an empty value, a blob as hexadecimal, `--json` as one array of objects keyed by column name, and one line on standard error when rows were cut. TIM-559 ruling on STO-G24, and TIM-559 cold read, cli reader.
- **STO-G38** [builder] The name a file gets under `inbox/` (STO-21). Discord names every pasted image `image.png`, so two files of one session can share a name, and a name can hold `/` or `..`. Recommended: `inbox/<message id>-<name>`, with the name reduced to characters that are safe in a path. TIM-536 item 10 and TIM-532 item 15, and TIM-559 cold read, turns reader.
- **STO-G39** [builder] The form of a session id. No rule gives it, and the id is the name of the directory under `sessions/` (STO-20), the value of `CHAD_SESSION` that the agent's commands carry (see 10-cli.md), and the `session` key that `chad logs --session` filters on (see 16-failures-logs-status.md). The log example there shows a session value that looks like a Discord id beside a short prefixed turn id. Recommended: `crypto.randomUUID()`, written into this part as a new rule. TIM-532 item 11 and TIM-536 item 10, and TIM-559 cold read, harness reader.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| STO-1 | TIM-536 item 12, amended by TIM-541 items 11 to 14, TIM-542 ("What this changes in closed tickets"), TIM-538 items 6 and 8, TIM-549, TIM-557 items 10 and 38, TIM-558 item 20, TIM-559 rulings on STO-G3, STO-G19, MCP-G16, MOD-G2 and FAIL-G20 for the files added to the tree, TIM-559 round 3 on IMG-G19 and STO-G28 for the file beside the copy | Tim. Architect (Tim has not read) for `cache/`, `logs/`, `state/version`, `state/notice-thread` and `run/local.sock`. Architect (Tim has not read) for the files those rulings add | run | TIM-541, TIM-549, TIM-557, TIM-558, TIM-559 | `rule` | `image` |
| STO-2 | TIM-542 item 32 | Tim | run |  | `rule` | `harness` |
| STO-3 | TIM-536 item 12 | Tim | not run |  | `rule` | `harness` |
| STO-4 | TIM-550 item 6, TIM-541 item 11 | Architect (Tim has not read) | run |  | `rule` | `cli` |
| STO-5 | TIM-536 item 4, TIM-541 item 17 | Tim | run |  | `definition` | - |
| STO-6 | TIM-541 item 12 | Architect (Tim has not read) | run |  | `rule` | `image` |
| STO-7 | TIM-541 item 13, amended by TIM-557 items 1 and 10 | Architect (Tim has not read) | run for the rotation, not run for the rest |  | `rule` | `failures` |
| STO-8 | TIM-538 items 6 and 8, TIM-549 follow-up on `repo/examples`, TIM-542 follow-up point 2 | Tim. Architect (Tim has not read) for the rebuild after a restore | run |  | `rule` | `apply` |
| STO-9 | TIM-536 item 1 | Tim | not run |  | `rule` | `cli` |
| STO-10 | TIM-536 item 1, TIM-534 item 11 | Tim | not run |  | `rule` | `cli` |
| STO-11 | TIM-536 item 1, TIM-535, TIM-559 cold read | Tim | run |  | `rule` | `models` |
| STO-12 | TIM-542 item 14, amended by TIM-546 | Tim. Architect (Tim has not read) for the kind and the note | not run | TIM-546 | `rule` | `settings` |
| STO-13 | TIM-536 item 2 | Tim | not run |  | `rule` | `apply` |
| STO-14 | TIM-536 item 2 | Tim | not run |  | `rule` | `apply` |
| STO-15 | TIM-536 item 2 | Tim | not run |  | `rule` | `apply` |
| STO-16 | TIM-542 item 16 | Tim | not run |  | `rule` | `settings` |
| STO-17 | TIM-541 item 14 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| STO-18 | TIM-549 item 23, amended by TIM-559 ruling on MCP-G16 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| STO-19 | TIM-537 item 13, amended by TIM-559 rulings on STO-G19 and MCP-G8, TIM-559 round 3 L3 | Tim. Architect (Tim has not read) for the file and its key | not run | TIM-559 | `rule` | `skills-mcp` |
| STO-20 | TIM-536 item 10 | Tim | read |  | `rule` | `turns` |
| STO-21 | TIM-536 item 10, TIM-532 item 15 | Tim | not run |  | `rule` | `turns` |
| STO-22 | TIM-536 item 10, TIM-541 item 10 | Tim | run |  | `rule` | `turns` |
| STO-23 | TIM-536 item 10 | Tim | not run |  | `rule` | `backup` |
| STO-24 | TIM-536 item 3 | Tim | not run |  | `rule` | `plugin-api` |
| STO-25 | TIM-534 item 1 | Tim | not run |  | `definition` | - |
| STO-26 | TIM-536 item 18 | Tim | run |  | `rule` | `cli` |
| STO-27 | TIM-542 item 3, amended by TIM-550 item 8 and TIM-553 item 5 | Tim. Architect (Tim has not read) for the journal mode and the kept handle | run | TIM-550, TIM-553 | `rule` | `cli` |
| STO-28 | TIM-550 item 9 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| STO-29 | TIM-536 item 4, TIM-538 item 1 | Tim | run |  | `rule` | `harness` |
| STO-30 | TIM-536 item 12 | Tim | not run |  | `rule` | `harness` |
| STO-31 | TIM-536 item 4 | Tim | run |  | `rule` | `harness` |
| STO-32 | TIM-536 item 4 | Tim | read |  | `fact` | `plugin-api` |
| STO-33 | TIM-536 ("How well each is supported") | Tim | read |  | `rule` | `harness` |
| STO-34 | TIM-536 ("What the SQLite file holds", a summary Tim did not review as a schema), amended by TIM-553 and TIM-557 items 30 and 36, TIM-559 ruling on STO-G12 for `steers` | Tim. Architect (Tim has not read) for `notices`, `session_updates` and `steers` | not run | TIM-553, TIM-557, TIM-559 | `rule` | `timers-cron` |
| STO-35 | TIM-532 item 3, TIM-536 ("What the SQLite file holds") | Tim | not run |  | `rule` | `wire` |
| STO-36 | TIM-543 item 2 | Tim | run |  | `rule` | `harness` |
| STO-37 | TIM-536 item 5 | Tim | not run |  | `rule` | `harness` |
| STO-38 | TIM-536 item 5 | Tim | not run |  | `rule` | `harness` |
| STO-39 | TIM-536 item 5 | Tim | not run |  | `rule` | `harness` |
| STO-40 | TIM-536 item 5 | Tim | run for cluster's tables, not run for the key-value layer |  | `rule` | `harness` |
| STO-41 | TIM-536 item 5 | Tim | not run |  | `rule` | `failures` |
| STO-42 | TIM-550 items 7 and 8, TIM-553 item 4, TIM-536 items 5 and 13, TIM-541 item 14, amended by TIM-559 ruling on STO-G5 and on STO-G2, TIM-559 round 3 on IMG-G19 and STO-G28 for the copy's version | Tim for the copy and the migrations. Architect (Tim has not read) for the rest | not run |  | `rule` | `backup` |
| STO-43 | TIM-550 item 7, TIM-541 round 1 point 13, amended by TIM-559 ruling on STO-G5 | Architect (Tim has not read) | run |  | `rule` | `cli` |
| STO-44 | TIM-536 item 13, amended by TIM-559 ruling on STO-G2 and STO-G3 | Tim. Architect (Tim has not read) for the file name and the test | not run | TIM-559 | `rule` | `backup` |
| STO-45 | TIM-536 item 13, TIM-541 item 15 | Tim | not run |  | `rule` | `backup` |
| STO-46 | TIM-541 item 15 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-47 | TIM-541 item 15 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-48 | TIM-541 item 14, amended by TIM-557 item 35, TIM-559 ruling on STO-G3 and STO-G5, TIM-559 round 3 on IMG-G19 and STO-G28, TIM-559 cold read | Architect (Tim has not read) | not run | TIM-541, TIM-557, TIM-559 | `rule` | `backup` |
| STO-49 | TIM-542 item 5, TIM-541 ("What this changes in closed tickets") | Tim | not run |  | `rule` | `cli` |
| STO-50 | TIM-553 item 4 | Architect (Tim has not read) | run | TIM-553 | `rule` | `harness` |
| STO-51 | TIM-553 item 4 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| STO-52 | TIM-553 ("Where the recommendation changed") | Architect (Tim has not read) | not run |  | `definition` | - |
| STO-53 | TIM-553 item 4 | Architect (Tim has not read) | run |  | `rule` | `harness` |
| STO-54 | TIM-553 item 4, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| STO-55 | TIM-553 item 4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| STO-56 | TIM-536 item 3 | Tim | not run |  | `rule` | `plugin-api` |
| STO-57 | TIM-536 item 3 | Tim | not run |  | `rule` | `plugin-api` |
| STO-58 | TIM-548 item 12 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| STO-59 | TIM-536 item 3 | Tim | not run |  | `rule` | `plugin-api` |
| STO-60 | TIM-536 item 3, TIM-542 item 12, TIM-548 item 7 | Tim. Architect (Tim has not read) for a plugin that is turned off | not run | TIM-548 | `rule` | `timers-cron` |
| STO-61 | TIM-542 items 12 and 30, TIM-548 item 7, amended by TIM-559 ruling on CRON-G19 and TIM-559 round 3 C7 | Tim. Architect (Tim has not read) for a plugin that is turned off and for a bundled plugin | not run | TIM-548, TIM-559 | `rule` | `timers-cron` |
| STO-62 | TIM-532 item 11, amended by TIM-559 rulings on SWAP-G2 and SES-G15 | Tim. Architect (Tim has not read) for what the fingerprint hashes and for the mark | run for environment, system prompt and chunk text, not run for the rest | TIM-559 | `rule` | `turns` |
| STO-63 | TIM-532 items 7 and 11 | Tim | not run |  | `rule` | `turns` |
| STO-64 | TIM-536 item 15 | Tim | not run |  | `rule` | `turns` |
| STO-65 | TIM-532 item 11 | Tim | run | TIM-557 | `rule` | `turns` |
| STO-66 | TIM-532 item 7 | Tim | not run |  | `rule` | `backup` |
| STO-67 | TIM-536 item 17 | Tim | read |  | `fact` | `turns` |
| STO-68 | TIM-554 decision 2, which removes the masking added by TIM-546 item 18 | Tim | not run |  | `rule` | `turns` |
| STO-69 | TIM-536 item 11, TIM-543 ("Facts the spec can rely on"), amended by TIM-559 ruling on STO-G11 | Tim. Architect (Tim has not read) for the column name | run for the row per turn, not run for the column name |  | `rule` | `turns` |
| STO-70 | TIM-536 item 11, TIM-533, amended by TIM-557 item 23 | Tim. Architect (Tim has not read) for the columns | run for origin and outcome, not run for the rest | TIM-557 | `rule` | `turns` |
| STO-71 | TIM-536 item 11, amended by TIM-543 item 3 and TIM-557 item 23 | Tim. Architect (Tim has not read) for the column names | run |  | `rule` | `kills` |
| STO-72 | TIM-543 ("Facts the spec can rely on") | Tim | run |  | `rule` | `kills` |
| STO-73 | TIM-543 ("Facts the spec can rely on") | Tim | run |  | `rule` | `kills` |
| STO-74 | TIM-536 item 15, TIM-543 | Tim | not run |  | `rule` | `turns` |
| STO-75 | TIM-536 item 11, TIM-533 | Tim | not run |  | `rule` | `discord-ui` |
| STO-76 | TIM-554 decision 2, which removes the masking added by TIM-546 item 18, amended by TIM-557 item 23 | Tim. Architect (Tim has not read) for the column names | not run |  | `rule` | `failures` |
| STO-77 | TIM-540 item 7, amended by TIM-559 ruling on CRON-G3 | Tim. Architect (Tim has not read) for the column names | run for plugin, name, thread, prompt and next run, not run for the rest |  | `rule` | `timers-cron` |
| STO-78 | TIM-540 item 7, TIM-543 | Tim | run |  | `rule` | `timers-cron` |
| STO-79 | TIM-536 item 6 | Tim | run |  | `rule` | `cli` |
| STO-80 | TIM-542 items 21 and 24, TIM-542 follow-up point 1 | Tim | run |  | `rule` | `cli` |
| STO-81 | TIM-542 items 18 and 26 | Tim | not run |  | `rule` | `cli` |
| STO-82 | TIM-536 item 6 | Tim | not run |  | `rule` | `cli` |
| STO-83 | TIM-536 item 6, TIM-542 item 30 | Tim | not run |  | `rule` | `cli` |
| STO-84 | TIM-536 item 6, TIM-541 item 2 | Tim | run |  | `rule` | `image` |
| STO-85 | TIM-536 item 7 | Tim | not run | TIM-559 | `rule` | `backup` |
| STO-86 | TIM-536 item 7, amended by TIM-542 follow-up point 2 | Tim. Architect (Tim has not read) for what is taken from `repo/` | not run |  | `rule` | `backup` |
| STO-87 | TIM-536 item 7 | Tim | not run |  | `rule` | `backup` |
| STO-88 | TIM-536 item 7, amended by TIM-559 ruling on STO-G21 | Tim. Architect (Tim has not read) for the flag's name | not run |  | `rule` | `backup` |
| STO-89 | TIM-536 item 7, amended by TIM-559 ruling on STO-G22 | Tim. Architect (Tim has not read) for the name, the place and the format number | not run |  | `rule` | `backup` |
| STO-90 | TIM-541 items 12 and 15 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-91 | TIM-536 item 7 | Tim | not run |  | `definition` | - |
| STO-92 | TIM-542 item 21 | Tim | run |  | `rule` | `backup` |
| STO-93 | TIM-542 items 4 and 21 | Tim | not run |  | `rule` | `backup` |
| STO-94 | TIM-542 item 24, TIM-542 follow-up point 1 | Tim | not run |  | `rule` | `backup` |
| STO-95 | TIM-542 item 30 | Tim | not run |  | `rule` | `backup` |
| STO-96 | TIM-536 item 9 | Tim | not run |  | `definition` | - |
| STO-97 | TIM-534 item 10, TIM-541 item 23 | Tim. Architect (Tim has not read) for asphodel's volume | not run |  | `rule` | `backup` |
| STO-98 | TIM-546 item 23, as recorded on TIM-536 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-99 | TIM-536 item 8, TIM-542 follow-up point 1 | Tim. Architect (Tim has not read) for the refusal while the lock is held | not run | TIM-559 | `rule` | `backup` |
| STO-100 | TIM-542 item 30 | Tim | not run |  | `rule` | `backup` |
| STO-101 | TIM-542 follow-up point 2 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-102 | TIM-536 item 8 | Tim | not run |  | `rule` | `backup` |
| STO-103 | TIM-536 item 8, amended by TIM-559 ruling on STO-G22 | Tim. Architect (Tim has not read) for the refusal by `chad restore` | not run | TIM-559 | `rule` | `backup` |
| STO-104 | TIM-536 item 15 | Tim | not run |  | `rule` | `backup` |
| STO-105 | TIM-536 item 15, amended by TIM-559 ruling on STO-G25 | Tim. Architect (Tim has not read) for the order | not run |  | `rule` | `backup` |
| STO-106 | TIM-536 item 15 | Tim | not run |  | `rule` | `backup` |
| STO-107 | TIM-536 item 15 | Tim | not run |  | `rule` | `backup` |
| STO-108 | TIM-536 item 15 | Tim | not run |  | `rule` | `backup` |
| STO-109 | TIM-536 ("How well each is supported") | Tim | read |  | `fact` | `backup` |
| STO-110 | TIM-536 ("How well each is supported") | Tim | read |  | `fact` | `failures` |
| STO-111 | TIM-542 item 16 | Tim | read |  | `rule` | `backup` |
| STO-112 | TIM-532 item 2 | Tim | run |  | `rule` | `turns` |
| STO-113 | TIM-543, as recorded on TIM-536 | Tim | run |  | `rule` | `timers-cron` |
| STO-114 | TIM-536 item 16, amended by TIM-557 item 31 | Tim. Architect (Tim has not read) for the run on a failed write | not run | TIM-557 | `rule` | `failures` |
| STO-115 | TIM-536 item 16, amended by TIM-557 items 31 and 36, TIM-559 round 3 on FAIL-G7 for the clearing levels | Tim for the 1 GB threshold. Architect (Tim has not read) for the second threshold, the keys and the clearing | not run | TIM-557 | `rule` | `failures` |
| STO-116 | TIM-536 ("How well each is supported"), TIM-557 ("Facts found before the grilling") | Tim. Architect (Tim has not read) for `bavail * bsize` | read for `statfs`, run for `bavail * bsize` |  | `rule` | `failures` |
| STO-117 | TIM-536 item 14, amended by TIM-557 item 35 | Tim. Architect (Tim has not read) for the split from STO-48 and the two named cases | not run | TIM-541, TIM-557 | `rule` | `failures` |
| STO-118 | TIM-536 item 14, amended by TIM-557 item 35 | Tim. Architect (Tim has not read) for the wording | not run |  | `rule` | `failures` |
| STO-119 | TIM-536 item 14, amended by TIM-557 item 27, TIM-559 round 3 C5 | Tim. Architect (Tim has not read) for "Problems", `/status` and the live key | not run |  | `rule` | `failures` |
| STO-120 | TIM-536 item 14, TIM-541 item 26, TIM-550 item 8, TIM-553 item 4 | Tim for the database. Architect (Tim has not read) for the other three | not run | TIM-541, TIM-550, TIM-553 | `rule` | `apply` |
| STO-121 | TIM-557 item 38, amended by TIM-559 rulings on STO-G18 and FAIL-G9, TIM-559 round 3 C4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-122 | TIM-558 item 20 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| STO-123 | TIM-557 item 29 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `turns` |
| STO-124 | TIM-557 item 23 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| STO-125 | TIM-557 item 23 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| STO-126 | TIM-557 items 23 to 25, TIM-559 round 3 L1 for the model value | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| STO-127 | TIM-557 item 34 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| STO-128 | TIM-557 item 36, amended by TIM-559 ruling on STO-G13 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-129 | TIM-557 item 36 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-130 | TIM-557 item 36 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-131 | TIM-557 item 30, amended by TIM-559 ruling on STO-G14 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-132 | TIM-557 item 30, amended by TIM-559 ruling on STO-G14 and on FAIL-G8 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-133 | TIM-557 item 26 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| STO-134 | TIM-557 items 31 to 34 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-135 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-136 | TIM-557 items 35 and 38, amended by TIM-559 ruling on FAIL-G20 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-137 | TIM-559 ruling on STO-G17 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| STO-138 | TIM-559 ruling on STO-G17 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| STO-139 | TIM-559 ruling on IMG-G2 and MOD-G16 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| STO-140 | TIM-559 ruling on STO-G18 and REC-G9 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| STO-141 | TIM-559 ruling on STO-G18 and REC-G9 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| STO-142 | TIM-559 ruling on STO-G18 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| STO-143 | TIM-559 ruling on MOD-G2 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| STO-144 | TIM-559 ruling on STO-G18 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| STO-145 | TIM-559 ruling on STO-G18 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| STO-146 | TIM-559 ruling on STO-G19 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| STO-147 | TIM-559 ruling on STO-G8, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| STO-148 | TIM-559 ruling on STO-G8 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| STO-149 | TIM-559 ruling on STO-G8, amended by TIM-559 round 3 L4 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| STO-150 | TIM-559 ruling on FAIL-G11 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| STO-151 | TIM-559 ruling on STO-G10 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| STO-152 | TIM-559 ruling on STO-G10, amended by Tim, chat 2026-11-15 | Architect (Tim has not read). Tim for the change that carries the migration, which was a pull request of its own | not run |  | `definition` | - |
| STO-153 | TIM-559 ruling on SES-G4 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| STO-154 | TIM-559 ruling on STO-G6 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| STO-155 | TIM-559 ruling on STO-G5 | Architect (Tim has not read) | not run |  | `definition` | - |
| STO-156 | TIM-559 ruling on STO-G2 and STO-G3 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-157 | TIM-559 ruling on STO-G2 and STO-G3 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-158 | TIM-559 ruling on STO-G2 and STO-G3 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `backup` |
| STO-159 | TIM-559 ruling on STO-G4 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `backup` |
| STO-160 | TIM-559 ruling on STO-G7 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| STO-161 | TIM-559 ruling on STO-G7, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| STO-162 | TIM-559 ruling on STO-G1, TIM-559 round 3 A2 for the pointer | Architect (Tim has not read) | read for the quoting in `layerSql`, not run for the rest |  | `rule` | `plugin-api` |
| STO-163 | TIM-559 ruling on STO-G9 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| STO-164 | TIM-559 ruling on STO-G11 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| STO-165 | TIM-559 ruling on STO-G11, amended by TIM-559 round 3 L1 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| STO-166 | TIM-559 ruling on STO-G12 and SES-G7 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| STO-167 | TIM-559 ruling on STO-G12 and SES-G7, amended by TIM-559 round 2 R3 and R4 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| STO-168 | TIM-559 ruling on STO-G12 and SES-G7 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| STO-169 | TIM-559 ruling on STO-G13 and FAIL-G8, amended by TIM-559 round 3 C5 and round 4 item 9 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-170 | TIM-559 ruling on STO-G14 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-171 | TIM-559 ruling on STO-G14 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-172 | TIM-559 ruling on STO-G24 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| STO-173 | TIM-559 ruling on STO-G24 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| STO-174 | TIM-559 ruling on STO-G24 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| STO-175 | TIM-559 ruling on STO-G24 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| STO-176 | TIM-559 ruling on STO-G21 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `backup` |
| STO-177 | TIM-559 ruling on STO-G21 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `backup` |
| STO-178 | TIM-559 ruling on STO-G22 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-179 | TIM-559 ruling on STO-G23 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `backup` |
| STO-180 | TIM-559 ruling on STO-G23 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `backup` |
| STO-181 | TIM-559 ruling on STO-G23 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `backup` |
| STO-182 | TIM-559 ruling on STO-G22 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `backup` |
| STO-183 | TIM-559 ruling on STO-G25, IMG-G8 and SES-G16 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-184 | TIM-559 ruling on STO-G25, IMG-G8 and SES-G16 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-185 | TIM-559 ruling on STO-G25, IMG-G8 and SES-G16 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-186 | TIM-559 ruling on FAIL-G20 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| STO-187 | TIM-559 round 1 Q9 item 8, amended by Tim, chat 2026-11-15 | Architect (Tim has not read). Tim for a delivered slice, which was a merged pull request | not run |  | `rule` | `harness` |
| STO-188 | TIM-559 round 2 R5, TIM-553 question 2 for Tim; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | run for what `CHAD_DATA` moves, not run for the rest |  | `rule` | `harness` |
| STO-189 | TIM-559 round 2 R3 | Architect (Tim has not read) | read |  | `fact` | `turns` |
| STO-190 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-191 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-192 | TIM-559 round 3 on IMG-G19 and STO-G28 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| STO-193 | TIM-559 round 3 on IMG-G19 and STO-G28 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
