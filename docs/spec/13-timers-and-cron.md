# Timers and the bundled cron plugin

This part covers two things that work together. The first is the timer mechanism in chad's core, which lets any plugin schedule a turn that survives a restart. The second is cron, the bundled plugin that turns that mechanism into scheduled jobs the agent manages with five tools. It leans on 06-plugin-api.md for the rest of the plugin API, on 03-sessions-and-turns.md for how a plugin-started turn runs and is resumed, on 04-discord.md for what a turn looks like in chat, on 07-plugin-loading.md and 08-apply-and-swap.md for loading and swapping plugins, and on 10-cli.md and 11-settings.md for the commands and settings named here.

## How the two halves fit

A timer is one named, stored schedule that belongs to one plugin. When it comes due, the core starts a turn in a chat thread with a stored prompt. A run is one such firing. A timer is either a one-shot, which fires at one time, or recurring, which fires on a cron expression.

A job is the cron plugin's own record of something the owner asked chad to do on a schedule. Cron keeps the job, and the core keeps the job's timer. Cron owns the tools, the job records, the prompt wrapper, pausing and the failure count. Recurrence and durability sit in the core, so any other plugin that wants a durable schedule gets the same behaviour from the same calls.

A plugin-started turn is a turn that a plugin started through `Turns.start`, through `Turns.queue` or through a timer, with no owner message behind it. Several rules below apply to every plugin-started turn and not only to cron's.

- **CRON-1** Cron is a plugin on the same plugin API every other plugin gets. The core has no special case for it. Anything a scheduled job needs from the core is part of the plugin API.
- **CRON-2** The core holds every schedule and saves each recurring timer's next run. Cron holds no clock and no scheduler of its own.
- **CRON-90** Every duration this part names lives in the `Timings` service described in 17-testing.md, which also describes how timers and cron are tested, including cron next-run times across timezones and daylight saving changes.

## The plugin API for timers

The `Turns` service is how a plugin starts a turn. The shapes below are shorthand and not full TypeScript. The full declarations of `Turns`, `Origin` and `Outcome` live in 06-plugin-api.md.

```ts
Turns: {
  start(options: { thread, prompt, label, mention? }): Effect<Outcome>
  queue(options: { thread, prompt, label, mention? }): Effect<void>   // adjusted: TIM-559, returns once the request is saved
  schedule(options: ({ name, at } | { name, cron, timezone }) & { thread, prompt, label, mention? }): Effect<void>   // adjusted: TIM-540, parentheses added so both forms take thread, prompt, label and mention
  cancel(name: string): Effect<void>
  scheduled(): Effect<ReadonlyArray<Timer>>   // the calling plugin's timers only
}
Origin:  { _tag: "Message", message } | { _tag: "Plugin", plugin, label, timer?: { name, scheduledAt } }
Outcome: Answered { text } | Failed { reason: ThreadGone | ModelError | UsageLimit | LoginFailed | LoggedOut | GaveUp | Internal } | Stopped   // adjusted: TIM-557, the closed set of reasons
```

- **CRON-3** `Turns.start({ thread, prompt, label, mention? })` runs a turn in the session of that thread and returns its `Outcome`. Each call gets a fresh id, so two calls are two turns.
- **CRON-4** `Turns.schedule` stores a timer for the calling plugin. It takes a `name`, then either `at` for a one-shot time or `cron` with a `timezone` for a recurring timer, then the `thread`, `prompt` and `label` of the turn to start and an optional `mention`.
- **CRON-5** Timer names are scoped to the plugin. Two plugins can each have a timer with the same name, and a plugin can reach only its own.
- **CRON-6** `Turns.schedule` under a name that already has a run replaces it. The stored row is overwritten and the earlier wake-up is cleared, so only the new time fires.
- **CRON-7** `Turns.cancel(name)` removes the calling plugin's timer of that name. A run that has not started does not fire.
- **CRON-8** `Turns.scheduled()` returns the calling plugin's timers only. It reads the `timers` table, because cluster's message storage cannot list the messages waiting at an address without claiming them.
- **CRON-9** A turn started by a timer has `origin._tag === "Plugin"` with the plugin's name, the label, and `timer: { name, scheduledAt }` holding the timer name and the scheduled time. A turn started by `Turns.start` has no `timer`.
- **CRON-10** The doc comments of `Turns.start`, `Turns.queue` and `Turns.schedule` say that the prompt has to state what started the turn and that nobody is there to answer questions. A turn is unattended by its origin, whatever started it. chad's core adds no line of its own to the prompt of a plugin-started turn. The doc comments are in 06-plugin-api.md.
- **CRON-11** `Turns.start` called from a tool handler for the thread of its own turn fails at once with a message that names `Turns.queue`. The new turn queues behind the turn that called the tool, so a call that waited for the outcome would deadlock. The plugin-writing guidance in 14-self-edit-skill.md tells a plugin author to call `Turns.queue` there.
- **CRON-83** `Turns.start` learns the turn's end from the session in the same process and not only from cluster's reply, so it does not hang when cluster could not save that reply. See 06-plugin-api.md.
- **CRON-91** In `Turns.schedule`, `at` is a `DateTime.Utc` and `timezone` is an IANA timezone name as a string. `scheduledAt` in `Origin` is a `DateTime.Utc`. The declarations are in 06-plugin-api.md.
- **CRON-92** A `Timer` returned by `Turns.scheduled()` has the fields of the `timers` row without the plugin, which are the name, the schedule, the thread, the prompt, the label, the mention and the next run.
- **CRON-93** `Turns.queue({ thread, prompt, label, mention? })` saves the request for a turn in the session of that thread and returns once the request is saved, without waiting for the outcome. A tool that starts a turn from its handler uses it. See 06-plugin-api.md.
- **CRON-135** `Turns.queue`, `Turns.schedule`, `Turns.cancel` and `Turns.scheduled`, called by a version of a plugin that is not active yet, wait for the activation, as `Turns.start` does. A call made while the plugin's Layer builds waits on an activation that itself waits on the build, so the build's deadline ends the call with an error that names `Plugin.background`. Cron makes its `Turns` calls from a `Plugin.background` fiber and from its tools, and never in its build (see CRON-131). The rule is in 06-plugin-api.md.
- **CRON-136** `Turns.schedule` and `Turns.cancel` are declared with no error type, like `Turns.start` and `Turns.queue`. A call that fails, as when the timer cannot be saved on a full disk, fails with a defect whose message is a text written for the model. When that happens inside one of cron's tools, clanka returns the text to the script that called the tool. The texts are rules, and they are in 06-plugin-api.md.

