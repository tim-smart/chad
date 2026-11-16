# Failures, logs and status

This part covers what the owner sees when something goes wrong, and where. It specifies the daemon's two logs and the one logger behind them, the `chad logs` command, the closed set of reasons a turn can fail with and what chad posts for each, the retry line and the bound on a silent model, a usage limit, what the `turns` table records, the two blocks `chad status` and `/status` gain, a full disk, an unusable database, every notice chad sends outside a turn, and the `diagnose` skill. It leans on 04-discord.md for the status message and the answer, on 03-sessions-and-turns.md for how a turn runs and is resumed, on 02-storage.md for the database and the `turns` table's SQL, on 05-model-and-login.md for the login, on 13-timers-and-cron.md for cron, on 10-cli.md for the CLI and on 17-testing.md for the tests named here. Nothing in this part has run as chad. The facts it rests on ran in probes against clanka 0.27.0 and effect 4.1.4 with scripted models and fake backends, and no real provider was called. Those are the versions the probes used and not the versions chad pins.

Some terms are used throughout. The owner is a person whose Discord user id is on chad's allowlist. The daemon is the process started by `chad serve`. A turn is one run of the agent in a session, and a turn has no owner present when a plugin started it, as a cron job does. A notice is a message chad itself writes, as opposed to the model's answer. Subtext is Discord's small grey text, which a line gets by starting with `-# `. A script is the code the model writes and clanka runs during a turn, and a script's output is the text the model reads back from it. A sink is a place log lines are written to.

## The two log sinks

The daemon writes every log entry to two places in two formats. The file is for the agent and for `chad logs`, which parse it. stdout is for a person reading `docker logs` or `kubectl logs` during a crash loop, when nobody can run a command inside the container.

- **FAIL-1** The daemon has two log sinks, stdout and the file `logs/chad.log` on the data volume. Every entry that passes the level filter goes to both. The one exception is an entry of a boot that does not hold the daemon's lock yet (FAIL-322).
- **FAIL-2** `logs/chad.log` gets effect's JSON line unchanged, one line per entry, with the fields `timestamp`, `level`, `message`, `cause`, `annotations`, `spans` and `fiberId`.
- **FAIL-3** stdout gets effect's logfmt line, made by `Logger.formatLogFmt`. It is one line per entry with newlines escaped, and there is no switch that changes the format.
- **FAIL-4** chad always uses the same annotation keys for the same things. They are `event`, `session`, `turn`, `plugin`, `mcp` and `command`. `event` is a stable name such as `turn.failed`, in the form FAIL-240 gives.
- **FAIL-5** Every log call chad itself makes passes one message argument and puts everything else in annotations. Two arguments would print as two `message=` keys in logfmt.
- **FAIL-6** chad sets no log spans. A duration is an annotation field. A span would change the prefix of the line the model reads in a script's output, and a span and an annotation with the same name print as two keys with that name in logfmt.
- **FAIL-7** FAIL-5 and FAIL-6 bind chad's own log calls only. A line that a plugin or clanka logs with two arguments or a span prints as effect prints it.
- **FAIL-8** The event names are a closed list in one module, and each name has a level. Two names have more than one level. The level of `message.ignored` can differ by reason, because only the reason `not-owner` has a fixed level (FAIL-301), and `plugin.log` takes the level of the plugin's own line (FAIL-30). The list is in "Event names" below.
- **FAIL-9** Nothing in the log is masked. A script's source and output are logged, and both go to stdout, so they go wherever the container's logs are shipped.
- **FAIL-10** The daemon logs no RPC request body, no RPC response body and no chat interaction payload (see 10-cli.md and 15-credentials.md).
- **FAIL-322** The daemon writes nothing to `logs/chad.log` before it holds its lock (see 10-cli.md), because until then another daemon may be the one that writes that file (FAIL-34). An entry made before the lock goes to stdout at once. A boot that is refused before it holds the lock, by the start-up check or because the lock is held, writes its `boot.refused` line and every warning from the checks before the lock, such as `boot.filesystem`, to stdout only, and it writes nothing to the volume (see 01-image-and-volume.md). A boot that takes the lock then writes the entries it made before the lock to the file, in the order stdout has them. A boot that is refused after it holds the lock writes `boot.refused` to both sinks.

One entry as each sink writes it. The shapes are the ones the probes printed, and the ids and the fields after `turn` are examples.

```
timestamp=2026-11-15T09:12:44.120Z level=WARN fiber=#412 message="Model error, retrying" event=turn.retry session=1312345678901234567 turn=t_01JCX4 reason=RateLimitError retry=3 of=20
```

```json
{"message":"Model error, retrying","level":"WARN","timestamp":"2026-11-15T09:12:44.120Z","annotations":{"event":"turn.retry","session":"1312345678901234567","turn":"t_01JCX4","reason":"RateLimitError","retry":3,"of":20},"spans":{},"fiberId":"#412"}
```

The logfmt line has the fields in the order `timestamp`, `level`, `fiber`, `message`, `cause` when there is one, then the annotations. A value with whitespace, a double quote or an equals sign is written as a JSON string. The JSON line has no `cause` key when the entry has no cause. A cause prints as the full text of `Cause.pretty`, with stacks, on the same line.

## What a turn writes to the log

The status message is removed when a turn ends (see 04-discord.md), so the log is the only record of what a failed or stopped turn did.

- **FAIL-11** Every action that gets a line in the status message gets a log line at Info, written by the same function that adds the status line.
- **FAIL-12** chad also logs the start of every turn with its origin, and the end of every turn with its outcome, its duration and its token usage.
- **FAIL-326** The first start of a turn writes `turn.started`. Each later start writes `turn.resumed` and no `turn.started`, and the delivery that gives up (SES-106) writes only `turn.failed`.
- **FAIL-13** A script's source is logged cut at 2,000 characters.
- **FAIL-14** A script's output is logged with its first 1,000 and its last 1,000 characters, and the cut is marked. A failing script's error is at the end of its output.
- **FAIL-15** A retry of a model call by the root agent, or by a foreground sub-agent with no background sub-agent above it, is logged at Warn. The retries of a background sub-agent and of every sub-agent under it are not logged.
- **FAIL-16** A failed turn is logged as `turn.failed` at Error, with the full cause. The thread gets only the first line of it.
- **FAIL-241** The log lines of a script that a sub-agent ran carry the sub-agent's id.
- **FAIL-328** A sub-agent's id on a line is the annotation `subagent`, the number in the task id `subagent_<n>` that clanka gives it. A line of the root agent carries no `subagent`. The line of a sub-agent's start carries the first 200 characters of its prompt as `prompt`.
- **FAIL-329** The cut in a script's logged output is the line `[... <n> characters cut ...]`, where `<n>` is the number of characters left out. The line of a script's start carries the length of the whole source as `source_chars`, and the line of its end the length of the whole output as `output_chars`.
- **FAIL-242** A turn that ends as `LoggedOut` or `UsageLimit` is logged once, as `turn.failed` with that reason, and chad writes no second event for it. The reset time of a usage limit is on that line when the error carried one. Two lines for one failure would count it twice.

## Event names

A line chad itself writes carries an `event` annotation from this list. The copy of a line that a plugin logged carries `plugin.log`, and the copy of a line that clanka itself logged carries no `event` (see "The logger"). Each row of the table below is a rule with its own id, so each event has a test that it is written. The levels marked "decided" are fixed, and the others, "Builder's" included, are the builder's choice (FAIL-191).

- **FAIL-240** An event name has the form `area.name` with exactly one dot. The two events of a pair end `-started` and `-ended`.
- **FAIL-189** An event name is added only by a change to this spec. A builder who needs a name the list does not have adds it as a new row of the table below, with a new rule id, in the same change as the code that writes it (see 19-build-order.md).
- **FAIL-190** An event name is never renamed or removed once a release has shipped it. The `--event` filter and the `diagnose` skill's recipes read the names.
- **FAIL-191** The names are the contract and the levels are not. The level of an event is the builder's choice, except the levels the table below marks "decided" and the Info cap on a copy of clanka's line (FAIL-29). The decided levels are Info for a turn's start, its steps and its end (FAIL-11, FAIL-12), Warn for a retry (FAIL-15), Error for `turn.failed` (FAIL-16), Info for a dropped message whose reason is `not-owner` (FAIL-301) and Debug for `rpc.cancelled` (FAIL-304).
- **FAIL-192** A script's end gets a log line at Info, the event `turn.script-ended`, whether or not the status message has a line for it. A script's output exists only at its end, and a duration is an annotation field, which needs an end line to sit on.
- **FAIL-193** A sub-agent's end gets a log line at Info, the event `turn.subagent-ended`, for the same reason.

| Rule | Event | Level | Written when |
| --- | --- | --- | --- |
| **FAIL-244** | `turn.started` | Info (decided) | A turn starts. Carries the origin. |
| **FAIL-245** | `turn.script-started` | Info (decided) | The model finished writing a script. Carries the source, cut as in FAIL-13, and the sub-agent's id when a sub-agent ran the script. |
| **FAIL-246** | `turn.script-ended` | Info (decided) | A script finished. Carries the output, cut as in FAIL-14, the duration, and the sub-agent's id when a sub-agent ran the script. |
| **FAIL-247** | `turn.subagent-started` | Info (decided) | A sub-agent started. Carries its id and the start of its prompt. |
| **FAIL-248** | `turn.subagent-ended` | Info (decided) | A sub-agent ended. Carries its id and the duration. |
| **FAIL-249** | `turn.compaction` | Info (decided) | The history was compacted. |
| **FAIL-250** | `turn.retry` | Warn (decided) | clanka retries a model call of the root agent, or of a foreground sub-agent with no background sub-agent above it. Carries the error's reason tag, its message and the count. The retries of a background sub-agent and of every sub-agent under it get no line. |
| **FAIL-251** | `turn.login-wait` | Info (decided) | The turn waits for a login. |
| **FAIL-252** | `turn.steered` | Info (decided) | The agent read a message that steered the turn (see 03-sessions-and-turns.md). |
| **FAIL-253** | `turn.resumed` | Info (decided) | The turn was resumed after a restart. |
| **FAIL-254** | `turn.ended` | Info (decided) | A turn ended as answered or stopped. Carries the outcome, the duration, the usage and the number of messages the reconcile wrote. |
| **FAIL-255** | `turn.failed` | Error (decided) | A turn ended as failed. Carries the reason tag, the duration, the usage, the number of messages the reconcile wrote and the full cause. For `UsageLimit` it also carries the reset time when the error held one. |
| **FAIL-256** | `turn.answer-unposted` | Error | Posting the answer failed twice (see 04-discord.md). |
| **FAIL-257** | `history.reconciled` | Info | The reconcile at the end of a turn wrote at least one message. Carries the number of messages it wrote. |
| **FAIL-324** | `session.passivated` | Info | A session's entity left memory, after the idle time or at a stop (see 03-sessions-and-turns.md). |
| **FAIL-325** | `session.restored` | Info | chad built the Agent of a session from its stored history. Carries the number of messages it loaded. |
| **FAIL-258** | `model.check-failed` | Warn | A model failed its check at start. |
| **FAIL-259** | `model.logged-in` | Builder's | A login completed. |
| **FAIL-260** | `hook.failed` | Warn | A hook failed, died, ran past its budget or was interrupted at a swap's drain deadline, and was skipped. |
| **FAIL-261** | `hook.failing` | Warn | The same hook failed 3 times in a row. |
| **FAIL-262** | `hook.dropped` | Warn | A queued hook was dropped in a swap, a removal, a turning off, `chad safe on` or a stop. |
| **FAIL-263** | `swap.overrun` | Warn | A handler or hook did not stop when a swap interrupted it, written when the swap moves on. The line says whether two versions of a tool now overlap or the plugin's hook queue has moved on. |
| **FAIL-264** | `swap.overrun-ended` | Info | That handler or hook ended. |
| **FAIL-265** | `swap.close-abandoned` | Warn | A plugin's close ran past its deadline and its finalizers were abandoned. |
| **FAIL-266** | `apply.done` | Info | An apply finished. |
| **FAIL-267** | `apply.failed` | Builder's | An apply was refused or failed. Carries the stage and the error. |
| **FAIL-268** | `plugin.skipped` | Warn | A plugin was skipped at boot or by `chad safe off`. Carries the error. |
| **FAIL-269** | `plugin.log` | The line's own level (FAIL-30) | A plugin wrote a line through Effect's logger. The line is the copy of FAIL-30. |
| **FAIL-270** | `settings.unparsable` | Warn | `chad.json` could not be parsed at boot. |
| **FAIL-271** | `settings.ignored` | Warn | Entries in `chad.json` were ignored at boot. |
| **FAIL-272** | `mcp.config-unreadable` | Warn | `mcp.json` could not be read at boot. |
| **FAIL-275** | `mcp.server-failed` | Builder's | An MCP server failed to connect. |
| **FAIL-276** | `mcp.rebuilt` | Builder's | An MCP rebuild ended. Carries the duration and the counts. |
| **FAIL-277** | `skill.skipped` | Warn | A skill was skipped at boot. |
| **FAIL-278** | `skill.bundled-changed` | Info | A bundled skill that a repo skill hides changed in this image. |
| **FAIL-279** | `disk.low` | Warn | The free space check found less than 1 GB. |
| **FAIL-281** | `disk.full` | Error | A write failed with SQLite's full error. |
| **FAIL-282** | `database.unusable` | Error | The database could not be opened or migrated. |
| **FAIL-283** | `database.migrated` | Builder's | A boot migrated the database. Carries both versions and the path of the copy (see 02-storage.md). |
| **FAIL-284** | `prune.failed` | Error | The nightly prune failed. |
| **FAIL-285** | `backup.failed` | Builder's | `chad backup` failed. |
| **FAIL-286** | `boot.started` | Builder's | (a) `chad serve` holds the lock. Carries the version, Node's version, the data path, (b) whether safe mode is on and why. |
| **FAIL-287** | `boot.ready` | Builder's | The boot finished. Carries the duration and what loaded. |
| **FAIL-288** | `boot.setup-needed` | Warn | `chad serve` started on a volume with no chat connection. |
| **FAIL-289** | `boot.moved-aside` | Warn | Something at `repo/examples` or `repo/node_modules` was moved aside. |
| **FAIL-290** | `boot.filesystem` | Warn | The volume is on a filesystem chad warns about (see 01-image-and-volume.md). The read runs before the lock, so the line reaches the file once the lock is held (FAIL-322). |
| **FAIL-291** | `boot.log-level-unknown` | Warn | `CHAD_LOG_LEVEL` held a value chad does not know. |
| **FAIL-293** | `boot.refused` | Fatal | A boot was refused. Carries the reason, such as the two shard counts. A boot that is refused before it holds the lock writes the line to stdout only (FAIL-322). |
| **FAIL-294** | `stop.started` | Builder's | The SIGTERM handler ran. |
| **FAIL-295** | `stop.ended` | Builder's | A stop finished inside the deadline. Carries the duration. |
| **FAIL-296** | `stop.dropped` | Warn | A graceful stop dropped something. |
| **FAIL-297** | `stop.cut` | Error | chad's 60 second deadline cut a stop. Names what was still open (see 01-image-and-volume.md). |
| **FAIL-298** | `chat.connected` | Builder's | The gateway session is up or resumed. |
| **FAIL-299** | `chat.disconnected` | Builder's | The gateway closed. Carries the close code. |
| **FAIL-300** | `chat.refused` | Builder's | Discord closed the gateway for good, as for a bad token or missing intents. |
| **FAIL-301** | `message.ignored` | Info for `not-owner` (decided) | A message was dropped. Carries the reason, which is `not-owner`, `own`, `duplicate` or `not-mentioned`, and the author's id, and never the content (see 03-sessions-and-turns.md and 04-discord.md). |
| **FAIL-302** | `command.ran` | Builder's | (a) A CLI or (b) chat command (a) that changes something finished. (a) Carries the command, the caller, which is the owner, a session id or the daemon, and the outcome, and never a secret's value (see 10-cli.md). (c) Withdrawn. |
| **FAIL-303** | `timer.held` | Builder's | A timer came due for a plugin that is not loaded (see 13-timers-and-cron.md). |
| **FAIL-304** | `rpc.cancelled` | Debug (decided) | The RPC server interrupted a call because its client went away, as it does when the owner presses Ctrl-C (see 10-cli.md). The daemon cannot tell Ctrl-C from a killed client or a closed socket, so it writes one line for each call that is interrupted this way. |
| **FAIL-305** | `notice.sent` | Info | A notice outside a turn was posted. Carries its key or its kind. |
| **FAIL-306** | `notice.undelivered` | Warn | A notice could not be posted, because no session is known or the post failed twice. |

