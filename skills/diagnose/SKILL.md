---
name: diagnose
description: Read when the owner asks why a turn failed, why chad did not answer, why a plugin or a hook did nothing, or what went wrong recently.
---

# Finding out why something failed

Start with `chad status`, find the turn in the `turns` table with `chad db query`, then read the turn's log entries with `chad logs --turn`. The CLI has no `turns` command: the queries below stand in for it.

## What is wrong now

```sh
chad status
```

Its Problems block lists every standing condition once, such as a chat connection that is down, a login that ended, a full disk or a plugin that did not load. Its Recent block counts the turns that failed in the last day, by reason. With the daemon down `chad status` exits 4. `chad logs` and `chad db query` work with no daemon.

## Finding the turn

The `turns` table has one row per turn and is never pruned. Times are integer milliseconds since the epoch. `outcome` is null while a turn runs, then `answered`, `failed` or `stopped`. `failure` is the reason tag of a failed turn and `failure_detail` the whole reason as JSON. `starts` counts how many times chad started the turn, and `graceful_cuts` how many of those a graceful stop cut.

```sh
# The last ten turns, newest first
chad db query "SELECT turn_id, session_id, datetime(started_at / 1000, 'unixepoch') AS started, outcome, failure FROM turns ORDER BY started_at DESC LIMIT 10"
# Failed turns in the last day, with their reasons
chad db query "SELECT turn_id, datetime(started_at / 1000, 'unixepoch') AS started, failure, failure_detail FROM turns WHERE outcome = 'failed' AND started_at > (strftime('%s', 'now') - 86400) * 1000 ORDER BY started_at DESC"
# Failures by reason over the last week
chad db query "SELECT failure, count(*) AS turns FROM turns WHERE outcome = 'failed' AND started_at > (strftime('%s', 'now') - 604800) * 1000 GROUP BY failure ORDER BY turns DESC"
# Turns that have not ended: running now, or cut by a kill and not yet resumed
chad db query "SELECT turn_id, session_id, datetime(started_at / 1000, 'unixepoch') AS started, starts, graceful_cuts FROM turns WHERE ended_at IS NULL"
# Turns a plugin started, such as cron jobs
chad db query "SELECT turn_id, origin_plugin, origin_label, outcome, failure FROM turns WHERE origin = 'plugin' ORDER BY started_at DESC LIMIT 10"
# One turn in full
chad db query --json "SELECT * FROM turns WHERE turn_id = '<turn-id>'"
# Tokens by day and model
chad db query "SELECT date(started_at / 1000, 'unixepoch') AS day, model, count(*) AS turns, sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cache_read_tokens) AS cached FROM turns GROUP BY day, model ORDER BY day DESC LIMIT 14"
```

`chad db query` runs one read-only statement and prints at most 200 rows unless `--limit` says otherwise.

## Reading the log

```sh
# Everything the log holds for one turn
chad logs --turn <turn-id>
# Turns that failed in the last day
chad logs --event turn.failed --since 24h
# Warnings and errors in the last two hours
chad logs --level warn --since 2h
# What one plugin and its hooks logged
chad logs --plugin <name> --since 24h
```

`--event` matches the start of an event name, so `--event hook` gives `hook.failed`, `hook.failing` and `hook.dropped`. Events worth knowing: `turn.retry` and `turn.failed`, `hook.failed`, `plugin.skipped`, `apply.failed`, `skill.skipped`, `chat.disconnected`, `disk.low` and `disk.full`, `database.unusable` and `stop.cut`. The log itself is `/data/logs/chad.log`, but `chad logs` reads it with these filters.

## The reasons a turn fails

| `failure`     | What it means                                                                                                                                            | What to do                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ThreadGone`  | The turn's thread no longer exists.                                                                                                                      | Nothing.                                                                                      |
| `ModelError`  | The model provider failed after chad's retries, or with an error that is not retried. `failure_detail` holds the provider's message and the retry count. | Read the message. Check the model and the login with `chad status`.                           |
| `UsageLimit`  | The login's usage limit is reached. `resetsAt` in `failure_detail` is when it resets, in milliseconds since the epoch.                                   | Tell the owner when it resets.                                                                |
| `LoginFailed` | A login the turn needed did not complete.                                                                                                                | Ask the owner to run `chad login`.                                                            |
| `LoggedOut`   | chad is logged out and no owner was there to log in.                                                                                                     | Ask the owner to run `chad login`.                                                            |
| `GaveUp`      | chad was killed during the turn twice and stopped resuming it.                                                                                           | Read the turn's log and `chad logs --event stop --since 24h` for what stopped chad.           |
| `Internal`    | A defect in chad or in clanka, a full disk included. `failure_detail` holds the message.                                                                 | Read the turn's log, and `chad status` for a full disk or a database problem. Tell the owner. |

A `stopped` turn was stopped on purpose, and is not a failure.