## The timer entity and the timers table

Each timer has two stored pieces. One is a row in the `timers` table in chad's SQLite file. The other is a wake-up, which is a persisted message in effect cluster's own tables, addressed to a cluster entity and carrying its delivery time. Cluster reads a message only once its delivery time has passed, so deleting the message cancels it. The cluster settings shared with sessions, including the single shard and the stored shard count that a daemon checks at boot, are specified with the session runtime in 03-sessions-and-turns.md and 02-storage.md.

- **CRON-12** The core runs a cluster entity named `Timer` next to the `Session` entity. It has one address per timer, keyed by the plugin name plus the timer name. Each scheduled run is one persisted message at that address whose `DeliverAt` returns the scheduled time.
- **CRON-13** A timer never shares an address with the `Session` entity. Clearing an address deletes every message stored at it, so a timer that must be cancelled on its own needs its own address.
- **CRON-14** The `timers` table has one row per timer, identified by plugin and name. The row holds the plugin, the name, the schedule, the thread, the prompt, the label, the mention and the next run.
- **CRON-15** Cluster's message is only the wake-up. The `timers` row is the record of whether a run is still wanted. When a wake-up is delivered and the row is gone, or the row's next run is not the wake-up's scheduled time, the handler does nothing.
- **CRON-16** Cancelling a timer deletes its row and calls `MessageStorage.clearAddress` on the timer's address, the way the cluster workflow engine clears a clock. The `Session` entity's messages are left alone, and a plugin turn that is already queued there still runs.
- **CRON-17** Cluster's `entityMessagePollInterval` is 1s. A message with `DeliverAt` waits for cluster's storage poll, so a timer fires about 0.6s late. An idle process with one pending timer spends 0.2 to 0.3% of one core on the poll.
- **CRON-18** `MessageRetention` is on for the `Timer` entity, so completed timer requests are pruned from cluster's tables. This is safe because the handler checks each request against the `timers` row and does not rely on stored replies.
- **CRON-94** The column names and types of the `timers` table are in 02-storage.md.
- **CRON-95** The `timers` row and cron's job record store a thread as the thread string, which is `ChatThread.toString(thread)` and has the form `discord:<channel id>`. It is the same string the `sessions` table stores and the id of the thread's `Session` entity. See 03-sessions-and-turns.md.
- **CRON-96** The entity id of a timer is `<plugin>/<name>`.
- **CRON-97** The primary key of a wake-up is its scheduled time in milliseconds since the epoch.
- **CRON-98** The turn key of a scheduled run is `timer/<plugin>/<name>/<scheduled time>`, with the scheduled time in milliseconds since the epoch. It is the `request_key` of the turn's row in the `turns` table (see 02-storage.md). These strings are stored on the volume, so a change to their form needs a migration.
- **CRON-99** The turn key of a turn started by `Turns.start` or `Turns.queue` is `start/<random UUID>`.

What a `timers` row holds:

| Field | Holds | Column in the prototype that ran |
| --- | --- | --- |
| plugin | The name of the plugin that owns the timer | `plugin`, part of the primary key |
| name | The timer name, scoped to the plugin | `name`, part of the primary key |
| schedule | A one-shot time, or a cron expression with its timezone | `cron`, null for a one-shot. No timezone column |
| thread | The thread whose session runs the turn | `thread` |
| prompt | The prompt the turn starts with | `prompt` |
| label | What the plugin calls the turn | None |
| mention | The user id to mention, when one was given | None |
| next run | The scheduled time of the one stored run | `next_run`, an integer of epoch milliseconds |

The prototype ran the entity and its message in the form below. The primary key of the message is the scheduled time, so one scheduled time at one address is one request.

```ts
export class Fire extends Schema.Class<Fire>("proto/Fire")({
  plugin: Schema.String,
  name: Schema.String,
  at: Schema.Number
}) {
  [PrimaryKey.symbol]() {
    return String(this.at)
  }
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at)
  }
}

export const Timer = Entity.make("Timer", [
  Rpc.make("fire", { payload: Fire }).annotate(ClusterSchema.Persisted, true)
])
```

## What the timer's handler does

The handler is the core code that runs when a wake-up is delivered. It checks the row, starts the turn, waits for it to end, checks the row again and only then stores the next run.