The `not-owner` line is at Info because it is how a wrong owner id shows up at first setup. What the three `chat.` events can carry depends on what dfx exposes (see 04-discord.md).

- **FAIL-323** The three `chat.` lines carry `connection`, the name of the chat connection. `chat.connected` carries `resumed`, which is true for a resume and false for a fresh identify. Every close of a gateway socket writes `chat.disconnected` with `code`, the close code or null when the close had none, and `by`, which is `chad` when chad's side closed the socket and `discord` when it did not. A close for good (DIS-115) writes `chat.refused` with the code as well as `chat.disconnected`.

## CHAD_LOG_LEVEL

- **FAIL-17** `CHAD_LOG_LEVEL` takes `all`, `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `none`, in any letter case. The default is `info`.
- **FAIL-18** Any other value logs a warning, the event `boot.log-level-unknown`, and chad uses `info`. The value never stops a boot.
- **FAIL-19** The level filters chad's two sinks and never what a script sees. No value of `CHAD_LOG_LEVEL` changes the text the model reads.
- **FAIL-20** effect's minimum log level for the process is the more verbose of Info and `CHAD_LOG_LEVEL`. The variable can therefore only lower that minimum. At `warn`, `error`, `fatal` or `none` the minimum stays at Info, and chad's two sinks drop what the value leaves out (FAIL-19). At the default nothing below Info is built. The cost of every Debug and Trace call in effect, cluster and dfx is paid only when the owner asks for `debug`, `trace` or `all`.
- **FAIL-21** The part of the logger that prints into a script's output always drops a line below Info, whatever the level is. That is what plain clanka shows the model. The dropped line still gets its copy in chad's sinks when the level allows it.
- **FAIL-22** A named test checks that the model's text is byte-identical at every value of `CHAD_LOG_LEVEL` (see 17-testing.md).

| Value | Kept in chad's sinks |
| --- | --- |
| `all` | Everything |
| `trace` | Trace and above |
| `debug` | Debug and above |
| `info` (default) | Info, Warn, Error, Fatal |
| `warn` | Warn, Error, Fatal |
| `error` | Error, Fatal |
| `fatal` | Fatal |
| `none` | Nothing |

## The logger

chad cannot replace effect's loggers with a JSON logger. clanka shows the model a failing script's error, and each "Calling ..." line of a built-in tool, by logging on a fiber whose `Console` is the script's own, and effect's default logger prints through that `Console`. With the loggers replaced by one that does not, the model saw no error at all. So chad installs one logger that looks at the fiber's `Console` and does both jobs.

- **FAIL-23** chad installs one logger for the whole process. A log call on a fiber whose `Console` is a script's console is printed into that script's output in effect's default format, by handing the entry to `Logger.defaultLogger` exactly as plain clanka does, and a copy goes to chad's two sinks. Every other log call goes to chad's two sinks only.
- **FAIL-24** The logger's layer is in place when a session's executor layer is built, not only around a turn. Tool calls run on fibers made from the context captured at that build.
- **FAIL-25** The session id and the turn id on a line come from one mutable object per session. chad provides the object where the session's executor layer is built and where its Agent is built, and the logger reads it from the fiber.
- **FAIL-26** chad writes the turn id into that object when a turn starts and clears it when the turn ends. So the turn id on a copy means the turn that was running in that session when the line was written. A background task that logs between turns gets the session and no turn, and one that logs during a later turn gets that turn's id.
- **FAIL-27** A plugin's name comes from a `Context.Reference` that chad sets around everything it runs for a plugin. That is the Layer build, the tool handlers, the hooks, the prompt render, the finalizers and the `Plugin.background` fibers that chad forks at activation (see 06-plugin-api.md, which owns the list). The logger reads the reference from the fiber, and a fiber forked from any of those places keeps it, so a line logged from any of them carries the plugin's name.
- **FAIL-28** Nothing is stripped from the line the model reads. A plugin's own annotation named `plugin` or `command` reaches the model untouched, because chad's ids are not log annotations on that fiber.
- **FAIL-29** The copy of a line that clanka itself logged is capped at Info. clanka logs a failing script at Fatal, and a model writing a bad script is routine.
- **FAIL-30** The copy of a line that a plugin logged through Effect's logger keeps its level and carries the event `plugin.log` (see 06-plugin-api.md).
- **FAIL-31** A plugin's log call inside a tool handler lands in the script's output as it does in plain clanka, and its copy in chad's sinks carries the plugin's name, the session and the turn.

What ran in the probes. The script's output was the same text as with effect's default logger in 8 of 8 turns, at `all`, `info`, `warn` and `none`. The per-session object gave the right session and turn on a built-in tool's line, a plugin handler's line and a failing script's line with two sessions running at once. The reference was read on the handler's own fiber and on every fiber it forked, including one that logged after the handler returned. A root fiber started with no context (`Effect.runPromise` inside a handler) had neither the reference nor chad's logger, and its line went to the process's stdout through effect's default logger. The copy, the Info cap and the ids were not run together.

The logger, built from the probes' code. The probes wrote the JSON line to both sinks and made no copy on the script branch.

```ts
import * as fs from "node:fs"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as LogLevel from "effect/LogLevel"
import * as References from "effect/References"

// The console a fiber sees when nothing provided a Console service.
// Captured once, at module load, before anything can swap globalThis.console.
export const daemonConsole = globalThis.console

// True when a default logger on this fiber would print somewhere other than
// the process console, which in clanka means into a script's output.
export const isScriptConsoleFiber = (fiber: Logger.Options<unknown>["fiber"]) =>
  fiber.getRef(Console.Console) !== daemonConsole

// One mutable object per session. chad provides it where the session's executor
// layer is built and where its Agent is built, sets `turn` when a turn starts and
// clears it when the turn ends.
export interface SessionLogIds { readonly session: string; turn: string | undefined } // adjusted: TIM-557 item 8
export const CurrentLogIds = Context.Reference<SessionLogIds | undefined>("chad/CurrentLogIds", { // adjusted: TIM-557 item 8
  defaultValue: () => undefined
})

// Set by chad around everything it runs for a plugin (FAIL-27). For a tool handler: // adjusted: TIM-559
//   handler(params).pipe(Effect.provideService(PluginName, name))
export const PluginName = Context.Reference<string | undefined>("chad/PluginName", { // adjusted: TIM-557 item 8
  defaultValue: () => undefined
})

type Level = "all" | "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "none"
const toLogLevel = (name: Level): LogLevel.LogLevel =>
  (name[0].toUpperCase() + name.slice(1).toLowerCase()) as LogLevel.LogLevel
// LogLevel.isLessThan(entry, minimum): "None" is above every severity, "All" is below every severity.
const below = (entry: LogLevel.LogLevel, minimum: LogLevel.LogLevel) => LogLevel.isLessThan(entry, minimum)

// Size-capped appender. Synchronous, and it rotates only between lines:
// path -> path.1 -> path.2 -> path.3, and the oldest is overwritten.
export const makeRotatingAppender = (options: { path: string; maxBytes: number; keep: number }) => {
  const { path, maxBytes, keep } = options
  let size = fs.existsSync(path) ? fs.statSync(path).size : 0
  const rotate = () => {
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? path : path + "." + (i - 1)
      if (fs.existsSync(from)) fs.renameSync(from, path + "." + i)
    }
    size = 0
  }
  const writeChunk = (chunk: string, bytes: number) => { fs.appendFileSync(path, chunk); size += bytes }
  const appendSync = (lines: ReadonlyArray<string>) => {
    try {
      let chunk = "", chunkBytes = 0
      for (const line of lines) {
        const text = line + "\n"
        const bytes = Buffer.byteLength(text)
        // A line that would cross the cap goes to a fresh file, whole.
        if (size + chunkBytes > 0 && size + chunkBytes + bytes > maxBytes) {
          if (chunkBytes > 0) writeChunk(chunk, chunkBytes)
          chunk = ""; chunkBytes = 0
          rotate()
        }
        chunk += text; chunkBytes += bytes
      }
      if (chunkBytes > 0) writeChunk(chunk, chunkBytes)
    } catch { /* a write that fails is dropped, and stdout still has the line */ }
  }
  return { appendSync }
}

// The file writer. One pending list, in the order the logger produced the lines.
//   write(line, false): the line waits for the next window.
//   write(line, true):  everything pending and this line are appended now, synchronously, in order.
export const makeFileWriter = (options: { path: string; maxBytes?: number; keep?: number }) => {
  const appender = makeRotatingAppender({
    path: options.path,
    maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
    keep: options.keep ?? 3
  })
  let pending: Array<string> = []
  const flushSync = () => {
    if (pending.length === 0) return false
    const lines = pending
    pending = []
    appender.appendSync(lines)
    return true
  }
  const write = (line: string, urgent: boolean) => {
    pending.push(line)
    if (urgent) flushSync()
  }
  return { write, flushSync }
}

const urgentLevels = new Set<LogLevel.LogLevel>(["Error", "Fatal"])

interface Ids { readonly session?: string; readonly turn?: string; readonly plugin?: string }
const idsOf = (fiber: Logger.Options<unknown>["fiber"]): Ids => { // adjusted: TIM-557 item 8
  const cell = fiber.getRef(CurrentLogIds)
  return { session: cell?.session, turn: cell?.turn, plugin: fiber.getRef(PluginName) }
}

// Renders one entry with `session`, `turn` and `plugin` added to its annotations.
// effect's formatters read the annotations from the fiber, so how the ids are
// merged in is left to the build (see FAIL-G12). Not in the probes.
// A plugin's line also gets the annotation event "plugin.log". // adjusted: TIM-559
declare const render: ( // adjusted: TIM-557 item 8
  format: Logger.Logger<unknown, string>,
  options: Logger.Options<unknown>,
  ids: Ids
) => string

export const makeRouteLogger = (options: {
  level: Level
  writer: ReturnType<typeof makeFileWriter>
  stdout?: (line: string) => void
}) => {
  const minimum = toLogLevel(options.level)
  const stdout = options.stdout ?? ((line: string) => { process.stdout.write(line + "\n") })
  // chad's two sinks, filtered by CHAD_LOG_LEVEL.
  const sinks = (entry: Logger.Options<unknown>, ids: Ids) => {
    if (below(entry.logLevel, minimum)) return
    stdout(render(Logger.formatLogFmt, entry, ids)) // adjusted: TIM-557 item 1, the probes wrote the JSON line here
    options.writer.write(render(Logger.formatJson, entry, ids), urgentLevels.has(entry.logLevel))
  }
  return Logger.make((entry: Logger.Options<unknown>) => {
    const ids = idsOf(entry.fiber) // adjusted: TIM-557 item 8
    if (isScriptConsoleFiber(entry.fiber)) {
      // The model's text. Nothing below Info, whatever CHAD_LOG_LEVEL is.
      if (!below(entry.logLevel, "Info")) Logger.defaultLogger.log(entry) // adjusted: TIM-557 item 6
      // The copy. A line logged with no plugin name set is clanka's own and is capped at Info. // adjusted: TIM-559
      const capped = ids.plugin === undefined && LogLevel.isGreaterThan(entry.logLevel, "Info") // adjusted: TIM-557 item 9
      sinks(capped ? { ...entry, logLevel: "Info" } : entry, ids) // adjusted: TIM-557 item 7, the probes made no copy
      return
    }
    sinks(entry, ids)
  })
}

// effect's minimum level: the more verbose of Info and CHAD_LOG_LEVEL.
const minimumLevel = (level: Level): LogLevel.LogLevel => // adjusted: TIM-557 item 6
  below(toLogLevel(level), "Info") ? toLogLevel(level) : "Info"

