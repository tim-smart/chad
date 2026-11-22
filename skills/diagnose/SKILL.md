---
name: diagnose
description: Read when the owner asks why a turn failed, why chad didn't answer, why a plugin or hook did nothing, or what went wrong recently.
---

# Diagnosing failures

Start with `chad status`, find the turn in the `turns` table with `chad db query`, then read its log entries with `chad logs --turn`. There's no `chad turns` subcommand, so use the SQL queries below instead.

## Checking current status

```sh
chad status
```

The `Problems` section lists each ongoing issue once (such as a dropped chat connection, an expired login, a full disk, or a plugin that failed to load). The `Recent` section counts turns that failed in the last 24 hours, grouped by reason. If the daemon is down, `chad status` exits 4. `chad logs` and `chad db query` still work without a running daemon.

## Finding the turn

The `turns` table stores one row per turn and is never pruned. Timestamps are integer milliseconds since the Unix epoch. `outcome` is `null` while a turn is running, then `answered`, `failed`, or `stopped`. `failure` holds the reason tag for a failed turn, and `failure_detail` holds the full error as JSON. `starts` counts how many times chad started the turn, and `graceful_cuts` counts how many of those were interrupted by a graceful stop.

```sh
# The last ten turns, newest first
chad db query "SELECT turn_id, session_id, datetime(started_at / 1000, 'unixepoch') AS started, outcome, failure FROM turns ORDER BY started_at DESC LIMIT 10"
# Failed turns in the last 24 hours, with reasons
chad db query "SELECT turn_id, datetime(started_at / 1000, 'unixepoch') AS started, failure, failure_detail FROM turns WHERE outcome = 'failed' AND started_at > (strftime('%s', 'now') - 86400) * 1000 ORDER BY started_at DESC"
# Failure counts by reason over the last week
chad db query "SELECT failure, count(*) AS turns FROM turns WHERE outcome = 'failed' AND started_at > (strftime('%s', 'now') - 604800) * 1000 GROUP BY failure ORDER BY turns DESC"
# Unfinished turns: currently running, or killed and not yet resumed
chad db query "SELECT turn_id, session_id, datetime(started_at / 1000, 'unixepoch') AS started, starts, graceful_cuts FROM turns WHERE ended_at IS NULL"
# Turns started by a plugin, such as cron jobs
chad db query "SELECT turn_id, origin_plugin, origin_label, outcome, failure FROM turns WHERE origin = 'plugin' ORDER BY started_at DESC LIMIT 10"
# Full details for one turn
chad db query --json "SELECT * FROM turns WHERE turn_id = '<turn-id>'"
# Token usage by day and model
chad db query "SELECT date(started_at / 1000, 'unixepoch') AS day, model, count(*) AS turns, sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cache_read_tokens) AS cached FROM turns GROUP BY day, model ORDER BY day DESC LIMIT 14"
```

`chad db query` runs a single read-only statement and prints up to 200 rows unless you pass `--limit`.

## Reading the logs

```sh
# Every log entry for one turn
chad logs --turn <turn-id>
# Turns that failed in the last 24 hours
chad logs --event turn.failed --since 24h
# Warnings and errors in the last two hours
chad logs --level warn --since 2h
# Everything logged by one plugin and its hooks
chad logs --plugin <name> --since 24h
```

`--event` matches event name prefixes, so `--event hook` returns `hook.failed`, `hook.failing`, and `hook.dropped`. Useful events to filter on: `turn.retry`, `turn.failed`, `hook.failed`, `plugin.skipped`, `apply.failed`, `skill.skipped`, `chat.disconnected`, `disk.low`, `disk.full`, `database.unusable`, and `stop.cut`. The raw log file lives at `/data/logs/chad.log`, though `chad logs` is easier to filter.

## Turn failure reasons

| `failure`     | What it means                                                                                                                          | What to do                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ThreadGone`  | The turn's thread no longer exists.                                                                                                    | Nothing.                                                                                |
| `ModelError`  | The model provider failed after retries, or returned a non-retryable error. `failure_detail` has the provider message and retry count. | Read the message, then check the model and login with `chad status`.                    |
| `UsageLimit`  | The login hit its usage limit. `resetsAt` in `failure_detail` is when it resets (milliseconds since epoch).                            | Tell the owner when it resets.                                                          |
| `LoginFailed` | A required login didn't complete.                                                                                                      | Ask the owner to run `chad login`.                                                      |
| `LoggedOut`   | chad is logged out and no owner was available to log in.                                                                               | Ask the owner to run `chad login`.                                                      |
| `GaveUp`      | chad was killed twice during the turn and stopped retrying it.                                                                         | Check the turn's log and `chad logs --event stop --since 24h` to see what stopped chad. |
| `Internal`    | A bug in chad or clanka, including a full disk. `failure_detail` has the error message.                                                | Check the turn's log and `chad status` for disk or database issues. Tell the owner.     |

A `stopped` turn was cancelled on purpose and isn't a failure.