- **CRON-19** When a wake-up is delivered, the handler reads the `timers` row before it starts the turn. It starts a plugin turn in the row's thread with the row's prompt, label and mention.
- **CRON-20** For a scheduled run the core derives the turn's key from the plugin, the timer name and the scheduled time. The plugin passes no key. One scheduled time starts one turn, however many times its wake-up is delivered.
- **CRON-21** A timer's turn is a persisted request to the thread's `Session` entity, like any plugin-started turn. It restores a session that was passivated, waits for the session to be idle and never steers a turn that is running. See 03-sessions-and-turns.md.
- **CRON-22** The handler waits for the turn's outcome before it stores anything. Two runs of one timer therefore never overlap.
- **CRON-84** The handler learns that the turn has ended from the session's own in-memory end, in the same process, and not from cluster's reply alone. When cluster cannot save a reply, as on a full disk, it gives up without a log line and delivers the request again only after a restart. A recurring timer still saves its next run in that case, and does not stop firing for the life of the process. The full disk rules are in 16-failures-logs-status.md.
- **CRON-23** After the turn ends, the handler reads the row again before it saves the next run. If the row is gone or its next run has changed, it saves nothing. A cancel or a replace that lands while a run is in progress therefore stays in force, and the run that had started still finishes.
- **CRON-24** For a recurring timer, the handler saves the next run itself once the turn has ended, the way `ClusterCron` does. It updates the row's next run and saves the next wake-up. Only the next run is ever stored.
- **CRON-100** The next run of a recurring timer is the first time of its cron expression after the moment the turn ended. Scheduled times that passed during a long run or while chad was down are skipped and never fire in a burst, which matches the rule that an overdue timer fires once.
- **CRON-101** The next run of a cron expression is computed by Effect's `Cron` with its default daylight saving behaviour. chad has no next-run code of its own.
- **CRON-102** A scheduled time that falls inside an hour that a daylight saving change skips runs once, at the first instant after the gap.
- **CRON-103** A scheduled time that falls inside an hour that a daylight saving change repeats runs once, on the first occurrence. An hourly job therefore misses one real hour each autumn.
- **CRON-104** The unit tests of next-run times pin real Pacific/Auckland dates around both daylight saving changes, because the source of Effect's `Cron` warns that `next` near a gap is not guaranteed to be the nearest match.
- **CRON-25** A one-shot timer is gone once its turn has ended. It no longer appears in `Turns.scheduled()`.

## Overdue runs, kills and restarts

- **CRON-26** A stored run that is overdue when chad starts fires once, however many scheduled times were missed while chad was down. That covers a late one-shot too. There is no per-timer setting for missed runs. In the prototype an overdue run was delivered once, 162 ms after the process started.
- **CRON-27** A recurring timer's chain survives a kill before the turn starts, in the middle of the turn, and between the turn ending and the next run being saved. Each scheduled time starts one turn, and the chain goes on after the restart.
- **CRON-28** A timer's turn that is cut by a kill or by a graceful stop is resumed like any other turn, as the same scheduled time. It does not start a second turn. A graceful stop does not count against the turn. After two starts that ended in a kill chad gives up on it, and the run ends as `Failed` with `GaveUp` (see CRON-89). See 03-sessions-and-turns.md for how a turn is resumed.
- **CRON-29** When chad is killed after the turn ended and before the next run was saved, the redelivered wake-up gets the turn's stored outcome, starts no second turn, and saves the next run.

## Timers of a plugin that is not loaded

A plugin can be absent while its timers are still stored. That happens to a repo plugin in safe mode, to a plugin whose build failed at boot, to a plugin whose file was deleted and the deletion applied, and to a plugin turned off with `"enabled": false` in `chad.json`. Such a timer is held, which means it stays stored and does not fire.

- **CRON-30** A timer whose plugin is not loaded is held until the plugin loads again. The handler waits inside the request until the plugin is back.
- **CRON-31** While a timer is held its request stays unprocessed. A kill redelivers it after the restart, and it is held again.
- **CRON-134** When a timer comes due for a plugin that is not loaded, the core writes the `timer.held` event to the log. The table of event names is in 16-failures-logs-status.md.
- **CRON-32** When the plugin loads again, a held timer that is overdue fires once. In the prototype it fired 135 ms after the plugin came back. The handler reads the row again first, so a held timer that was cancelled in the meantime does not fire.
- **CRON-33** A held timer is a request in flight. A graceful stop with a timer on hold takes the full 15s of cluster's `entityTerminationTimeout`. This cost is accepted. The stop budget is in 01-image-and-volume.md.
- **CRON-34** Deleting a plugin's file and applying unloads the plugin and keeps its timers and its data. The timers are held like those of a plugin that is off, and the apply output says so. A revert therefore brings the plugin back with its timers intact.
- **CRON-35** `chad plugin purge <name>` is the only thing that deletes a plugin's timers. It drops the plugin's key-value table and its timers. It refuses a repo plugin that is still in the applied repo, including one that is off. The agent may run it. The purge rule is in 11-settings.md and the command is in 10-cli.md.
- **CRON-105** `chad plugin purge` refuses a bundled plugin that is on, so a loaded plugin never loses its jobs and timers underneath it. A bundled plugin is never in the applied repo, so this refusal is separate from the one in CRON-35. See 11-settings.md.
- **CRON-106** `chad plugin purge` allows a bundled plugin that is turned off with `"enabled": false`. A bundled plugin cannot be deleted from the repo, so off is the nearest it gets to deleted. The purge prints what it deleted. For cron it counts the jobs, which are the entries of cron's key-value table, and the timers. See 11-settings.md.
- **CRON-36** `"enabled": false` on a plugin holds its timers and keeps its data. `chad status` lists the plugin as "off" with its count of held timers. See 11-settings.md.
- **CRON-85** Timers held for a plugin that is not loaded are listed in the "Problems" block of `chad status` and `/status`, with two exceptions. The timers of a plugin the owner turned off with `"enabled": false` show only on the plugin's "off" line, because the owner turned it off on purpose. A plugin deleted from the repo is listed outside "Problems" with its count of held timers and the command `chad plugin purge <name>`. See 16-failures-logs-status.md and 11-settings.md.
- **CRON-37** Turning a plugin back on fires each overdue held timer once. The apply output says how many will fire.
- **CRON-38** Turning safe mode on holds the timers of every plugin it switches off. A timer of a plugin that safe mode turned off fires once after safe mode goes off.

## Timers during a swap

A swap is the path by which chad replaces loaded plugin versions, for an apply and for every other reload. It closes a gate on each plugin, drains what is in flight, closes the old versions and activates the new ones. The details are in 08-apply-and-swap.md.