// The process-wide layer. It is provided before any session's executor layer is built.
// The window timer and the last flush belong to the layer's scope.
export const layer = (options: { path: string; level: Level; window?: string }) =>
  Layer.merge(
    Logger.layer([
      Effect.gen(function* () {
        const writer = makeFileWriter({ path: options.path })
        yield* Effect.sleep(options.window ?? "1 second").pipe(
          Effect.andThen(Effect.sync(() => { writer.flushSync() })),
          Effect.forever,
          Effect.forkScoped
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => { writer.flushSync() }))
        return makeRouteLogger({ level: options.level, writer })
      })
    ]),
    Layer.succeed(References.MinimumLogLevel, minimumLevel(options.level)) // adjusted: TIM-557 item 6
  )
```

## Rotation and the flush

effect has no rotating file logger, and its `Logger.toFile` flushes once a second and so loses exactly the lines that explain a crash. Both are chad's own code, shown above.

- **FAIL-32** `chad.log` is renamed to `chad.log.1` when it passes 10 MB. `chad.log.1` to `chad.log.3` are kept, so the logs take at most 40 MB.
- **FAIL-33** A rotation happens between two lines. No line is split across two files.
- **FAIL-34** Only the daemon writes the log file.
- **FAIL-35** chad owns the list of lines waiting to be written to the file. An Error or Fatal line writes everything waiting plus itself at once, in one synchronous append, so the file keeps the order stdout has.
- **FAIL-36** The writer flushes on every exit path chad controls.
- **FAIL-37** A write to the file that fails, as on a full disk, is dropped without a notice. stdout still gets the line.
- **FAIL-243** The `stop.cut` line is written synchronously to both sinks before the process exits, without waiting for the writer's window. A blocked event loop stops the timer that writes it, and Docker's 90 second grace period is then the backstop (see 01-image-and-volume.md, which holds the rule).

What ran in the probes. With 4 fibers logging 400 lines at once, 32 of them Error or Fatal, the file was byte-identical to stdout, and after each Error or Fatal call returned the file held everything sent so far. With a 2,000 byte cap that made 44 rotations, the files joined oldest first were byte-identical to stdout. After a hard exit that followed 50 Info lines, 1 Error and 10 more Info lines, the file held the 51 lines up to the Error. A write is handed to the operating system with no `fsync`, so a power loss is not covered.

## chad logs

- **FAIL-38** `chad logs` reads `logs/chad.log` and its rotated files from the volume, in the CLI process. It does not call the daemon and works when no daemon runs.
- **FAIL-39** It prints one line per entry, written for a person. `--json` prints the stored JSON lines.
- **FAIL-40** `--turn`, `--session` and `--plugin` filter on those annotation keys. `--event` matches a prefix of the event name, so `--event turn.` matches every turn event. `--level` filters by level and `--since` by time. `-f` keeps printing new entries as they are written.
- **FAIL-41** With none of the six filters, which are `--turn`, `--session`, `--plugin`, `--event`, `--level` and `--since`, it prints the last 200 entries. `-f` and `--json` are not filters.
- **FAIL-42** The agent may run `chad logs`. It has no chat form.
- **FAIL-194** Several filters combine with "and". An entry is printed only when it matches every filter given.
- **FAIL-195** `--level` is a minimum. It prints the entries at that level and above, and it takes the level names that `CHAD_LOG_LEVEL` takes (FAIL-17).
- **FAIL-196** `--since` takes a duration such as `15m` or `2h`, or an ISO 8601 time.
- **FAIL-197** An ISO time with no offset is read as UTC, and the line written for a person prints its time in UTC. The command runs with no daemon and no database, so it cannot depend on the stored timezone.
- **FAIL-198** `-f` has the long form `--follow`. With none of the six filters it prints the last 200 entries and then follows. With a filter it prints every match and then follows.
- **FAIL-199** `-f` keeps following when the log file is rotated.
- **FAIL-200** `chad logs` uses the exit codes of 10-cli.md. It exits 0 when nothing matches, because exit 1 means that a command ran and failed, and the agent reads it.
- **FAIL-201** A `--level` or `--since` value that it cannot read exits 2. This differs on purpose from `CHAD_LOG_LEVEL`, which falls back to `info` (FAIL-18).
- **FAIL-202** `chad logs` never exits 4, because it needs no daemon.
- **FAIL-330** The line for a person holds, in this order and on one line, the entry's time in UTC, its level, its event when it has one, its message, its other annotations as `key=value`, and its cause. A value with whitespace, a double quote or an equals sign, and an empty one, is written as a JSON string. A line of the files that is not a JSON entry is skipped.
- **FAIL-331** `chad logs` exits 1 when a log file is there and cannot be read.

```
chad logs [--turn <id>] [--session <id>] [--plugin <name>] [--event <prefix>]
          [--level <level>] [--since <time>] [-f | --follow] [--json]
```

## How a turn can fail

A turn ends with an `Outcome`, which is `Answered`, `Failed` with a reason, or `Stopped` (see 06-plugin-api.md). The reason is a tagged value, and its tags are a closed set. A plugin reads it in `afterTurn` and from `Turns.start`, cron decides from it whether a run counts as a failure, and the `turns` table stores it.

- **FAIL-43** `Failed.reason` is one of exactly seven tags: `ThreadGone`, `ModelError`, `UsageLimit`, `LoginFailed`, `LoggedOut`, `GaveUp` and `Internal`.
- **FAIL-44** `ThreadGone` means the turn's thread no longer exists.
- **FAIL-335** A turn whose answer cannot be posted because the platform no longer has the thread ends `Failed` with `ThreadGone`, and the answer stays in the history.
- **FAIL-45** `ModelError { reason, message, retries }` means clanka's stream failed with `RetriesExhausted`, or with an `AiError` that clanka does not retry, or chad's silence bound ended the turn (FAIL-84). `reason` is the `AiError` reason tag, such as `RateLimitError`, except after the silence bound, where it is chad's own value `TurnTimeout` (FAIL-203).
- **FAIL-46** `UsageLimit { resetsAt? }` means the model provider said the plan's usage limit is reached. It also covers a `QuotaExhaustedError` on the API key path.
- **FAIL-47** `LoginFailed { reason }` means a login the turn needed did not complete. The reason is `TimedOut` when chad's 15 minute login wait ran out, or one of clanka's three `CodexAuthError` reasons, `DeviceFlowFailed`, `TokenExchangeFailed` and `RefreshFailed`. A login failure inside a model call reaches chad as a defect that wraps `CodexAuthError`, and chad looks inside the defect for it.
- **FAIL-48** `LoggedOut` means a turn with no owner present found chad logged out with no login pending. Such a turn never starts a login and ends at once. When a login is already pending the turn waits on it, and it ends as `LoginFailed` if that login fails (see 05-model-and-login.md).
- **FAIL-49** `GaveUp` means chad stopped retrying a resumed turn after two starts that ended in a kill (see 03-sessions-and-turns.md).
- **FAIL-50** `Internal { message }` means any other defect in chad or in clanka. A full disk is `Internal`. There is no tag for it, because the row that would record it could not be written and no plugin would act on it differently.
- **FAIL-51** A turn whose answer could not be posted to a thread that still exists stays `Answered`, because the answer is in the history.
- **FAIL-52** A turn whose answer is exactly `[SILENT]` ends as `Answered { text: "[SILENT]" }`, so a plugin can tell, and its `turns` row says `answered`.
- **FAIL-53** A failing script does not fail the turn. Its error goes into the script's output and the model reads it.
- **FAIL-203** A `ModelError` from the silence bound holds `reason: "TurnTimeout"`, `message` as clanka's text arrived, and `retries` at the count of `ErrorRetry` parts on that model call.
- **FAIL-204** chad tells clanka's turn timeout from another error in one predicate and nowhere else. No stored row and no plugin has to match clanka's wording, because the stored `reason` says which case it was.
- **FAIL-205** A test runs that predicate against real clanka with a model that never answers, so a reword in clanka fails CI and does not quietly bring back the 117 minute call (see "Retries and the silence bound").
- **FAIL-206** `UsageLimit.resetsAt` is an integer number of milliseconds since the epoch, like the times in the `turns` table, which stores it in `failure_detail`.
- **FAIL-207** A status message post that fails because the thread is gone ends the turn as `ThreadGone` before the model runs (see 04-discord.md).

The reason as a schema. The session prototype had `reason: Schema.String`.

```ts
import * as Schema from "effect/Schema"

export const FailedReason = Schema.Union([ // adjusted: TIM-557 item 12
  // The turn's thread no longer exists.
  Schema.TaggedStruct("ThreadGone", {}),
  // clanka's stream failed with RetriesExhausted or an AiError it does not retry,
  // or chad's silence bound ended the turn.
  Schema.TaggedStruct("ModelError", { // adjusted: TIM-557 item 12
    reason: Schema.String, // the AiError reason tag, or "TurnTimeout" from the silence bound. adjusted: TIM-559
    message: Schema.String,
    retries: Schema.Number
  }),
  // The provider said the plan's usage limit is reached.
  Schema.TaggedStruct("UsageLimit", { // adjusted: TIM-557 item 12
    resetsAt: Schema.optionalKey(Schema.Number) // integer milliseconds since the epoch. adjusted: TIM-559
  }),
  // A login the turn needed did not complete.
  Schema.TaggedStruct("LoginFailed", { // adjusted: TIM-557 item 12
    reason: Schema.Literals(["TimedOut", "DeviceFlowFailed", "TokenExchangeFailed", "RefreshFailed"])
  }),
  // A turn with no owner present on a chad that is logged out.
  Schema.TaggedStruct("LoggedOut", {}), // adjusted: TIM-557 item 12
  // A resumed turn chad stopped retrying after two kills.
  Schema.TaggedStruct("GaveUp", {}), // adjusted: TIM-557 item 12
  // Any other defect in chad or clanka, a full disk included.
  Schema.TaggedStruct("Internal", { message: Schema.String }) // adjusted: TIM-557 item 12
])