- **CRON-39** A timer's handler is core code that starts a turn and waits for it, and a turn is never interrupted by a swap. The swap's drain neither waits for a timer's handler nor interrupts it. Only the gate applies to timers.
- **CRON-40** A timer that fires while its plugin is in the middle of a swap is held until the activation. Its turn then runs on the new version.
- **CRON-41** A timer whose plugin the swap removed or turned off is held like any unloaded plugin's.

## Rules for every plugin-started turn

A server thread is a Discord thread inside a server, as opposed to a direct message. The rules here belong to the core and apply whichever plugin started the turn.

- **CRON-42** A plugin-started turn looks like any other turn. It has a status message with a Stop button, and the status message is removed when the turn ends. Its answer is a plain post, because there is no owner message to reply to. See 04-discord.md.
- **CRON-43** `Turns.start` and `Turns.schedule` take an optional `mention` with a user id. The core puts that mention at the start of the answer in a server thread and ignores it in a direct message.
- **CRON-107** The core makes the `mention` notify by allowing that one user id in the allowed mentions of the one message that carries it. Every other mention in every message chad writes stays inert, so no plugin can ping anyone else.
- **CRON-108** When the core posts, it drops a `mention` whose user id is not on the owner allowlist. An owner who was removed therefore stops being pinged.
- **CRON-44** For every plugin-started turn, an answer that is exactly `[SILENT]` is not posted. The status message is removed as usual.
- **CRON-86** A turn whose answer is exactly `[SILENT]` ends as `Answered { text: "[SILENT]" }`, so a plugin can tell, and the turn's row in the `turns` table says `answered`. The row holds no answer text, so a redelivered request that chad answers from the row of a turn that had already ended gets `Answered` with an empty text (see 03-sessions-and-turns.md). A plugin can receive that reply only in the narrow case that 06-plugin-api.md describes, and it cannot tell a `[SILENT]` answer from another one then. A timer's wake-up uses only that the turn ended (CRON-29).
- **CRON-45** `Failed { reason }` carries a tagged value from a closed set of seven tags: `ThreadGone`, `ModelError`, `UsageLimit`, `LoginFailed`, `LoggedOut`, `GaveUp` and `Internal`. `ThreadGone` means the turn's thread no longer exists. `GaveUp` means a resumed turn that chad stopped retrying after two kills. What each tag carries and when a turn ends with it is in 16-failures-logs-status.md.
- **CRON-46** When a plugin-started turn ends as `Failed` with `ThreadGone`, the core posts a notice the way it posts any notice outside a turn. The notice goes to the owner's most recently active direct message session, or failing that to the most recent session of any kind, and it is logged as well. It is a normal message and not subtext, and in a server thread it starts with the owner's mention. It reports an event and not a standing condition, so it has no key and is posted every time. Its wording and the rules for notices are in 16-failures-logs-status.md.
- **CRON-47** A plugin-started turn never starts a model login, because no owner is present to complete it. When chad is logged out and no login is pending, the turn ends at once as `Failed` with `LoggedOut`, without calling clanka. That check runs before the status message is posted, so nothing is posted in the turn's thread. When a login is already pending, the turn waits on it, and it ends as `Failed` with `LoginFailed` if that login fails. While it waits it posts nothing in its thread, and an owner's message in that thread during the wait gets the notice that a login is pending, once (see 04-discord.md). The owner gets the logged-out notice once when the condition begins and not again while it holds. The notice's wording and the notice rule are in 16-failures-logs-status.md, the login and the wait are in 05-model-and-login.md, and the order of the check and the status message is in 04-discord.md.
- **CRON-87** When a plugin-started turn fails, the core posts the failed-turn message in the turn's thread as 16-failures-logs-status.md describes, which also names the reasons that post nothing there. A plugin-started turn that ends as `Failed` with `LoggedOut`, `LoginFailed` or `UsageLimit` is among them. It posts nothing in its thread, and the core begins the keyed notice for that condition if none is held (see 16-failures-logs-status.md). These runs never pause a job, so a five minute job under a usage limit would otherwise post and ping on every run for hours. In a server thread the failed-turn message starts with the turn's `mention` when one was given.
- **CRON-88** A plugin-started turn that the provider refuses because the login's usage limit is reached ends as `Failed` with `UsageLimit`, and the next one tries again, because chad keeps no "limit in force" state. The owner gets one notice for that condition when no owner was present. See 16-failures-logs-status.md.

## The cron plugin and what a job is

Cron is a bundled plugin, which means it ships in the image and not in the owner's repo. Its TypeScript source ships inside the `chad` package as a plugin in a directory, and the agent can read it as a worked example at `/data/repo/examples/cron/`.