export const Outcome = Schema.Union([
  Schema.TaggedStruct("Answered", { text: Schema.String }),
  Schema.TaggedStruct("Failed", { reason: FailedReason }), // adjusted: TIM-557 item 12
  Schema.TaggedStruct("Stopped", {})
])
```

## What chad posts for a failed turn

- **FAIL-54** A failed turn posts a normal message, not subtext, in the turn's thread. It reads "That turn failed after 2m 3s: <reason>. The conversation is intact, send a message to carry on.", with the time the turn ran.
- **FAIL-55** For a `ModelError` with no retries, `<reason>` is "the model request failed (<reason tag>: <first line of the message>)".
- **FAIL-56** For a `ModelError` after retries, `<reason>` is "the model kept failing after <n> retries (<reason tag>: <first line>)".
- **FAIL-57** For a `ModelError` whose `reason` is `TurnTimeout`, which is the silence bound, `<reason>` is "the model did not answer for 15 minutes".
- **FAIL-58** For `Internal`, `<reason>` is "chad hit an error (<first line>)".
- **FAIL-59** The first line of a provider's message is cut at 200 characters. A provider message can be a page of JSON.
- **FAIL-60** `UsageLimit` replaces the failed-turn message with "You've reached the usage limit on this login. It resets <time>. Wait, or move to another provider with `/model`." `<time>` is a Discord timestamp. The sentence "It resets <time>." is left out when the error carried no reset time.
- **FAIL-61** `LoginFailed` with `TimedOut` replaces the failed-turn message with "Login timed out. Send a message to try again." The login wait is chad's own and lasts 15 minutes. When it runs out, every turn that was waiting for the login gets this message, and a turn that lost its login part way through keeps the history it had (see 05-model-and-login.md).
- **FAIL-62** `LoginFailed` with any other reason replaces the failed-turn message with "Login failed (<reason>). Send a message to try again."
- **FAIL-63** (a) `GaveUp` replaces the failed-turn message with the give-up message, "This turn was cut off by a crash twice, so I've stopped retrying it. Whatever its scripts already did is done. Send a message to carry on." (b) chad removes the status message the turn left behind when it posts it. (a) Only kills count toward the two, and a turn can be cut by any number of graceful restarts.
- **FAIL-64** `LoggedOut` and `ThreadGone` post nothing in the turn's thread. The owner learns of them from the notices in FAIL-175 and FAIL-173.
- **FAIL-65** Every failed-turn message and every give-up message ends with one subtext line, "-# Turn <id>. `chad logs --turn <id>` shows what it did."
- **FAIL-66** In a server thread the failed-turn message is a reply to the owner's message with the reply ping on, like an answer. A plain post in a server thread notifies nobody. When that message no longer exists the post is a plain post, as for every post chad makes as a reply (see 04-discord.md).
- **FAIL-67** The failed-turn message of a plugin-started turn that carries a `mention` starts with that mention. The core drops a mention whose id is not on the allowlist (see 13-timers-and-cron.md).
- **FAIL-68** A plugin-started turn that fails with `LoggedOut`, `LoginFailed` or `UsageLimit` posts nothing in its thread. The messages in FAIL-60 to FAIL-62 are for turns an owner started.
- **FAIL-69** A stopped turn is not a failure. It posts "Stopped after 48s." (see 04-discord.md).
- **FAIL-70** When chad itself crashes with no turn running, nothing is posted in chat. The crash is in stdout and in the flushed log.
- **FAIL-208** The give-up message and the two login messages in FAIL-61 to FAIL-63 are normal messages and not subtext. They take the failed-turn message's place, and they are what the owner has to read and act on.
- **FAIL-209** The Discord timestamp in FAIL-60 takes seconds, so chad divides `resetsAt` by 1,000 to print it. A test checks the printed time.
- **FAIL-210** A plugin-started turn that ends as `LoggedOut` or `LoginFailed` begins the `logged-out` condition if it is not held, and one that ends as `UsageLimit` begins the `usage-limit` condition if it is not held (see "Notices outside a turn"). Without this, a token refresh that fails on a cron run would leave no message in the thread, no notice and no count toward a pause, and scheduled runs would stop with nothing said.

Every failure in one table. "Thread" is the turn's thread. "Counts for cron" says what a cron job does with a run that ended this way (see "Cron's failure counting").

| Tag | When | What is posted | Where | Counts for cron |
| --- | --- | --- | --- | --- |
| `ThreadGone` | The turn's thread no longer exists | "`<plugin>` could not run `<label>` because its thread is gone." | Where a notice outside a turn goes | Pauses the job at once |
| `ModelError`, no retries | An `AiError` clanka does not retry, `usage_not_included` included | The failed-turn message with "the model request failed (<reason tag>: <first line of the message>)" | Thread | Yes |
| `ModelError`, after retries | `RetriesExhausted` | The failed-turn message with "the model kept failing after <n> retries (<reason tag>: <first line>)" | Thread | Yes |
| `ModelError`, silence bound | The third turn timeout in a row on one model call | The failed-turn message with "the model did not answer for 15 minutes" | Thread | Yes |
| `UsageLimit` | The first error that names a usage limit or a quota | "You've reached the usage limit on this login. It resets <time>. Wait, or move to another provider with `/model`." With no owner present, nothing in the thread and the `usage-limit` notice | Thread, or where a notice outside a turn goes | No |
| `LoginFailed`, `TimedOut` | chad's 15 minute login wait ran out | "Login timed out. Send a message to try again." With no owner present, nothing in the thread and the `logged-out` notice | Thread of every waiting turn, or where a notice outside a turn goes | No |
| `LoginFailed`, other reasons | clanka's login failed inside a model call | "Login failed (<reason>). Send a message to try again." With no owner present, nothing in the thread and the `logged-out` notice | Thread, or where a notice outside a turn goes | No |
| `LoggedOut` | A turn with no owner present found chad logged out | Nothing in the thread. The `logged-out` notice | Where a notice outside a turn goes | No |
| `GaveUp` | Two starts of the turn ended in a kill | The give-up message | Thread | Pauses the job at once |
| `Internal` | Any other defect in chad or clanka | The failed-turn message with "chad hit an error (<first line>)" | Thread | Yes |

## Cron's failure counting

The cron plugin and its jobs are in 13-timers-and-cron.md. These rules say which outcomes of a run count against a job.

- **FAIL-71** A failed run is not retried.
- **FAIL-72** Three failures in a row pause the job, and cron posts a line in the job's thread, "Paused `<job>` after 3 failed runs in a row (<last reason>). Resume it when the cause is fixed."
- **FAIL-73** A run the owner stops is not a failure.
- **FAIL-74** A run that fails with `LoggedOut`, `LoginFailed` or `UsageLimit` is not a failure of the job. It neither adds to the count of three in a row nor resets it.
- **FAIL-75** Such a run posts nothing in the job's thread.
- **FAIL-76** Such a run is not run again later. This differs on purpose from a run missed while chad was down, which fires once when chad returns. Making it up would need a signal to plugins that the model is back, which is new API.
- **FAIL-77** A run that fails with `GaveUp` pauses the job at once, as `ThreadGone` does. A job whose run kills the daemon twice would otherwise take six crashes to pause, and cron stays on in safe mode.
- **FAIL-78** A run that fails with `ThreadGone` pauses the job at once, and the core posts the notice in FAIL-173.
- **FAIL-211** A one-shot job follows its own rule. It is deleted after any run that happened, and it is kept, paused, after a run that ended as `LoggedOut`, `LoginFailed` or `UsageLimit` (see 13-timers-and-cron.md).

## Retries and the silence bound

clanka retries a model call that fails with a retryable error or that hits its turn timeout. The turn timeout is an inactivity timeout of 5 minutes. Every part the model streams resets it, and it is paused while a script runs. The retry count is per model call and starts again after a call succeeds, so one call gets 21 attempts at clanka's default of 20 retries. The waits between retries start at 100 ms and grow by a factor of 1.5. Each retry reaches chad as an `ErrorRetry` part that carries the error and no attempt number.

- **FAIL-79** chad leaves clanka's `MaxRetries` and `TurnTimeout` at their defaults, 20 retries and 5 minutes.
- **FAIL-80** While clanka retries, the status message's line names the cause and the count, in the form "Model error (RateLimitError), retrying (3 of 20)".
- **FAIL-81** chad counts `ErrorRetry` parts per agent, since that agent's last `Usage` part. A sub-agent's parts arrive wrapped in `SubagentPart`, so the parent's count resets on its own `Usage` and each sub-agent's on a `Usage` inside its `SubagentPart`. The line shows the highest count.
- **FAIL-82** The 20 in the line is read from the value chad gives clanka and is not a literal.
- **FAIL-83** While a login is pending for the session, chad does not show clanka's retry parts in the status message (see 05-model-and-login.md).
- **FAIL-84** chad ends a turn at the third `ErrorRetry` in a row, on one model call, whose error is clanka's turn timeout. That is 15 minutes of a provider saying nothing. The turn ends as `Failed` with `ModelError`.
- **FAIL-85** Errors that come back fast keep all 20 retries.
- **FAIL-86** chad puts no bound on the length of a turn. A model that keeps streaming never times out, a running script stops clanka's clock, and the retry count starts again after each call that succeeds. The owner has Stop.
- **FAIL-212** `ErrorRetry` parts that arrive while a login is pending for the session do not count toward the three in FAIL-84, and the count starts again from zero when the login completes (see 05-model-and-login.md).

The count of FAIL-81 and the count of FAIL-84 are two counters. The first counts every `ErrorRetry` part of one agent since that agent's last `Usage` part and only feeds the status line. The second counts turn timeouts in a row on one model call and ends the turn.

The costs, stated plainly. A model call whose errors come back fast is retried for about 11 minutes before the turn fails. A call to a provider that accepts the connection and never answers costs about 15 minutes. Without FAIL-84 that call cost about 117 minutes on a virtual clock, and a message the owner sends in that thread is not read until the call returns. Both are per model call. An unattended turn has nobody to press Stop. One more thing clanka does is visible later. Each retry after an `InvalidOutputError` or a `ToolNotFoundError` leaves a user message "There was an error, please try again" in the history.

## A usage limit

A usage limit is the model provider saying that the login's plan has no usage left until a reset time. clanka does not know the case. Unhandled, it arrives as a retryable error, clanka retries it for about 11 minutes, and the turn ends as a generic model error.

- **FAIL-87** chad ends the turn at the first `ErrorRetry` part or final error that it recognises as a usage limit, as `Failed` with `UsageLimit`. It interrupts the `send` itself, because clanka would retry.
- **FAIL-88** chad recognises a usage limit by the error's metadata saying `usage_limit_reached`, or by the error's code being `insufficient_quota`, `credit_balance_exhausted` or `organization_spend_limit_exceeded`. Where the metadata sits on each transport is in the table below. The three codes end as `UsageLimit` with no reset time.
- **FAIL-89** An error of type `usage_not_included` ends the turn at once as `ModelError` with its message.
- **FAIL-90** A reset time is printed only when the error carried one, which only an HTTP body does.
- **FAIL-91** chad does not move to another model by itself.
- **FAIL-92** chad makes no second request, over HTTP or otherwise, to classify a failure.
- **FAIL-93** chad keeps no "limit in force" state. Every turn tries, and one refused request per unattended turn costs nothing.
- **FAIL-94** "The last model call hit the usage limit" is a standing condition with the key `usage-limit`. The next model call that succeeds clears it, and so does a login that succeeds. It sends its one notice when no owner was present in the turn that hit the limit (see "Notices outside a turn").

| Transport | What chad matches | Reset time |
| --- | --- | --- |
| WebSocket, the transport v1 runs on | `reason.metadata.type === "usage_limit_reached"`, on a `RateLimitError` or an `InternalProviderError` | Never arrives. effect's decoder drops `resets_at` |
| HTTP | `reason.metadata.openai.errorType === "usage_limit_reached"` | In the raw body, as `resets_at` in epoch seconds |
| Either | The code `insufficient_quota`, `credit_balance_exhausted` or `organization_spend_limit_exceeded` | None |
| API key path | effect's `QuotaExhaustedError`, which clanka does not retry | Not stated |

What v1 does not handle. Nobody has captured a usage-limit frame from the real Codex service, and three shapes are not recognised.

- **FAIL-95** effect's WebSocket decoder drops an error frame that has no `error.message`, and the call keeps waiting. That is the shape in the Codex CLI's own test. If the real service sends it, a usage limit shows as a turn that retries on the turn timeout and ends as `ModelError` after 15 minutes, by FAIL-84.
- **FAIL-96** A WebSocket handshake that is refused with 429 reaches chad as a retryable `NetworkError` with the status and the body lost, so chad cannot recognise it. The socket idles out after 60 seconds, so most chat turns open a new connection.
- **FAIL-97** On the WebSocket transport the owner's message never names a reset time.

## The turns table and usage

The `turns` table has one row per turn and is never pruned (see 02-storage.md, which holds the SQL and the rules for the row as the record of which requests have run). The columns are listed here because the failure reason and the usage numbers are what the owner and the `diagnose` skill read.

| Column | Holds |
| --- | --- |
| `request_key` | The key of the stored request that asked for the turn. Primary key. |
| `turn_id` | The first attempt's turn id |
| `session_id` | The session the turn ran in |
| `origin` | `message` or `plugin` |
| `origin_plugin` | The plugin that started the turn |
| `origin_label` | The label the plugin gave the turn |
| `started_at` | When the turn started |
| `ended_at` | When it ended. Null while it runs |
| `outcome` | Null while it runs, then `answered`, `failed` or `stopped` |
| `failure` | The reason tag of a failed turn |
| `failure_detail` | The reason as JSON |
| `status_message_id` | The id of the turn's status message |
| `starts` | How many times chad started the turn |
| `graceful_cuts` | How many of those starts a graceful stop cut |
| `model` | The model value the turn's Agent was built with on the last attempt, as `<provider>/<model>[/<effort>]` |
| `input_tokens` | clanka's `inputTokens` |
| `output_tokens` | clanka's `outputTokens` |
| `cache_read_tokens` | clanka's `cacheRead` |
| `cache_write_tokens` | clanka's `cacheWrite` |
| `context_tokens` | clanka's `contextTokens`, the input size of the latest model call |

- **FAIL-99** The `turns` table has the columns in the table above.
- **FAIL-100** Times are integer milliseconds since the epoch. The `diagnose` skill's queries depend on it.
- **FAIL-101** The table has an index on `started_at` and one on `(session_id, started_at)`, because it is never pruned and `chad status` reads it.
- **FAIL-102** `model` is the model value that the turn's Agent was built with on the turn's last attempt, in the full `<provider>/<model>[/<effort>]` form (see 02-storage.md and 05-model-and-login.md). A sub-agent that ran on another model is inside the same token totals.
- **FAIL-103** (a) The usage columns hold the turn's totals (b) across all its attempts, (a) sub-agents included.
- **FAIL-104** chad writes the usage columns on every `Usage` part, so a turn that is killed keeps what it had used, and a resumed attempt adds to what the row holds. The four counters in a part are running totals for the current `send`, so what chad writes is the total of the earlier attempts plus the latest part's values, and it never adds one part to the part before it. `context_tokens` is the latest part's value and never a sum.
- **FAIL-105** `output_tokens` includes reasoning tokens, so the total is right and only the split between reasoning and visible output is missing.
- **FAIL-106** The tokens used by the summarizer that compacts a history are not counted anywhere. This is a known gap in v1.
- **FAIL-107** v1 works out no cost. A Codex login has no price per token, and neither clanka nor effect has price data. The row keeps the tokens and the model id, so anything that has prices can work a cost out later.
- **FAIL-108** (a) There is no `chad turns` command. (b) `chad db query` reads the table with no daemon (see 10-cli.md), and (c) the `diagnose` skill carries the queries.

How clanka reports usage. Its stream has one part with token counts, `Usage { contextTokens, inputTokens, outputTokens, cacheRead, cacheWrite }`, sent once per model call. The four counters are running totals for the current `send` and start at zero on each `send`, and a sub-agent's tokens are added into its parent's totals. A model call that fails before it finishes sends no `Usage`.

## chad status and /status

What `chad status` prints about the daemon, the plugins, the MCP servers, the model and the connections is in 10-cli.md. This part adds two blocks to it. `/status` matters most here, because it is what the owner has in chat when the model is down.

- **FAIL-109** `/status` runs the same daemon call as `chad status`, prints the same text, and does not go through the model.
- **FAIL-110** `chad status` and `/status` show two blocks, "Problems" and "Recent".
- **FAIL-111** `/status` renders with no database and no model.
- **FAIL-112** "Problems" comes first. It lists every standing condition once. A live key is shown from the daemon's own check (FAIL-213) and a table key from its held row (FAIL-308). The two classes are in "Notices outside a turn".
- **FAIL-113** "Problems" also lists two things that have no key and no notice. These are a chat connection that is not connected and timers held for a plugin that is not loaded. Timers held for a plugin the owner turned off, or for a plugin deleted from the repo, are not listed here. `chad status` shows them with the plugin (see 11-settings.md).
- **FAIL-114** (a) "Recent" shows the failed turns of the last 24 hours grouped by reason, the last five failed turns with their ids, the tokens used today and in the last 7 days, and when the daemon started. (b) Withdrawn. (a) Grouping by reason keeps two real failures visible on a day when 24 scheduled runs were skipped because chad was logged out.
- **FAIL-115** "Today" is the current day in the owner's timezone.
- **FAIL-116** Anything finer than the two blocks is read with `chad db query`.
- **FAIL-117** `chad status` shows, for each plugin, its count of warnings and of errors logged since it loaded, with the latest line. The count rests on the copies in FAIL-30, which carry the plugin's name from every place in FAIL-27.
- **FAIL-343** `chad status` gives each loaded plugin a line of its own after the connections, which reads "plugin: <name>, <warnings> warnings, <errors> errors" and ends with " (latest: <line>)" once the plugin has logged a warning or an error. `chad status --json` carries the same counts as `plugins`, and a plugin that was skipped has no line of counts (see FAIL-344).
- **FAIL-344** `chad status` gives each plugin skipped at boot a line after the loaded plugins' lines, which reads "plugin: <name>, skipped (<first line of the error>)". `chad status --json` carries them as `skipped`, each with its `name` and `reason`.
- **FAIL-118** A plugin's start-up warnings, such as the asphodel plugin finding its daemon unreachable, stay log lines that carry the plugin's name. They get no notice of their own, and there is no API through which a plugin notifies the owner. The failing-hook notice covers the case that lasts.
- **FAIL-213** For a live key, "Problems" shows the condition from the daemon's own check, once each, and never reads the key's row. The row only decides whether a notice is sent. That is how `/status` shows these conditions with no database.
- **FAIL-333** "Problems" and "Recent" come after the facts `chad status` already prints, each as a heading on its own line after a blank line, then one fact to a line. "Problems" says "none" when it has nothing. "Recent" has a line with the failed turns of the last 24 hours as a count for each reason, a line for each of the last five failed turns with its id, its reason and when it ended, a line with the tokens used today and in the last 7 days, and a line with when the daemon started. Times are in UTC. When the `turns` table cannot be read, "Recent" says so in one line and the rest of the answer is as it would be. `chad status --json` carries the same as `problems`, `recent` and `started`.
- **FAIL-334** Before a timezone is stored, "today" in "Recent" is the current day in the zone `TZ` names, or in UTC (IMG-27).

| "Problems" lists | Source |
| --- | --- |
| Every live key whose condition holds, an unusable database included | The daemon's own check, from memory or from files (FAIL-213) |
| Every table key whose row says the condition holds, with the time the row was recorded | The `notices` table (FAIL-308, FAIL-320) |
| A one-off notice that could not be delivered | The `notices` table (FAIL-313) |
| A chat connection that is not connected | The daemon's memory. It is the one failure that can never reach the owner in Discord |
| Timers held for a plugin that is not loaded, unless the owner turned it off or it was deleted from the repo | See 13-timers-and-cron.md and 11-settings.md |

## The history reconcile

chad stores a session's history as clanka appends it, one write per `HistoryAppended` event, in the fiber that consumes the turn's stream (see 03-sessions-and-turns.md). A Stop interrupts that fiber. In a probe with a writer slowed to 400 ms, the Agent held three finished steps after a Stop and the store held one message. The Agent's memory is what the next turn sends to the model, so the store and the Agent would disagree after the next restart.

- **FAIL-119** At the end of every turn, however it ends, chad makes the stored history equal to the Agent's history. It does this before it records the turn's end.
- **FAIL-120** The compare covers the session's whole history, not only the part the turn added.
- **FAIL-121** When the reconcile finds a `HistoryReplaced` that the stream did not deliver, chad replaces the stored history and runs the `Compacted` session event as that turn's, so a plugin does not miss a compaction.
- **FAIL-122** The reconcile runs in a region that neither Stop nor a graceful stop can interrupt.
- **FAIL-123** The turn's end line carries the number of messages the reconcile wrote, on every turn.
- **FAIL-214** The reconcile writes a log line of its own, the event `history.reconciled`, only when it wrote at least one message, so the log shows that a gap existed. A line that says it wrote nothing on every turn would be noise.
- **FAIL-327** A turn that a graceful stop cuts runs the reconcile too, in the region that records the graceful cut, which nothing interrupts, so every step its Agent finished is in the stored history at the next start. Its request stays unanswered.
- **FAIL-124** After a kill there is no Agent to compare with, and the stored history is what there is. clanka persists nothing itself.

What a cut turn leaves in the history, from the probes. After a Stop during a turn's fourth script, the Agent's history holds the prompt and the three finished steps and nothing from the fourth, and the next `send` gives the model all three. The same holds after `RetriesExhausted`. A script's call and its result are appended together when the script finishes, so a script that was cut leaves no trace, and the output it had printed so far is lost.

## What the model is told about chad's own posts

A failed-turn message, a "Stopped" line and a notice are chad's posts and are not in the session's history. Without more, an owner's "why did that fail?" would mean nothing to the model. The model does keep the steps that finished, so it does not redo them. What it lacks is what chad posted.

- **FAIL-125** The next turn in a session starts with one update message that tells the model what chad posted in that session's thread. It uses the mechanism a changed prompt chunk uses (see 03-sessions-and-turns.md and 06-plugin-api.md), and the system prompt is untouched, so the prompt cache holds.
- **FAIL-126** When a chunk change is due on the same turn, both go in the one update message.
- **FAIL-127** The message covers every turn in the session since the last one that ended `Answered`. The latest is given in full, with its id, how it ended and the reason. The others are given as a count per reason, such as "6 scheduled runs were skipped: logged out".
- **FAIL-128** The message also lists any notices chad posted in the thread since.
- **FAIL-129** An `Answered` turn whose answer could not be posted counts as a turn to tell the model about, because the model thinks the owner read the answer.
- **FAIL-130** For a turn that ended `Stopped`, or `Failed` with `GaveUp` or `Internal`, the message adds that the steps before the cut are in the history above, and that the step that was running was cut and may have partly run. For `ModelError`, `UsageLimit`, `LoginFailed` and `LoggedOut` no step was running, and the sentence is left out.
- **FAIL-131** The lines waiting to be told live in the database table `session_updates`, per session, and are cleared when a turn's history holds them. They survive passivation, so an owner who asks two hours later still gets them. The table's SQL is in 02-storage.md.
- **FAIL-215** chad deletes a session's `session_updates` rows in the same transaction that writes the history that holds them. A crash between two separate writes would lose the update or tell it twice.
- **FAIL-132** After an `Answered` turn with no notices since, nothing is added.
- **FAIL-332** The update message is a user message that goes ahead of the owner's message in the same send. It opens with `<environment-update>` and the heading "What chad posted in this thread". It gives the latest turn as "Your last turn, <id>, <how it ended>.", then the sentence of FAIL-130 when it applies, then "Before it, since the last answer the owner read:" with a count for each way the older turns ended, then the notices, one to a line.

## A full disk

chad enters no special mode when the disk fills. Each event is tried, and the rules below say what happens to one whose write fails. SQLite reports a full database as an error with `code: "ERR_SQLITE_ERROR"`, `errcode: 13` and `errstr: "database or disk is full"`, called SQLite's full error here.

- **FAIL-133** The free space check runs at boot and then hourly. How it reads free space is in 02-storage.md.
- **FAIL-134** The check has one threshold and one notice. Below 1 GB free the condition `disk-low` begins, and it clears when a check finds 1 GB or more.
- **FAIL-135** chad enters no special mode on a full disk. A write that fails during a turn because the volume is full fails like any other write of chad's. The turn ends as `Failed` with `Internal` and gets the ordinary failed-turn message. If its end cannot be written, a restart treats the turn as one cut by a crash (see 03-sessions-and-turns.md).
- **FAIL-136** When the disk is full as an owner's message arrives, saving the request fails with a typed error and no turn runs. chad answers in the thread, "The data volume is full, so I stopped. Free some space and send that again.", and accepts the chat event once the reply is posted, so the event is not replayed and the message does not run later by itself.
- **FAIL-137** If that reply cannot be posted either, chad refuses the event. A refused event is not held for a restart. dfx reconnects and resumes in the same process after 1 second, doubling to 2 minutes, and holds back later events on the shard until the event is accepted.
- **FAIL-140** A turn's own writes come before the reply to cluster. A reply that cannot be saved is silent in cluster, so chad's own failed write is the only signal.
- **FAIL-141** Nothing in chad learns a turn's end from cluster's reply alone. The session's own in-memory end resolves anything waiting in the same process. That is the timer handler that saves a job's next run, and a plugin's `Turns.start`.
- **FAIL-216** A write of chad's fails on a full disk when it fails with SQLite's full error, or when a file write of chad's fails with `ENOSPC`. On a truly full filesystem the writes under `state/` and to the inbox fail first.
- **FAIL-219** The reply in FAIL-136 has no turn id line, because no turn exists.
- **FAIL-340** The 1 GB of the free space check (FAIL-134) is 1024³ bytes, the binary unit in which the `disk-low` notice gives its megabytes.

What cluster does there, from a run on `SingleRunner` over SQLite with a real "database or disk is full" error forced by a page cap.

- When saving a reply fails, cluster tries 5 times, 200 ms apart, and gives up. Nothing is logged, and the caller gets neither a reply nor an error.
- The request stays unprocessed. It is not delivered again when space returns, at the storage polls, or after 13 minutes. Sending the same key again in that process hangs. Other requests to the same entity work.
- Only a restart delivers it again, and then the handler runs a second time.
- When the database is full at the time a request is sent, the sender gets a typed `PersistenceError` at once and nothing is stored.

Three things about a full disk have not run at all. chad's handling of a full disk has not run. The full error in the cluster run came from a page cap and not from a full filesystem. On a truly full filesystem the write-ahead log cannot grow, the renames under `state/` fail, the log file fails, and an apply's commit and export fail part way.

## An unusable database

Two detections stand next to each other, and each has its own outcome.

- **FAIL-146** An image that finds a `state/version` newer than its own exits 1 with the exit message that 02-storage.md gives. It holds the lock by then, so its `boot.refused` line goes to both sinks (FAIL-322), and it has touched nothing else on the volume. The message names the copy of the database that was taken before the migration.
- **FAIL-147** A database that cannot be opened or migrated for any other reason, such as a corrupt file or a migration the image does not know in a restored file, keeps chad up without sessions. chad connects to Discord from `secrets/connections.json` (see 02-storage.md).
- **FAIL-148** In that state chad answers every owner message that is a direct message or mentions chad (FAIL-339) with "chad's database can't be used: <error>. Sessions are off until it is fixed. `chad status` has the detail." `chad status` shows the same error.
- **FAIL-149** At boot in that state chad sends the same text, without waiting for an owner's message, to the thread recorded in `state/notice-thread` (FAIL-159). It sends it once for as long as the database stays unusable, restarts included.
- **FAIL-225** chad writes the file `state/db-unusable` when it sends that notice, and a boot that finds the file does not send the notice again. A crash loop on an unusable database would otherwise post the same message at every restart.
- **FAIL-226** A boot that opens and migrates the database removes `state/db-unusable`.
- **FAIL-227** Only when `state/db-unusable` cannot be written does chad fall back to sending the notice once per boot.
- **FAIL-228** While the database is unusable chad sends only the database notice. Every other live key shows under "Problems" and sends no notice, because no row can record that a notice was sent and every boot would otherwise send every held notice again.
- **FAIL-339** While the database is unusable, an owner's message gets the answer of FAIL-148 when it is in a direct message or mentions chad, and a mention in a plain channel is answered there without opening a thread. A message that does not mention chad, in a thread or in a plain channel, gets no answer, because which threads are sessions is recorded in the database.

## Notices outside a turn

A notice outside a turn is a message chad sends the owner that belongs to no turn, such as a skipped plugin. Two kinds exist. A notice about a condition reports something that holds for a while, such as a low disk, and is sent once. A one-off notice reports something that happened, such as a job being paused, and is sent every time it happens.

- **FAIL-150** Every notice about a condition has a key that names the condition. chad sends the notice when the condition begins and does not send it again while the condition holds, restarts included. A plugin that is skipped at every boot is announced once.
- **FAIL-151** When a condition clears, chad sends no "cleared" notice. It keeps the key's row with the time the notice was last sent.
- **FAIL-152** A condition that begins again within 24 hours of its last notice is not announced again. A hook that fails three times, works once and fails three more would otherwise post on every cycle.
- **FAIL-153** The keys live in the database table `notices`. Its SQL is in 02-storage.md.
- **FAIL-154** chad sends no reminders. `chad status` is the list of what is wrong now.
- **FAIL-155** A one-off notice has no key and is posted every time. The one-off notices are a turn that failed with `ThreadGone`, a paused cron job and a changed bundled skill (FAIL-167). The hash under `state/` already limits the last to once per change (see 12-skills-and-mcp.md).
- **FAIL-156** A notice outside a turn is a normal message and not subtext, because it is the content and not a footnote. In a server thread it starts with the owner's mention, as a cron job's answer does. In a DM every message notifies. It contains no emoji.
- **FAIL-337** The owner's mention of FAIL-156 is a mention of each owner on the list of the connection that posts the notice, and only those users are let be notified by it. On the `local` platform, which has no mentions, the notice is its text alone.
- **FAIL-157** (a) Subtext stays for lines inside a turn's flow, which are the status message, "Stopped after 48s.", the turn id line and the session line in FAIL-176. (b) Withdrawn.
- **FAIL-158** A notice outside a turn goes to the owner's most recently active DM session. If there is none, it goes to the most recent session of any kind. It is always logged as well.
- **FAIL-159** chad writes that destination to the file `state/notice-thread` whenever an owner's message changes it. The file is one JSON line with the connection's name and the thread, written by temp file and rename like the other files under `state/`, and its shape is in 02-storage.md. It lets a boot with an unusable database tell the owner without waiting for a message.
- **FAIL-160** When chad knows no session, as on a fresh volume, or when the post fails twice, the notice is logged as `notice.undelivered` and its row records that it was not delivered. If its condition still holds when a session first exists, chad posts it then. What "Problems" shows for it is in FAIL-313.
- **FAIL-338** chad knows a session for FAIL-160 once `state/notice-thread` names a thread or an owner's message has arrived. A volume whose sessions are older than the file gets its destination from the owner's next message, and chad does not search the `sessions` table for one.
- **FAIL-341** A destination that `state/notice-thread` restored, and whose kind no session row gives, keeps its place against an owner's message in a server thread until its platform says that it is not a direct message. A platform that cannot say, or has not answered while the message waits for it, leaves the kind unknown, and the next owner's message or notice asks again. A notice to a destination of unknown kind is posted as one outside a direct message.
- **FAIL-229** The `notices` table answers five things about a key. They are whether the condition holds now, when the row was recorded as holding, when its notice was last sent, whether that send was delivered, and the notice's text. "Problems" prints the stored text and the recorded time for a table key only (FAIL-308, FAIL-320).
- **FAIL-230** A key whose row cannot be written, as on a full disk, is held in memory and written when a write next succeeds.
- **FAIL-231** "Most recently active" in FAIL-158 is measured by the owner's latest message, whether it started a turn, steered one or was a chat command, so a scheduled run does not move the destination (see 09-repo-and-recovery.md).
- **FAIL-232** The file `state/notice-thread` alone is enough to post a notice with no database. Its thread is the thread string that the `sessions` row stores (see 03-sessions-and-turns.md). The shape cannot change freely later, because the file is read after an upgrade whose migration failed.

The keys, with the class of each, what begins each condition and the check that clears it. The two classes are defined in FAIL-307.

| Key | Class | The condition begins when | The key is cleared when |
| --- | --- | --- | --- |
| `disk-low` | Live | The free space check finds less than 1 GB | A check finds 1 GB or more |
| `logged-out` | Live | A turn with no owner present finds chad logged out, or a plugin-started turn ends as `LoginFailed` | A login succeeds, or a model call succeeds |
| `usage-limit` | Table | A model call hits the usage limit | The next model call succeeds, or a login succeeds |
| `plugin-skipped:<name>` | Live | The plugin is skipped at boot | The plugin loads, is no longer in the applied repo, or is turned off |
| `hook-failing:<plugin>:<hook>` | Live | The same hook has failed 3 times in a row | The hook next succeeds |
| `settings-unparsable` | Live | `chad.json` cannot be parsed at boot | The next boot or apply finds the file good or gone |
| `settings-ignored` | Live | Entries in `chad.json` are ignored at boot | The next boot or apply finds no ignored entry, or the file gone |
| `mcp-config-unreadable` | Live | `mcp.json` cannot be read at boot | The next boot or apply finds the file good or gone |
| `skill-skipped:<name>` | Live | The skill is skipped at boot | The next boot or apply finds the skill good or gone |
| `model-check-failed` | Live | A model fails its check at start | The next boot's check passes, `/model` changes the model, or a model call succeeds |
| `database-unusable` | Live | A boot cannot open or migrate the database | A boot opens and migrates the database |
| `prune-failed` | Table | The nightly prune fails | The next prune succeeds |

- **FAIL-233** The notices in FAIL-164 to FAIL-166 and FAIL-168 are notices about a condition. Their keys are `settings-unparsable`, `settings-ignored`, `mcp-config-unreadable`, `skill-skipped:<name>` and `model-check-failed`.
- **FAIL-234** Each of the first four of those keys is cleared by the next boot or apply that finds the file or the skill good or gone. `model-check-failed` is cleared by the next boot whose check passes.
- **FAIL-235** `model-check-failed` also clears when `/model` changes the model or a model call succeeds. "Problems" would otherwise show a failed check for a model nobody is using until the next restart.
- **FAIL-236** `settings-ignored` is one key for all ignored entries. A new ignored entry added while an older one stands is not announced, which is accepted because the apply's own output lists what was ignored (see 11-settings.md).
- **FAIL-237** The `logged-out` condition is cleared by a login that succeeds or by the next model call that succeeds.
- **FAIL-307** Each key is of one of two classes, and the table above names the class. A live key is one whose condition the running daemon can answer from memory or from files. A table key records something that only its row remembers.
- **FAIL-308** For a table key the held row is the answer. "Problems" lists the key while its row says the condition holds, with the row's text.
- **FAIL-309** With no database "Problems" shows the live keys only, and `database-unusable` is one of them.
- **FAIL-310** One renderer per key produces the text, and both the notice and the line under "Problems" print it.
- **FAIL-311** An unusable database is the condition of the live key `database-unusable`. Its notice is the message of FAIL-149, and the file `state/db-unusable` takes the place of its row, because the `notices` table is in that database (FAIL-225 to FAIL-227).
- **FAIL-312** A nightly prune that fails begins the condition `prune-failed`, which is a table key, and the next prune that succeeds clears it (see 02-storage.md for the prune).
- **FAIL-313** A one-off notice that could not be delivered is kept as a held row of the `notices` table under a table key, and "Problems" lists it from that row. A keyed notice that could not be delivered gets no line of its own, because "Problems" already shows its condition.
- **FAIL-319** `usage-limit` is a table key. A restarted daemon cannot tell from memory or from files that the last model call hit the usage limit, so only the row remembers it.
- **FAIL-320** The line "Problems" prints for a table key says when the row was recorded, which is the time chad wrote the row as holding. The held row may describe something that has already passed, as on an idle chad whose usage limit has lifted with no model call made since, and the time lets the owner judge that. The row keeps this time apart from the time its notice was last sent, because a condition can begin with no notice sent, as `usage-limit` does when an owner was present (FAIL-94) and as any condition does within 24 hours of its last notice (FAIL-152).
- **FAIL-336** The line "Problems" prints for a table key is the row's text followed by `(recorded <time>)`, with the time in UTC to the second as `YYYY-MM-DDTHH:MM:SSZ`.
- **FAIL-321** The `usage-limit` line under "Problems" also prints the reset time when its row holds one. On the WebSocket transport, which v1 runs on, the error carries no reset time (FAIL-97), so there the line has the recorded time only.
- **FAIL-342** The `usage-limit` row keeps a reset time in its text, which is the one renderer's (FAIL-310): after the text of FAIL-174 comes "It resets at <time>.", with `<time>` in UTC to the second as the recorded time is printed. A turn that hits the limit while the row already holds writes the text of its own error, with its reset time or none, and leaves the recorded time as it was (FAIL-320).
- **FAIL-315** `plugin-skipped:<name>` clears when the plugin loads, when it is no longer in the applied repo, and when the plugin is turned off (see 11-settings.md).

The wordings. Text in angle brackets is filled in. "First line" is the first line of an error.

- **FAIL-161** Plugins skipped at boot get one notice with one line per plugin, "Skipped at start: `<name>` (<first line of the error>)", ending with the line "`chad status` has the rest."
- **FAIL-318** When a plugin is skipped because its file or directory name breaks the plugin name rule, the line of FAIL-161 quotes the name as it is written and cuts it, because it is the one name that broke the rule (see 07-plugin-loading.md).
- **FAIL-163** After 3 failures in a row of the same hook, chad tells the owner with "`<plugin>`'s `<hook>` hook has failed 3 times in a row (<first line>). It stays on." chad never turns a plugin off by itself.
- **FAIL-164** A `chad.json` that cannot be parsed at boot is announced with "`chad.json` can't be parsed (<error>), so every plugin is on its defaults." Entries that were ignored are announced with "Ignored in `chad.json`: <list>." A `plugins` value that is not an object is listed there as the `plugins` key, and a plugin's entry whose `enabled` is not a boolean is listed as that entry (see 11-settings.md).
- **FAIL-165** An `mcp.json` that cannot be read at boot is announced with "`mcp.json` can't be read (<error>), so no MCP servers are running."
- **FAIL-166** A skill skipped at boot is announced with "Skipped skill `<name>`: <error>."
- **FAIL-167** A bundled skill that changed in a new image while a repo skill hides it is announced with "The bundled skill `<name>` changed in this image. The repo's copy still hides it." (see 12-skills-and-mcp.md).
- **FAIL-168** A model that fails its check at start is announced with "The model `<spec>` failed its check at start (<error>). If turns fail, set another with `/model`." The check can fail on an outage that passes, and chad still starts. Which models are checked is in 05-model-and-login.md.
- **FAIL-171** The `disk-low` notice reads "The data volume has <n> MB free."
- **FAIL-173** When a plugin-started turn fails with `ThreadGone`, the core posts "`<plugin>` could not run `<label>` because its thread is gone."
- **FAIL-174** The `usage-limit` notice, sent when no owner was present, reads "This login has reached its usage limit. Scheduled runs are skipped until it resets."
- **FAIL-175** The `logged-out` notice reads "chad is logged out. Send a message or run `chad login`. Scheduled runs are skipped until then." Until a login succeeds, turns with no owner present fail without calling clanka (see 05-model-and-login.md).

A command that changes chad leaves a line in the thread of the session it ran from, so the owner sees that chad changed itself.

- **FAIL-176** A command run from a session that changes what is loaded or deletes stored data posts one subtext line in that session's thread. The commands are `apply`, `revert`, `safe on` and `safe off`, `plugin purge`, `secret rm` and `timezone`.
- **FAIL-177** For an apply the line is "Applied `<sha>`: <first line of the `-m` message>".
- **FAIL-178** The same command run from the owner's shell posts nothing.
- **FAIL-179** A command that failed and changed nothing posts nothing, because the agent has the error.
- **FAIL-238** A reload that is not an apply, and that exits 1 because some plugins failed to build while the others swapped, still posts the line, and the line names the plugins that were kept on their previous version (see 08-apply-and-swap.md).
- **FAIL-345** For `chad timezone` the line is "Timezone set to <zone>.", and when some plugins kept their previous version it goes on "Still on the previous timezone: <plugin names>."
- **FAIL-346** For `chad secret rm` the line is "Secret <NAME> removed.", and when some plugins kept their previous version it goes on "Still on the previous secret: <plugin names>."
- **FAIL-180** The post is forked into the daemon's scope and the command does not wait for it (see 10-cli.md).

## What stays in the log only

- **FAIL-181** Four things produce log lines and no notice. They are a handler or hook that did not stop when a swap interrupted it, two versions of a plugin overlapping, hooks dropped in a swap or a stop, and a stop cut by chad's deadline (see 08-apply-and-swap.md and 01-image-and-volume.md).
- **FAIL-182** A single hook that fails, dies or runs past its budget is logged and skipped, and the turn carries on. Only the third failure in a row reaches the owner (see 06-plugin-api.md).

## The diagnose skill

- **FAIL-183** chad ships a third bundled skill, `diagnose`, next to `self-edit` and `credentials` (see 14-self-edit-skill.md and 15-credentials.md).
- **FAIL-184** The skill teaches the agent to answer "why did that fail?" with `chad logs --turn`, `chad status` and `chad db query` recipes over the `turns` table. The recipes stand in for a `chad turns` command.
- **FAIL-185** CI runs each recipe against a freshly migrated database, and the skill gets the same checks as the other two bundled skills (see 17-testing.md).

## Follow-ups outside chad

v1 does not wait for any of these. The build takes a fix if the effect snapshot it pins already has it. Tim ruled in chat on 2026-11-15 that only the first, FAIL-186, is fixed upstream, and that the other three are left alone. The fix is "Fix effect's OpenAI WebSocket client dropping error frames and resets_at" (TIM-566).

- **FAIL-186** effect's OpenAI WebSocket decoder drops an error frame that has no `error.message`, and drops `resets_at`. Both are follow-ups for effect.
- **FAIL-187** effect's cluster gives up on a reply it cannot save without a log line. This is a follow-up for effect.
- **FAIL-188** clanka's `Usage` part does not count the summarizer's tokens. This is a follow-up for clanka.
- **FAIL-239** clanka's `ErrorRetry` part carries no typed marker for its turn timeout, so chad matches it in the predicate of FAIL-204. A typed marker is a follow-up for clanka.

FAIL-187, FAIL-188 and FAIL-239 are not raised as issues, and chad keeps what it does about each.

## What this part changes in what Tim agreed himself

Tim has not read the decisions in this part. Eleven of them change something he agreed in person, and so does one decision in 04-discord.md that rests on the same reasoning. He handed the question of whether they stand to Jarvis on 2026-11-15, and Jarvis kept them all. There was a thirteenth then, the second free space notice, which Tim's ruling on a full disk of the same day took out. Anything he disagrees with reopens that point. The rulings made since added smaller differences, and the Provenance table marks every such rule in its "Changed by" column.

1. chad ends a model call after 15 minutes of silence (FAIL-84). Tim agreed that chad adds no turn timeout of its own in v1, before anyone knew that a silent call costs about 117 minutes. This is a bound on silence and not on a turn, but it is close.
2. `chad logs` exists (FAIL-38). Tim ruled a `logs` command out of v1. His own later change removed the status message at the end of a turn, which left the log as the only record of a failed turn.
3. In a server thread the failed-turn message is a reply with the ping on, and it gains the turn id line (FAIL-66, FAIL-65).
4. The retry line in the status message names the cause and the count (FAIL-80).
5. The give-up message says "crash" where it said "restart" (FAIL-63).
6. Notices outside a turn are normal messages with the owner's mention, where he agreed that notices use subtext (FAIL-156).
7. The logged-out notice gains the sentence "Scheduled runs are skipped until then." (FAIL-175).
8. For cron, three kinds of failure do not count against a job, and `GaveUp` pauses a job at once (FAIL-74, FAIL-77).
9. History is also reconciled at the end of a turn, and a session's next turn can start with an update message about what chad posted (FAIL-119, FAIL-125).
10. Script source and output go to stdout, so they go wherever the container's logs are shipped (FAIL-9). It follows from his ruling that nothing is redacted, but it is the one consequence of that ruling he may not have pictured.
11. The give-up message and the two login messages are normal messages, where he agreed that they are notices in subtext (FAIL-208).
12. The message chad posts when it cannot open a thread on a mention is a normal message too, where he agreed that notices use subtext. The rule is in 04-discord.md.

## Gaps

- **FAIL-G5** [builder] The predicate that tells clanka's turn timeout from another error in an `ErrorRetry` part (FAIL-204). TIM-557 item 18 came closest. In the probe the last error of a silent call was an `UnknownError` with the text "TurnTimeout was reached".
- **FAIL-G10** [builder] How `-f` notices a rotation, and what it does with a torn line. TIM-557 item 11.
- **FAIL-G12** [builder] How the session id, turn id and plugin name are merged into the formatted line. effect's formatters read annotations from the fiber, and the probes did not run the copy with ids. TIM-557 item 8.
- **FAIL-G13** [builder] The names of the two references in the logger, and the window after which lines below Error are written to the file. The probes used a 1 second window. TIM-557 item 10.
- **FAIL-G14** [builder] What the `mcp` and `command` annotation keys hold, and the names of the other annotation fields each event carries, such as the duration and the usage on a turn's end. TIM-557 item 2 lists the six keys without defining them. The closest reading is the MCP server's name and the CLI command's name.
- **FAIL-G15** [builder] Whether the copy of a line logged from a sub-agent or from an MCP call carries the right session, turn and plugin name. The probes ran neither. TIM-557 item 8.
- **FAIL-G16** [builder] The format of the human line `chad logs` prints. TIM-557 item 11.
- **FAIL-G17** [builder] The wording of the update message in FAIL-125, and the wording of the session line in FAIL-176 for every command but `apply`. TIM-557 "Not settled here". FAIL-345 and FAIL-346 settle the lines of `chad timezone` and `chad secret rm`.
- **FAIL-G18** [builder] The layout and text of the "Problems" and "Recent" blocks, and what "today" is before a timezone is set. TIM-557 item 27 and TIM-548 "Not settled here". FAIL-334 settles what "today" is.
- **FAIL-G19** [builder] Small wordings. The notice for a repo plugin skipped because a bundled plugin took its name has no text (TIM-548 item 12). The logged-out notice's two sentences are joined here with a full stop that no ticket writes (TIM-535, TIM-557 item 40). The rounding of `<n> MB` is not given, and neither is whether cron's pause line is subtext (TIM-557 item 40).
- **FAIL-G21** [builder] The text of the `diagnose` skill and its `chad db query` recipes. TIM-557 item 43 names what it teaches and nothing more.
- **FAIL-G22** [builder] Whether the real Codex service sends an `error.message` with a usage limit, and what a new connection gets while the limit is in force. Only the two live captures in FAIL-98 can answer it. TIM-557 "Not settled here".
- **FAIL-G26** [builder] The contents of `state/db-unusable`. FAIL-225 to FAIL-227 read only whether the file exists.
- **FAIL-G27** [builder] The text of the `prune-failed` condition, and the key under which a one-off notice that could not be delivered is kept (FAIL-313), with the check that clears its row. TIM-559 round 3 C5 names both as things only a row remembers and gives no more.
- **FAIL-G28** [builder] The length at which the plugin's name is cut in the notice of FAIL-318. TIM-559 round 3 A2.
- **FAIL-G29** [builder] Whether the `usage-limit` row keeps a reset time when the error carried one, and whether a model call that hits the limit while the condition already holds moves the recorded time (FAIL-320, FAIL-321). TIM-559 round 4 item 9 prints the reset time "if the row holds one", and the `notices` row in 02-storage.md has no place for one.
- **FAIL-G30** [builder] Whether a resumed start writes `turn.started` as well as `turn.resumed`, and what the delivery that gives up writes before `turn.failed` (FAIL-12, FAIL-244, FAIL-253). `chad logs --event` and the `diagnose` recipes read these names. Recommended: `turn.started` on the first start only, `turn.resumed` on each later start, and only `turn.failed` on the delivery that gives up.
- **FAIL-G31** [builder] What the three `chat.` events carry (FAIL-298 to FAIL-300). It is not said whether a close for good writes `chat.disconnected` as well as `chat.refused`, whether a close that chad or dfx starts itself writes `chat.disconnected` and with which code, whether the lines name the connection, or whether `chat.connected` tells a fresh identify from a resume. Recommended: every close writes `chat.disconnected` with the close code or null and a field that says which side started it, a close for good writes `chat.refused` as well, all three carry the connection's name, and `chat.connected` carries a field `resumed`. What the daemon does after `chat.refused` belongs to 04-discord.md.
- **FAIL-G32** [builder] Where chad learns that a message is a second delivery, so that it can write `message.ignored` with the reason `duplicate` (FAIL-301). The question and its recommendation are a gap of 03-sessions-and-turns.md, which owns the gateway handler and the session.
- **FAIL-G33** [builder] Whether `/new` and `/stop` write `command.ran` (FAIL-302). The event is for a chat command that changes something, and neither command is named. Recommended: `/new` writes it and `/stop` does not.
- **FAIL-G34** [builder] No event on the list says that a session left memory or was restored, and a scenario may assert only on the transcript, CLI output, `chad db query` and named log events (see 03-sessions-and-turns.md and 17-testing.md). Recommended: the builder adds `session.passivated` and `session.restored` as new rows under FAIL-189 and tests passivation on them.
- **FAIL-G35** [builder] Two cases of the reconcile. First, whether it runs for a turn that a graceful stop cuts at 15 seconds, which has not ended in the sense of FAIL-119, and what a test of FAIL-122 asserts when no test may slow the writer. Recommended: the reconcile runs on the cut path too, in the same uninterruptible region that records the graceful cut, and the test asserts that every step the Agent finished is in the stored history after the restart. Second, whether a steering message that the reconcile writes, and that no `HistoryAppended` event delivered, gets its `steers` row, its `turn.steered` line and the reply `Steered`. Recommended: the reconcile runs the match the stream runs (see 03-sessions-and-turns.md) inside its own transaction, writes the row and the line there, and the request is answered `Steered`.
- **FAIL-G36** [builder] What the retry line of FAIL-80 names when the retry was caused by clanka's turn timeout, whose error is an `UnknownError` (FAIL-G5). Recommended: the line reads "Model error (TurnTimeout), retrying (1 of 20)", through the predicate of FAIL-204, to match the stored reason of FAIL-203.
- **FAIL-G37** [builder] What the `model-check-failed` notice and its line under "Problems" say when more than one model fails its check at one boot, since the key is one and its text has one `<spec>` and one `<error>` (FAIL-168, FAIL-310). FAIL-235 also clears the key on any model call that succeeds, so an answer from the main model hides a summarizer that failed its check. Recommended: one key, one sentence for each failed model in the order main, sub-agent, summarizer, cleared as FAIL-235 says.
- **FAIL-G38** [builder] Whether any path of v1 reaches a provider over HTTP, which is the only transport on which a reset time arrives (FAIL-90). 05-model-and-login.md gives the transport of the Codex login and not of `openai` on an API key or of `openai-compat`. Recommended: if either of those two runs over HTTP, one scenario on the fake model server covers the reset time there and asserts none on the Codex side (FAIL-97). If neither does, the rules about a reset time (FAIL-60, FAIL-206, FAIL-209, FAIL-321) are covered by unit tests of the classifier and the renderers.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| FAIL-1 | TIM-541 item 13, amended by TIM-557 item 1; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| FAIL-2 | TIM-541 item 13, TIM-557 item 1 | Architect (Tim has not read) | not run; fact read: the fields of effect's JSON line |  | `rule` | `harness` |
| FAIL-3 | TIM-557 item 1 | Architect (Tim has not read) | not run; fact run: `Logger.formatLogFmt` writes one line per entry |  | `rule` | `harness` |
| FAIL-4 | TIM-557 item 2, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| FAIL-5 | TIM-557 item 3 | Architect (Tim has not read) | not run; fact run: two arguments print as two `message=` keys |  | `rule` | `harness` |
| FAIL-6 | TIM-557 item 3 | Architect (Tim has not read) | not run; fact run: a span changes the line the model reads |  | `rule` | `harness` |
| FAIL-7 | TIM-557 item 3 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-8 | TIM-557 item 2; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| FAIL-9 | TIM-554 decision 2 (Tim), TIM-557 item 4 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-10 | TIM-546 item 21 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| FAIL-11 | TIM-557 item 4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-12 | TIM-557 item 4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-13 | TIM-557 item 4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-14 | TIM-557 item 4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-15 | TIM-557 item 4, amended by Tim's ruling that a background sub-agent's retries are not logged, TIM-560 2026-11-15, and by his ruling that every sub-agent under it is exempt too, TIM-560 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-16 | TIM-557 item 4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-17 | TIM-541 item 18, TIM-557 item 5 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| FAIL-18 | TIM-557 item 5, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| FAIL-19 | TIM-557 item 6 | Architect (Tim has not read) | not run; fact run: a filter in the daemon branch left the script's output unchanged in 8 of 8 turns |  | `rule` | `failures` |
| FAIL-20 | TIM-557 item 6; TIM-559 cold read | Architect (Tim has not read) | not run; fact run: a lowered minimum shows a handler's Debug line to the model |  | `rule` | `harness` |
| FAIL-21 | TIM-557 item 6 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-22 | TIM-557 item 6, TIM-558 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-23 | TIM-557 item 7 | Architect (Tim has not read) | not run; fact run: one logger doing both jobs with the script's output unchanged |  | `rule` | `failures` |
| FAIL-24 | TIM-557 item 7 | Architect (Tim has not read) | not run; fact run: a built-in tool's fiber sees only the executor's build context |  | `rule` | `failures` |
| FAIL-25 | TIM-557 item 8 | Architect (Tim has not read) | not run; fact run: right ids with two sessions at once |  | `rule` | `failures` |
| FAIL-26 | TIM-557 item 8 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-27 | TIM-557 item 8, amended by TIM-559 ruling on ASP-G12 | Architect (Tim has not read) | not run; fact run: the reference read on the handler's fiber and on forked fibers |  | `rule` | `plugin-api` |
| FAIL-28 | TIM-557 item 8 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-29 | TIM-557 item 9 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-30 | TIM-557 item 9, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-31 | TIM-557 items 7 and 8, TIM-530 as changed by TIM-557 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| FAIL-32 | TIM-541 item 13, TIM-557 item 10 | Architect (Tim has not read) | not run; fact run: rotation without a lost or split line |  | `rule` | `failures` |
| FAIL-33 | TIM-557 item 10 | Architect (Tim has not read) | not run; fact run: rotation without a lost or split line |  | `rule` | `failures` |
| FAIL-34 | TIM-557 item 10 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-35 | TIM-557 item 10 | Architect (Tim has not read) | not run; fact run: the synchronous flush kept the file in stdout's order |  | `rule` | `failures` |
| FAIL-36 | TIM-557 item 10 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-37 | TIM-557 item 10 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-38 | TIM-557 item 11, replacing TIM-542 item 23 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-39 | TIM-557 item 11 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-40 | TIM-557 item 11 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-41 | TIM-557 item 11, amended by TIM-559 ruling on FAIL-G10 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-42 | TIM-557 item 11 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-43 | TIM-557 item 12, TIM-540 item 19 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-44 | TIM-540 item 19 | Tim | not run |  | `rule` | `failures` |
| FAIL-45 | TIM-557 item 12, amended by TIM-559 ruling on FAIL-G5 | Architect (Tim has not read) | not run; fact run: the stream fails with `RetriesExhausted` or a non-retryable `AiError` |  | `rule` | `models` |
| FAIL-46 | TIM-557 item 12 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-47 | TIM-557 item 12, TIM-544 | Architect (Tim has not read) | not run; fact read: clanka's three `CodexAuthError` reasons; fact run: the failure arrives as a defect |  | `rule` | `models` |
| FAIL-48 | TIM-557 item 12, TIM-535, amended by TIM-559 ruling on MOD-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| FAIL-49 | TIM-557 item 12, TIM-543 decision 3 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-50 | TIM-557 item 12 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-51 | TIM-557 item 13, TIM-533 item 6 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-52 | TIM-557 item 13, TIM-540 item 15 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| FAIL-53 | TIM-557 facts | Architect (Tim has not read) | run |  | `fact` | `turns` |
| FAIL-54 | TIM-533 item 5 | Tim | not run |  | `rule` | `failures` |
| FAIL-55 | TIM-557 item 14 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-56 | TIM-557 item 14 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-57 | TIM-557 item 14, amended by TIM-559 ruling on FAIL-G5 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-58 | TIM-557 item 14, amended by TIM-559 ruling on FAIL-G3, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-59 | TIM-557 item 14 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-60 | TIM-557 item 14 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-61 | TIM-533 item 10, TIM-535, TIM-557 item 14 | Tim | not run; fact run: the timeout ended both waiting turns with one code |  | `rule` | `models` |
| FAIL-62 | TIM-557 item 14 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-63 | TIM-533 item 12, amended by TIM-543 decision 3 and TIM-557 item 14 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-64 | TIM-557 item 14 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-65 | TIM-557 item 15 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-66 | TIM-557 item 15, TIM-559 round 3 on DIS-G24 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `discord-ui` |
| FAIL-67 | TIM-557 item 15, amended by TIM-559 ruling on CRON-G11 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-68 | TIM-557 items 14, 16 and 21, amended by TIM-559 ruling on FAIL-G2 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-69 | TIM-533 item 4 | Tim | not run |  | `rule` | `turns` |
| FAIL-70 | TIM-557 item 42, amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-71 | TIM-540 item 10 | Tim | not run |  | `rule` | `timers-cron` |
| FAIL-72 | TIM-540 item 10, wording from TIM-557 item 40 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `timers-cron` |
| FAIL-73 | TIM-540 item 10 | Tim | not run |  | `rule` | `timers-cron` |
| FAIL-74 | TIM-557 item 16 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `timers-cron` |
| FAIL-75 | TIM-557 item 16 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `timers-cron` |
| FAIL-76 | TIM-557 item 16 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `timers-cron` |
| FAIL-77 | TIM-557 item 16 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `timers-cron` |
| FAIL-78 | TIM-540 item 19 | Tim | not run |  | `rule` | `timers-cron` |
| FAIL-79 | TIM-557 item 17 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-80 | TIM-557 item 17, replacing the wording in TIM-533 item 2 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `models` |
| FAIL-81 | TIM-557 item 17 | Architect (Tim has not read) | not run; fact run: `MaxRetries` is per model call; fact read: `Usage` and `ErrorRetry` arrive inside `SubagentPart` |  | `rule` | `models` |
| FAIL-82 | TIM-557 item 17 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-83 | TIM-544 decision 4 | Tim | not run |  | `rule` | `models` |
| FAIL-84 | TIM-557 item 18, changing TIM-533 item 5 | Architect (Tim has not read) | not run; fact run: a silent call cost about 117 minutes on a virtual clock | TIM-557 | `rule` | `models` |
| FAIL-85 | TIM-557 item 18 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-86 | TIM-533 item 5, TIM-557 item 19 | Architect (Tim has not read) | not run; fact run: a trickling stream and a running script never time out |  | `rule` | `models` |
| FAIL-87 | TIM-557 item 20 | Architect (Tim has not read) | not run; fact run: clanka retries the frame |  | `rule` | `models` |
| FAIL-88 | TIM-557 item 20 | Architect (Tim has not read) | not run; fact run: the frame through effect's decoder against a fake backend; fact read: the Codex CLI at `81b995a` |  | `rule` | `models` |
| FAIL-89 | TIM-557 item 20 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-90 | TIM-557 items 14 and 22 | Architect (Tim has not read) | not run; fact run: the HTTP body keeps `resets_at` |  | `rule` | `models` |
| FAIL-91 | TIM-557 item 20 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-92 | TIM-557 item 20 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-93 | TIM-557 item 20 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-94 | TIM-557 item 21, amended by TIM-559 ruling on FAIL-G2 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-95 | TIM-557 item 22 | Architect (Tim has not read) | not run; fact run: a frame with no `error.message` is dropped |  | `fact` | `models` |
| FAIL-96 | TIM-557 round 2, F9 and R7 | Architect (Tim has not read) | not run; fact run: a refused handshake is a `NetworkError` with status and body lost |  | `fact` | `models` |
| FAIL-97 | TIM-557 item 22 | Architect (Tim has not read) | not run; fact run: `resets_at` is dropped on the WebSocket |  | `rule` | `models` |
| FAIL-99 | TIM-536 item 11, TIM-557 item 23, amended by TIM-559 ruling on FAIL-G11 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `turns` |
| FAIL-100 | TIM-557 item 23 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `turns` |
| FAIL-101 | TIM-557 item 23 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| FAIL-102 | TIM-557 item 23, TIM-559 round 3 L1 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| FAIL-103 | TIM-557 item 24 | Architect (Tim has not read) | not run; fact read: a sub-agent's tokens are added to its parent's |  | `rule` | `turns` |
| FAIL-104 | TIM-557 item 24; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| FAIL-105 | TIM-557 item 24 | Architect (Tim has not read) | read |  | `fact` | `turns` |
| FAIL-106 | TIM-557 item 24 | Architect (Tim has not read) | read |  | `fact` | `turns` |
| FAIL-107 | TIM-557 item 25 | Architect (Tim has not read) | not run; fact read: neither clanka nor effect has price data |  | `rule` | `turns` |
| FAIL-108 | TIM-557 item 26 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| FAIL-109 | TIM-542 item 22 | Tim | not run |  | `rule` | `turns` |
| FAIL-110 | TIM-557 item 27 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-111 | TIM-557 item 27 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-112 | TIM-557 item 27, TIM-559 round 3 C5 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-113 | TIM-557 item 27, amended by TIM-559 ruling on SET-G11, TIM-559 round 3 C5, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| FAIL-114 | TIM-557 item 27, amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-115 | TIM-557 item 27 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| FAIL-116 | TIM-557 round 1, Q16 | Architect (Tim has not read) | not run |  | `definition` | - |
| FAIL-117 | TIM-557 item 28, amended by TIM-559 ruling on ASP-G12 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-118 | TIM-539, TIM-557 item 28 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-119 | TIM-557 item 29 | Architect (Tim has not read) | not run; fact run: the store behind the Agent after a Stop with a slow writer | TIM-557 | `rule` | `turns` |
| FAIL-120 | TIM-557 item 29, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| FAIL-121 | TIM-557 item 29 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-122 | TIM-557 item 29 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| FAIL-123 | TIM-557 item 29, amended by TIM-559 ruling on FAIL-G1 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-124 | TIM-557 round 2, R4 | Architect (Tim has not read) | read |  | `fact` | `kills` |
| FAIL-125 | TIM-557 item 30 | Architect (Tim has not read) | not run; fact run: the next `send` gives the model the finished steps | TIM-557 | `rule` | `failures` |
| FAIL-126 | TIM-557 item 30 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-127 | TIM-557 item 30 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-128 | TIM-557 item 30 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-129 | TIM-557 item 30 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-130 | TIM-557 item 30 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-131 | TIM-557 item 30, amended by TIM-559 ruling on FAIL-G8 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-132 | TIM-557 item 30 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-133 | TIM-536 item 16, TIM-557 item 31, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run; fact run: `fs.statfs` gives the free bytes | TIM-557 | `rule` | `failures` |
| FAIL-134 | TIM-557 item 31, changing TIM-536 item 16, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-135 | TIM-557 item 31, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-136 | TIM-557 item 32, changing TIM-532 | Architect (Tim has not read) | not run; fact run: a full database at send time fails with a typed error; fact read: who accepts a gateway event | TIM-557 | `rule` | `failures` |
| FAIL-137 | TIM-557 item 32 and "What this changes in closed tickets" | Architect (Tim has not read) | not run; fact read: dfx's reconnect on a refused event | TIM-557 | `rule` | `failures` |
| FAIL-140 | TIM-557 item 33 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-141 | TIM-557 item 34, changing TIM-530 and TIM-540 item 8 | Architect (Tim has not read) | not run; fact read: the timer handler and `Turns.start` wait on the session's reply | TIM-557 | `rule` | `timers-cron` |
| FAIL-146 | TIM-541 item 14, TIM-557 item 35, TIM-559 round 3 on IMG-G19 and STO-G28; TIM-559 cold read, amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| FAIL-147 | TIM-536 item 14, TIM-557 item 35, amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Tim | not run | TIM-541, TIM-557 | `rule` | `failures` |
| FAIL-148 | TIM-536 item 14, wording from TIM-557 item 35, amended by Tim's ruling on the five stage 2 decisions, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-149 | TIM-557 items 35 and 38, amended by TIM-559 ruling on FAIL-G20 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-150 | TIM-557 item 36 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-151 | TIM-557 item 36 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-152 | TIM-557 item 36 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-153 | TIM-557 item 36, amended by TIM-559 ruling on FAIL-G8 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-154 | TIM-557 item 36 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-155 | TIM-557 item 36, amended by TIM-559 ruling on FAIL-G7, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-156 | TIM-557 item 37, changing TIM-533 item 12 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-157 | TIM-533 item 12, TIM-557 item 37, TIM-537 item 10 for the expired login line, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-158 | TIM-534 item 15 | Tim | not run |  | `rule` | `failures` |
| FAIL-159 | TIM-557 item 38, amended by TIM-559 rulings on FAIL-G9, STO-G18 and REC-G15, TIM-559 round 3 C4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-160 | TIM-557 item 38, TIM-559 round 3 C5 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-161 | TIM-534 item 5, wording from TIM-557 item 40 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-163 | TIM-534 item 8, wording from TIM-557 item 40 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| FAIL-164 | TIM-548 item 12, wording from TIM-557 item 40, TIM-559 round 3 L2 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| FAIL-165 | TIM-534 item 5, TIM-537, wording from TIM-557 item 40 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| FAIL-166 | TIM-549 item 19, wording from TIM-557 item 40 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| FAIL-167 | TIM-549 item 23, wording from TIM-557 item 40 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| FAIL-168 | TIM-535, wording from TIM-557 item 40, amended by TIM-559 ruling on MOD-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `models` |
| FAIL-171 | TIM-536 item 16, wording from TIM-557 item 40 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| FAIL-173 | TIM-540 item 19, wording from TIM-557 item 40 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-174 | TIM-557 items 21 and 40 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-175 | TIM-535, amended by TIM-557 item 40, TIM-544 decision 5 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| FAIL-176 | TIM-557 item 39, defining TIM-550 item 11 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| FAIL-177 | TIM-557 item 39 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-178 | TIM-557 item 39 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-179 | TIM-557 item 39, amended by TIM-559 ruling on SWAP-G13 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-180 | TIM-550 item 11 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-181 | TIM-557 item 41, TIM-547, TIM-552 decision 3, TIM-553 decision 7 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-182 | TIM-530 item 8, TIM-534 item 8 | Tim | not run |  | `rule` | `plugin-api` |
| FAIL-183 | TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| FAIL-184 | TIM-557 items 26 and 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| FAIL-185 | TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| FAIL-186 | TIM-557 "Follow-ups outside chad" | Architect (Tim has not read) | run |  | `definition` | - |
| FAIL-187 | TIM-557 "Follow-ups outside chad" | Architect (Tim has not read) | run |  | `definition` | - |
| FAIL-188 | TIM-557 "Follow-ups outside chad" | Architect (Tim has not read) | read |  | `definition` | - |
| FAIL-189 | TIM-559 ruling on FAIL-G1; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| FAIL-190 | TIM-559 ruling on FAIL-G1 | Architect (Tim has not read) | not run |  | `definition` | - |
| FAIL-191 | TIM-559 ruling on FAIL-G1; TIM-559 cold read | Architect (Tim has not read) | not run |  | `definition` | - |
| FAIL-192 | TIM-559 ruling on FAIL-G1, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-193 | TIM-559 ruling on FAIL-G1, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-194 | TIM-559 ruling on FAIL-G10 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `failures` |
| FAIL-195 | TIM-559 rulings on FAIL-G10 and CLI-G20 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `failures` |
| FAIL-196 | TIM-559 rulings on FAIL-G10 and CLI-G20 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `failures` |
| FAIL-197 | TIM-559 ruling on FAIL-G10 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `failures` |
| FAIL-198 | TIM-559 rulings on FAIL-G10 and CLI-G20 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `failures` |
| FAIL-199 | TIM-559 ruling on FAIL-G10 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `failures` |
| FAIL-200 | TIM-559 ruling on FAIL-G10 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `failures` |
| FAIL-201 | TIM-559 ruling on FAIL-G10 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `failures` |
| FAIL-202 | TIM-559 ruling on FAIL-G10 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `failures` |
| FAIL-203 | TIM-559 ruling on FAIL-G5, amending TIM-557 item 12 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-204 | TIM-559 ruling on FAIL-G5 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-205 | TIM-559 ruling on FAIL-G5 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-206 | TIM-559 ruling on FAIL-G4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-207 | TIM-559 ruling on DIS-G9 | Architect (Tim has not read) | not run |  | `rule` | `discord-ui` |
| FAIL-208 | TIM-559 rulings on FAIL-G25 and DIS-G23, changing TIM-533 items 10 and 12 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `failures` |
| FAIL-209 | TIM-559 ruling on FAIL-G4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-210 | TIM-559 rulings on FAIL-G2 and CRON-G16 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| FAIL-211 | TIM-559 ruling on CRON-G15 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| FAIL-212 | TIM-559 ruling on MOD-G22 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `models` |
| FAIL-213 | TIM-559 ruling on FAIL-G7, TIM-559 round 3 C5 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-214 | TIM-559 ruling on FAIL-G1, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-215 | TIM-559 ruling on FAIL-G8 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-216 | TIM-559 ruling on FAIL-G3 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-219 | TIM-559 ruling on FAIL-G3 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-225 | TIM-559 ruling on FAIL-G20, reading TIM-557 item 35 by item 36 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-226 | TIM-559 ruling on FAIL-G20, reading TIM-557 item 35 by item 36 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-227 | TIM-559 ruling on FAIL-G20, reading TIM-557 item 35 by item 36 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-228 | TIM-559 ruling on FAIL-G20, TIM-559 round 3 C5 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-229 | TIM-559 ruling on FAIL-G8, TIM-559 round 3 C5, TIM-559 round 4 item 9 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-230 | TIM-559 ruling on FAIL-G20, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-231 | TIM-559 ruling on REC-G15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-232 | TIM-559 ruling on FAIL-G9 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-233 | TIM-559 ruling on FAIL-G7, extending TIM-557 item 36 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-234 | TIM-559 ruling on FAIL-G7, extending TIM-557 item 36 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-235 | TIM-559 ruling on FAIL-G7, extending TIM-557 item 36 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `models` |
| FAIL-236 | TIM-559 ruling on FAIL-G7, extending TIM-557 item 36 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| FAIL-237 | TIM-559 ruling on FAIL-G2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| FAIL-238 | TIM-559 ruling on SWAP-G13 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-239 | TIM-559 ruling on FAIL-G5 | Architect (Tim has not read) | not run |  | `definition` | - |
| FAIL-240 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| FAIL-241 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-242 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-243 | TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run |  | `rule` | `skills-mcp` |
| FAIL-244 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-245 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-246 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-247 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-248 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-249 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-250 | TIM-557 items 2 and 4, TIM-559 round 2 R4, amended by Tim's ruling that a background sub-agent's retries are not logged, TIM-560 2026-11-15, and by his ruling that every sub-agent under it is exempt too, TIM-560 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-251 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-252 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| FAIL-253 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| FAIL-254 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-255 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-256 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `discord-ui` |
| FAIL-257 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-258 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-259 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-260 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-261 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-262 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-263 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-264 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-265 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-266 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-267 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-268 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-269 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-270 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| FAIL-271 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| FAIL-272 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| FAIL-275 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| FAIL-276 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| FAIL-277 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| FAIL-278 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| FAIL-279 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-281 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-282 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-283 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| FAIL-284 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| FAIL-285 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| FAIL-286 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| FAIL-287 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| FAIL-288 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-289 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| FAIL-290 | TIM-557 items 2 and 4, TIM-559 round 2 R4; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| FAIL-291 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| FAIL-293 | TIM-557 items 2 and 4, TIM-559 round 2 R4; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| FAIL-294 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| FAIL-295 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| FAIL-296 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-297 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| FAIL-298 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| FAIL-299 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| FAIL-300 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| FAIL-301 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| FAIL-302 | TIM-559 round 2 R4, TIM-559 round 4 item 3, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| FAIL-303 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| FAIL-304 | TIM-557 items 2 and 4, TIM-559 round 2 R4; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| FAIL-305 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-306 | TIM-557 items 2 and 4, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-307 | TIM-559 round 3 C5 | Architect (Tim has not read) | not run |  | `definition` | - |
| FAIL-308 | TIM-559 round 3 C5 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-309 | TIM-559 round 3 C5 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-310 | TIM-559 round 3 C5 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-311 | TIM-559 round 3 C5, TIM-559 ruling on FAIL-G20 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-312 | TIM-559 round 3 C5 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| FAIL-313 | TIM-559 round 3 C5, TIM-557 item 38 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| FAIL-315 | TIM-559 round 3 on FAIL-G7 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| FAIL-318 | TIM-559 round 3 A2 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| FAIL-319 | TIM-559 round 4 item 9 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-320 | TIM-559 round 4 item 9 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| FAIL-321 | TIM-559 round 4 item 9 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| FAIL-322 | TIM-559 cold read, cli reader and harness reader, TIM-559 round 5 item 6 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| FAIL-323 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `wire` |
| FAIL-324 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| FAIL-325 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| FAIL-326 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `kills` |
| FAIL-327 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `kills` |
| FAIL-328 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-329 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-330 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-331 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-332 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-333 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-334 | Build, stage 2, amended in stage 4 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-335 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-336 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-337 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-338 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-339 | Build, stage 2, amended by Tim's ruling on the five stage 2 decisions, chat 2026-11-15 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-340 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-341 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `failures` |
| FAIL-342 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `models` |
| FAIL-343 | Build, stage 3 | Builder (Tim has not read) | run |  | `rule` | `plugin-api` |
| FAIL-344 | Build, stage 3 | Builder (Tim has not read) | run |  | `rule` | `loader` |
| FAIL-345 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| FAIL-346 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |

Retired ids. These rules were withdrawn and removed from this part with their Provenance rows, and the git history of this file holds their text. An id on this list is never used again, and a new rule takes a number above every id in the table and on this list.

FAIL-98, FAIL-138, FAIL-139, FAIL-142, FAIL-143, FAIL-144, FAIL-145, FAIL-162, FAIL-169, FAIL-170, FAIL-172, FAIL-217, FAIL-218, FAIL-220, FAIL-221, FAIL-222, FAIL-223, FAIL-224, FAIL-273, FAIL-274, FAIL-280, FAIL-292, FAIL-314, FAIL-316, FAIL-317.