- **CRON-48** A job carries a name, a prompt, a schedule, a thread, a timezone, an on/off flag, a `notify` flag and the id of the owner who created it.
- **CRON-49** A job has no skill field and no script field. The prompt names the skill or the script to run. A job cannot choose its own model, because the model is one global setting.
- **CRON-50** A job's schedule is a one-shot or a recurring one. A one-shot is `at` a time, or `in` a delay that the tool turns into a time. A recurring schedule is a 5-field cron expression with an IANA timezone, parsed by Effect's `Cron`.
- **CRON-51** A job's timezone defaults to the owner's. Cron reads the owner's timezone as Effect's `DateTime.CurrentTimeZone`, which chad supplies to every plugin. The owner sets it with `chad timezone`, described in 10-cli.md.
- **CRON-52** A one-shot job is deleted after any run of it that happened. A run happened when it ended as `Answered`, as `Stopped`, as `Failed` with a reason that counts toward the pause, or as `Failed` with `ThreadGone` or `GaveUp`. In the last two cases the one-shot job is deleted and not paused. CRON-126 covers the runs that did not happen.
- **CRON-53** Jobs are stored in the plugin's key-value store, one entry per job. `KeyValueStore.keys` lists them, so there is no index key. Cron needs nothing from storage beyond the store.
- **CRON-54** A job runs in the session of its thread, which is what `Turns.start` and `Turns.schedule` already do. There is no fresh-session option in v1. The accepted cost is that a job's work lands in that thread's history.
- **CRON-55** A job posts to the thread it was created in. That thread is a direct message or a thread chad already has a session in, because effect/chat cannot open a direct message from a user id.
- **CRON-56** A job belongs to the thread and not to the session, so `/new` keeps it.
- **CRON-57** An enabled job has one timer in the core. The one exception is the one-shot of CRON-79 that fired and whose outcome was not recorded. A paused job has no timer, so it does not catch up on runs it missed while paused. There is no per-job setting for missed runs.
- **CRON-58** Cron builds from its defaults alone, like every bundled plugin. The image layer of the tests checks that with a boot in safe mode with every bundled plugin on its defaults. See 17-testing.md.
- **CRON-59** Jobs have no CLI commands. They are managed through cron's tools.
- **CRON-109** A job is identified by its name. The name is unique among all of cron's jobs across all threads, because `cronUpdate` can move a job between threads.
- **CRON-110** A job's name cannot be changed in v1.
- **CRON-111** Cron uses the job's name as the name of the job's timer and as the label of its turns. The label is what the owner reads in the `ThreadGone` notice.
- **CRON-112** A job created during a run of another job takes the owner id of the job whose run created it, because that is the only owner the turn has.
- **CRON-113** A job created in a turn that has no owner message and no cron job behind it, such as a turn another plugin started with `Turns.start`, gets no owner id and never pings.
- **CRON-114** A job records whether its timezone was given or taken from the default.
- **CRON-115** A job whose timezone was defaulted follows the owner's timezone. A change made with `chad timezone` reloads every plugin (see 08-apply-and-swap.md), and cron's reconcile then reschedules those jobs in the new timezone.
- **CRON-116** A job whose timezone was given keeps it when the owner's timezone changes. `cronUpdate` changes it.

What a job carries:

| Field | Meaning |
| --- | --- |
| name | The job's name |
| prompt | What the agent is asked to do on each run, stored together with the wrapper lines that never change |
| schedule | A one-shot time, or a 5-field cron expression |
| thread | The thread the job posts to and whose session it runs in |
| timezone | The IANA timezone of the cron expression, defaulting to the owner's |
| on/off flag | Whether the job is enabled. `cronUpdate` sets it as `enabled` |
| `notify` | Whether the job's answer pings the owner in a server thread. On by default |
| owner id | The id of the owner who created the job |

## The five tools

- **CRON-60** Cron adds five tools to every session's agent: `cronCreate`, `cronList`, `cronUpdate`, `cronRemove` and `cronRun`.
- **CRON-61** `cronCreate` creates a job in the thread it is called from. It takes the job's name, its prompt, its schedule as `at`, `in` or a cron expression, an optional timezone and the `notify` flag.
- **CRON-62** `cronList` returns the jobs. The prompt chunk never lists them, so this tool is how the agent sees what is scheduled.
- **CRON-63** `cronUpdate` changes a job. Pausing is `cronUpdate` with `enabled: false`. `notify: false` turns the ping off.
- **CRON-64** `cronUpdate` called from another thread moves the job to that thread.
- **CRON-65** `cronRemove` deletes a job. A removed job has no next run.
- **CRON-66** `cronRun` runs a job now. It calls `Turns.queue`, leaves the schedule alone and returns "queued" once the request is saved, without waiting for the outcome. A run fired from the job's own thread queues behind the turn that called the tool and starts after that turn ends. In the prototype such a tool returned in 8 ms.
- **CRON-67** A change to a job never touches a run that has started. `cronUpdate`, `cronRemove` and a pause apply from the next run. Stopping a run in progress is the Stop button or `/stop`.
- **CRON-68** Cron's prompt chunk is two static lines on how to schedule. It never lists the jobs.
- **CRON-117** Each tool takes the fields of the job table in this part and nothing else.
- **CRON-118** `cronList` also returns each job's next run and whether failures paused it, because the model cannot work out a cron time across a daylight saving change. CRON-137 adds a mark for a one-shot whose outcome was not recorded.
- **CRON-119** `cronCreate` and `cronUpdate` fail with a message that names the bad field, and change nothing, when they are given a time in the past, an invalid cron expression, an unknown timezone or a duplicate name.
- **CRON-120** `cronRun` runs a paused job, because it leaves the schedule alone.

## What a run looks like

The prompt wrapper is the set of lines cron puts around the owner's prompt so the agent knows the turn is unattended. It is split in two. The part that never changes is stored, and the part that depends on the run is added when the run starts.

- **CRON-69** The wrapper lines that never change are stored with the job's prompt. They say that this is a scheduled run, that nobody is there to answer questions, and that an answer of `[SILENT]` is allowed. The rule in 14-self-edit-skill.md that an unattended turn does not apply changes is written against this wording.
- **CRON-121** The stored wrapper lines contain the phrase "scheduled run" and the phrase "nobody is there to answer questions" word for word. The unattended-turn line of the skill in 14-self-edit-skill.md matches on those two phrases, so a change to either phrase is a change to both parts.
- **CRON-70** Cron's `beforeTurn` hook reads the timer name and the scheduled time from `Origin.Plugin` and adds when the run was due and how late it is. If the hook fails, the run goes ahead without that line.
- **CRON-71** A job's answer pings the owner in a server thread by default. `notify: false` on the job turns the ping off.
- **CRON-72** One run of a job is in progress at a time.

## Failures and pausing

- **CRON-73** A failed run is not retried.
- **CRON-74** Three failures in a row pause the job, and cron posts a line in the job's thread that names the job and the last failure's reason. The line reports an event, so it is posted every time a job is paused this way. Its wording is in 16-failures-logs-status.md.
- **CRON-75** A run the owner stops is not a failure.
- **CRON-76** When a run ends as `Failed` with `ThreadGone`, cron pauses the job at once, without waiting for three failures.
- **CRON-89** When a run ends as `Failed` with `GaveUp`, cron pauses the job at once, like `ThreadGone`. A job whose run kills the daemon twice would otherwise take six crashes to pause.
- **CRON-77** A run that fails with `LoggedOut`, `LoginFailed` or `UsageLimit` is not a failure of the job. It neither adds to the count of three in a row nor resets it, cron posts nothing in the job's thread for it, and it is not run again later, which differs on purpose from a run missed while chad was down.
- **CRON-122** The count of failures in a row is kept in the job's entry in the key-value store.
- **CRON-123** A run started by `cronRun` counts toward the three in a row like a scheduled run.
- **CRON-124** A stopped run neither adds to the count nor resets it, the same as the failures that do not count.
- **CRON-125** Re-enabling a job with `cronUpdate` resets the count to zero. Otherwise the first failure after the owner turns the job back on would pause it again.
- **CRON-126** A one-shot job whose run ends as `Failed` with `LoggedOut`, `LoginFailed` or `UsageLimit` is kept and paused. Such a run is not the job's failure, and a reminder that vanished because a token refresh failed would be a silent loss.
- **CRON-127** `cronRun` runs a one-shot job that was kept this way, and the job is deleted once a run of it ends any other way.

## Reconciling on load

- **CRON-78** Each time cron is activated, it reconciles its job records with `Turns.scheduled()`. The job record is the truth. Cron schedules an enabled job that has no timer, except the one-shot of CRON-79 whose due time has passed, and it cancels a timer that has no job.
- **CRON-79** The reconcile never deletes a job. It leaves alone an enabled one-shot job that has no timer and whose due time is in the past, and it schedules an enabled one-shot job that has no timer and whose due time is in the future. Cron cannot tell a one-shot whose `afterTurn` hook was lost from one whose run is still in progress, which is the usual state after a swap, and deleting or pausing a job whose turn is running is worse than a leftover job. A paused one-shot with no timer is kept too.
- **CRON-137** `cronList` marks an enabled one-shot job that has no timer and whose due time is in the past as "fired, outcome not recorded".
- **CRON-138** A one-shot job in that state stays as it is until one of three things settles it. Cron's `afterTurn` hook for the run arrives and deletes or pauses the job under CRON-52 and CRON-126, or `cronRun` runs the job, or `cronRemove` deletes it.
- **CRON-128** The reconcile makes each timer match its job record in schedule and timezone, and not only in existence. It schedules again a timer whose schedule or timezone differs from the job's, and it cancels the timer of a paused job.
- **CRON-129** A change that adds a timer or moves one schedules the timer first and writes the job record second. A kill between the two leaves a timer that the reconcile cancels or puts back to match the record.
- **CRON-130** A change that removes a timer, which is a remove or a pause, writes the job record first and cancels the timer second. A kill between the two leaves a timer whose job is gone or paused, which the reconcile cancels. Pausing a one-shot in the other order and dying in between would leave an enabled one-shot with no timer, which cron cannot tell from a one-shot that fired (see CRON-79).
- **CRON-131** The reconcile runs in a `Plugin.background` fiber at activation, and not while cron's Layer builds. Builds finish before the swap's gate closes, when the old version still answers `cronCreate` and the new version may never activate. The `Turns` calls the reconcile needs therefore wait for the activation (CRON-135), and a reconcile in the build would end at the build's deadline.
- **CRON-132** The reconcile and cron's five tools run under one shared lock, so a tool call and the reconcile never interleave.
- **CRON-133** A timer with no job that is already overdue when cron activates can fire once before the reconcile cancels it. This cost is accepted.

## Cron in safe mode and turned off

- **CRON-80** Bundled plugins stay on in safe mode, so cron's jobs keep firing while the owner's plugins are off.
- **CRON-81** The owner turns cron off with `"enabled": false` under `plugins.cron` in `chad.json`. Its tools are then gone from each session's next turn, its timers are held and its jobs are kept.
- **CRON-82** Safe mode reads the `"enabled": false` flags of bundled plugins from the applied `chad.json`, so a cron the owner turned off stays off in safe mode and its overdue jobs do not fire. If that read fails, every bundled plugin is on.

## Gaps

- **CRON-G1** [builder] The names of the fields of each tool's input and of what `cronList` returns. TIM-540 lists the tool fields as not settled.
- **CRON-G5** [builder] The retention period of `MessageRetention` on the `Timer` entity. TIM-543 turns it on without a period.
- **CRON-G13** [builder] The wording of the due and late line, of the two-line prompt chunk and of every tool result other than "queued" (TIM-540).
- **CRON-G20** [builder] Whether cron has any settings of its own. No ticket names one (TIM-548).

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| CRON-1 | TIM-540 body and resolution, map "Agreed at charting" | charting | not run |  | `rule` | `timers-cron` |
| CRON-2 | TIM-540 items 6 and 8 | Tim | run |  | `rule` | `timers-cron` |
| CRON-3 | TIM-530 item 5, TIM-540 item 12 | Tim | not run |  | `rule` | `plugin-api` |
| CRON-4 | TIM-540 round 2 and section "What changes in the plugin API" | Tim | run |  | `rule` | `timers-cron` |
| CRON-5 | TIM-540 section "What changes in the plugin API" | Tim | not run |  | `rule` | `timers-cron` |
| CRON-6 | TIM-540 round 2 and section "What changes in the plugin API" | Tim | not run |  | `rule` | `timers-cron` |
| CRON-7 | TIM-540 item 6 | Tim | run |  | `rule` | `timers-cron` |
| CRON-8 | TIM-540 section "What changes in the plugin API" and "How well each is supported" | Tim | read |  | `rule` | `timers-cron` |
| CRON-9 | TIM-540 item 16 and section "What changes in the plugin API" | Tim | run |  | `rule` | `timers-cron` |
| CRON-10 | TIM-549 item 8, TIM-559 round 3 SELF-G16 | Architect (Tim has not read) | not run | TIM-549, TIM-559 | `rule` | `timers-cron` |
| CRON-11 | TIM-540 item 13, changed by TIM-559 ruling on API-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| CRON-12 | TIM-540 item 6, TIM-543 resolution | Tim | run |  | `rule` | `timers-cron` |
| CRON-13 | TIM-540 item 6 | Tim | run |  | `rule` | `timers-cron` |
| CRON-14 | TIM-540 item 7, TIM-536 section "What the SQLite file holds" | Tim | run |  | `rule` | `timers-cron` |
| CRON-15 | TIM-540 item 7 | Tim | run |  | `rule` | `timers-cron` |
| CRON-16 | TIM-540 item 6, TIM-543 prototype comment | Tim | run |  | `rule` | `timers-cron` |
| CRON-17 | TIM-543 decision 2 | Tim | run |  | `rule` | `timers-cron` |
| CRON-18 | TIM-540 "Not settled here", answered by TIM-543 resolution | Tim | run |  | `rule` | `timers-cron` |
| CRON-19 | TIM-540 item 7 | Tim | run |  | `rule` | `timers-cron` |
| CRON-20 | TIM-540 item 12 | Tim | run |  | `rule` | `timers-cron` |
| CRON-21 | TIM-532 item 4, TIM-540 body | Tim | run |  | `rule` | `timers-cron` |
| CRON-22 | TIM-540 round 2 and item 10 | Tim | run |  | `rule` | `timers-cron` |
| CRON-23 | TIM-540 item 7 and "How well each is supported" | Tim | run |  | `rule` | `timers-cron` |
| CRON-24 | TIM-540 item 8 | Tim | run |  | `rule` | `timers-cron` |
| CRON-25 | TIM-540 item 17, TIM-543 prototype | Tim | run |  | `rule` | `timers-cron` |
| CRON-26 | TIM-540 item 9, TIM-543 prototype comment | Tim | run |  | `rule` | `timers-cron` |
| CRON-27 | TIM-543 body and prototype comment | Tim | run |  | `rule` | `timers-cron` |
| CRON-28 | TIM-540 comment "Changed by TIM-543", TIM-543 decision 3, TIM-557 item 12 for the tag | Tim, and Architect (Tim has not read) for the `GaveUp` tag | run | TIM-557 | `rule` | `timers-cron` |
| CRON-29 | TIM-543 prototype (scenario chain-after) | Tim | run |  | `rule` | `timers-cron` |
| CRON-30 | TIM-540 item 18, TIM-543 decision 4 | Tim | run |  | `rule` | `timers-cron` |
| CRON-31 | TIM-543 decision 4 | Tim | run |  | `rule` | `timers-cron` |
| CRON-32 | TIM-540 item 18, TIM-543 prototype comment | Tim | run |  | `rule` | `timers-cron` |
| CRON-33 | TIM-543 decision 4, TIM-541 body | Tim | run |  | `rule` | `timers-cron` |
| CRON-34 | TIM-540 item 18, amended by TIM-542 item 12 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-35 | TIM-542 items 12 and 30, TIM-548 item 7, TIM-559 round 3 C7 | Tim, and Architect (Tim has not read) for the off plugin | not run | TIM-548, TIM-559 | `rule` | `timers-cron` |
| CRON-36 | TIM-548 item 7 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `timers-cron` |
| CRON-37 | TIM-548 item 8 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-38 | TIM-547 items 6 and 10, TIM-552 scenario "changed" | Architect (Tim has not read) | run |  | `rule` | `timers-cron` |
| CRON-39 | TIM-547 item 13 | Architect (Tim has not read) | run |  | `rule` | `timers-cron` |
| CRON-40 | TIM-547 item 13, TIM-552 scenario "deadlines" | Architect (Tim has not read) | run |  | `rule` | `timers-cron` |
| CRON-41 | TIM-547 item 13 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-42 | TIM-533 item 11 | Tim | not run |  | `rule` | `plugin-api` |
| CRON-43 | TIM-540 item 14 | Tim | not run |  | `rule` | `plugin-api` |
| CRON-44 | TIM-540 item 15 | Tim | not run |  | `rule` | `plugin-api` |
| CRON-45 | TIM-540 item 19, amended by TIM-557 item 12 | Tim, and Architect (Tim has not read) for the closed set | not run | TIM-557 | `rule` | `failures` |
| CRON-46 | TIM-540 item 19, TIM-534 item 15, amended by TIM-557 items 36, 37 and 40 | Tim, and Architect (Tim has not read) for the notice having no key | not run | TIM-557 | `rule` | `plugin-api` |
| CRON-47 | TIM-535 resolution, TIM-544 answer 5, TIM-557 items 12, 14 and 36, changed by TIM-559 rulings on MOD-G11, SES-G10 and FAIL-G2, TIM-559 round 3 DIS-G25 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `plugin-api` |
| CRON-48 | TIM-540 item 2 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-49 | TIM-540 item 2 and body | Tim | not run |  | `rule` | `timers-cron` |
| CRON-50 | TIM-540 item 2 | Tim | read |  | `rule` | `timers-cron` |
| CRON-51 | TIM-540 item 2, TIM-539 item 3, TIM-542 item 16 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-52 | TIM-540 item 2, changed by TIM-559 ruling on CRON-G15 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-53 | TIM-540 item 5 and facts comment, TIM-536 body | Tim | read |  | `rule` | `timers-cron` |
| CRON-54 | TIM-540 item 1 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-55 | TIM-540 item 4 and body, TIM-530 resolution | Tim | not run |  | `rule` | `timers-cron` |
| CRON-56 | TIM-540 item 4 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-57 | TIM-540 item 9, TIM-559 round 3 on CRON-G21 for the exception | Tim, and Architect (Tim has not read) for the exception | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-58 | TIM-548 item 10 and "What this changes in closed tickets", amended by TIM-558 item 54 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-59 | TIM-530 item 9, TIM-540 "Passed on to other tickets" | Tim | not run |  | `rule` | `timers-cron` |
| CRON-60 | TIM-540 item 3 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-61 | TIM-540 items 2 and 4 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-62 | TIM-540 item 3 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-63 | TIM-540 items 3 and 14 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-64 | TIM-540 item 4 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-65 | TIM-540 items 3 and 11 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-66 | TIM-540 item 13, changed by TIM-559 ruling on API-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-67 | TIM-540 item 11 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-68 | TIM-540 item 3 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-69 | TIM-540 item 16, TIM-549 item 8 | Tim, and Architect (Tim has not read) for the skill's dependence on the wording | not run |  | `rule` | `timers-cron` |
| CRON-70 | TIM-540 item 16 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-71 | TIM-540 item 14 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-72 | TIM-540 item 10 | Tim | run |  | `rule` | `timers-cron` |
| CRON-73 | TIM-540 item 10 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-74 | TIM-540 item 10, amended by TIM-557 items 36 and 40 | Tim, and Architect (Tim has not read) for the reason in the line | not run | TIM-557 | `rule` | `timers-cron` |
| CRON-75 | TIM-540 item 10 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-76 | TIM-540 item 19 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-77 | TIM-557 item 16 and round 2 answer to Q9, amending TIM-540 items 10 and 19 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `timers-cron` |
| CRON-78 | TIM-540 item 17, changed by TIM-559 rulings on CRON-G8 and CRON-G9 and TIM-559 round 3 on CRON-G21 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-79 | TIM-540 item 17, changed by TIM-559 round 3 on CRON-G21 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-80 | TIM-534 item 6, TIM-540 item 18 | Tim | not run |  | `rule` | `timers-cron` |
| CRON-81 | TIM-548 items 2 and 7 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-82 | TIM-548 item 9, amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `timers-cron` |
| CRON-83 | TIM-557 item 34 and "What this changes in closed tickets" | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| CRON-84 | TIM-557 item 34, amending TIM-540 item 8 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `timers-cron` |
| CRON-85 | TIM-557 item 27, changed by TIM-559 ruling on SET-G11 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `timers-cron` |
| CRON-86 | TIM-557 item 13, TIM-559 cold read | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| CRON-87 | TIM-557 items 14 and 15, changed by TIM-559 rulings on CRON-G16 and FAIL-G2 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `plugin-api` |
| CRON-88 | TIM-557 items 12, 20 and 21 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| CRON-89 | TIM-557 item 16 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `timers-cron` |
| CRON-90 | TIM-558 items 8, 9, 17 and 51 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-91 | TIM-559 ruling on CRON-G2 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-92 | TIM-559 ruling on CRON-G2 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-93 | TIM-559 ruling on API-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| CRON-94 | TIM-559 ruling on CRON-G3 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRON-95 | TIM-559 rulings on SES-G4 and CRON-G3 | Architect (Tim has not read) | read |  | `rule` | `timers-cron` |
| CRON-96 | TIM-559 ruling on CRON-G4 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-97 | TIM-559 ruling on CRON-G4 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-98 | TIM-559 ruling on CRON-G4 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-99 | TIM-559 ruling on CRON-G4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| CRON-100 | TIM-559 ruling on CRON-G6 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-101 | TIM-559 ruling on CRON-G7 | Architect (Tim has not read) | read |  | `rule` | `timers-cron` |
| CRON-102 | TIM-559 ruling on CRON-G7 | Architect (Tim has not read) | read |  | `fact` | `timers-cron` |
| CRON-103 | TIM-559 ruling on CRON-G7 | Architect (Tim has not read) | read |  | `fact` | `timers-cron` |
| CRON-104 | TIM-559 ruling on CRON-G7 | Architect (Tim has not read) | read |  | `rule` | `timers-cron` |
| CRON-105 | TIM-559 ruling on CRON-G19, TIM-559 round 3 C7 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-106 | TIM-559 ruling on CRON-G19, TIM-559 round 3 C7 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-107 | TIM-559 ruling on CRON-G11 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| CRON-108 | TIM-559 ruling on CRON-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| CRON-109 | TIM-559 ruling on CRON-G1 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-110 | TIM-559 ruling on CRON-G1 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-111 | TIM-559 ruling on CRON-G1, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-112 | TIM-559 ruling on CRON-G10 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-113 | TIM-559 ruling on CRON-G10 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-114 | TIM-559 ruling on CRON-G18 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-115 | TIM-559 ruling on CRON-G18 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-116 | TIM-559 ruling on CRON-G18 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-117 | TIM-559 ruling on CRON-G1 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-118 | TIM-559 ruling on CRON-G1 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-119 | TIM-559 ruling on CRON-G17 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-120 | TIM-559 ruling on CRON-G17 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-121 | TIM-559 ruling on CRON-G12 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-122 | TIM-559 ruling on CRON-G14 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-123 | TIM-559 ruling on CRON-G14 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-124 | TIM-559 ruling on CRON-G14 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-125 | TIM-559 ruling on CRON-G14 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-126 | TIM-559 ruling on CRON-G15 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-127 | TIM-559 ruling on CRON-G15 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-128 | TIM-559 ruling on CRON-G8 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-129 | TIM-559 ruling on CRON-G8 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-130 | TIM-559 ruling on CRON-G8, TIM-559 round 3 on CRON-G21 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-131 | TIM-559 ruling on CRON-G9, TIM-559 round 3 API-G15 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-132 | TIM-559 ruling on CRON-G9 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-133 | TIM-559 ruling on CRON-G9 | Architect (Tim has not read) | not run |  | `definition` | - |
| CRON-134 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-135 | TIM-559 round 3 API-G15 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-136 | TIM-559 round 3 API-G13 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| CRON-137 | TIM-559 round 3 on CRON-G21 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CRON-138 | TIM-559 round 3 on CRON-G21 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
