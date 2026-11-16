# Plugin API

This part defines what a chad plugin file exports and everything a plugin can do through the API: the contribution functions, the services chad supplies, the hook budgets, the ordering guarantees and the limits. A plugin is a TypeScript file in the editable repo on the data volume that adds tools, prompt text, hooks, background work and scheduled turns to chad. How a plugin file is bundled, checked and loaded is in 07-plugin-loading.md, and what happens to work in flight when a plugin is swapped is in 08-apply-and-swap.md. The settings file is in 11-settings.md, the timer machinery behind scheduled turns is in 13-timers-and-cron.md, and the asphodel plugin that serves as the acceptance test is in 18-asphodel-plugin.md. Failures, logs and notices are in 16-failures-logs-status.md, and the tests are in 17-testing.md.

## What a plugin file exports

A plugin is built from Effect Layers. A Layer is Effect's unit of construction. It is a recipe that needs some services, may fail, and is built inside a scope that owns everything it acquired. Each contribution a plugin makes is one Layer, and the file's default export is all of them merged.

- **API-1** A plugin is one file, `plugins/<name>.ts`, or one directory, `plugins/<name>/index.ts` with the local files it imports. The plugin's name is that file or directory name, so the file cannot disagree with the name the CLI uses.
- **API-2** A plugin file's default export is a `Plugin.Plugin<E>`, which is a Layer of type `Layer<never, E, Plugin.Services>` that carries a brand. It provides nothing and needs only the services chad supplies.
- **API-3** chad builds a plugin's Layer once per load, in a scope of its own. Unloading or reloading the plugin closes that scope, which runs the plugin's finalizers and interrupts its scoped fibers.
- **API-4** Each contribution function returns a Layer: `Plugin.toolkit`, `Plugin.prompt`, `Plugin.beforeTurn`, `Plugin.afterTurn`, `Plugin.onSession` and `Plugin.background`.
- **API-5** `Plugin.make` is `Layer.mergeAll` plus a compile-time check that only chad's services are still needed. A plugin provides its own services to its Layers before it calls `Plugin.make`. A Layer that still needs one of the plugin's own services fails to compile at `Plugin.make`, and the error names the missing service. Applying `Layer.provide` after `Plugin.make` is a compile error.
- **API-6** A file can export a bare Layer without calling `Plugin.make`, so chad's check before a load tests the default export with `Plugin.isPlugin` and refuses one that fails the test. The check is described in 07-plugin-loading.md.
- **API-102** `Plugin.make` returns a value that is branded as a `Plugin.Plugin`, in its type and at runtime. A Layer that `Plugin.make` did not return carries no brand, even when it needs only chad's services.
- **API-103** `chad/Plugin` exports `isPlugin`, which returns true only for a value that `Plugin.make` returned.
- **API-7** Two contributions of one plugin that each provide the same service Layer share one instance of that service, and the instance stays open until the plugin's scope closes.
- **API-8** A plugin adds no commands to the chad CLI.

The smallest plugin contributes one tool:

```ts
import { Plugin } from "chad"
import { Tool, Toolkit } from "effect/ai"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"

const Dice = Toolkit.make(
  Tool.make("rollDice", {
    description: "Roll one die and return the face it lands on.",
    parameters: Schema.Struct({ sides: Schema.Int }),
    success: Schema.Struct({ rolled: Schema.Int })
  })
)

export default Plugin.make(
  Plugin.toolkit(Dice).pipe(
    Layer.provide(Dice.toLayer({
      rollDice: ({ sides }) => Random.nextIntBetween(1, sides + 1).pipe(Effect.map((rolled) => ({ rolled })))
    }))
  )
)
```

A plugin with several contributions and a service of its own provides that service to each Layer that needs it. Here `Forecasts` is the plugin's own `Context.Service`, which holds an HTTP client and a refresh fiber:

```ts
// Contribution 1: a tool.
const WeatherTools = Plugin.toolkit(Weather).pipe(
  Layer.provide(Weather.toLayer(Effect.gen(function*() {
    const forecasts = yield* Forecasts
    return Weather.of({
      weatherForecast: ({ days }) => forecasts.forecast(days).pipe(Effect.mapError((error) => error.message))
    })
  }))),
  Layer.provide(Forecasts.layer)
)

// Contribution 2: a prompt chunk, read from what the fiber last fetched.
const TodayChunk = Plugin.prompt(() => Effect.flatMap(Forecasts, (forecasts) => forecasts.today)).pipe(
  Layer.provide(Forecasts.layer)
)

// Both Layers provide `Forecasts.layer`. A Layer is built once per plugin
// load, so they share one client and one fiber.
export default Plugin.make(WeatherTools, TodayChunk)
```

The check can also be the last step of a pipe:

```ts
export default Layer.mergeAll(WeatherTools, TodayChunk).pipe(
  Layer.provide(Forecasts.layer),
  Plugin.make
)
```

## What a plugin file can import

- **API-9** The `chad` package's `exports` lists `.`, `./Plugin`, `./Session` and `./Turns` and nothing else. Those four are the only modules a plugin can import from chad, and an import of any other path, such as `chad/daemon`, fails the type-check.
- **API-10** A plugin has no npm dependencies of its own. The packages the plugin API promises to a plugin are `chad`, `effect` and Node's built-in modules, and removing one of those three is a breaking change. An import of a package the image does not ship fails the type-check. See 01-image-and-volume.md.
- **API-104** chad's other direct dependencies resolve when a plugin imports them, but they are not part of the plugin API and a release can remove one. The `self-edit` skill says so, as described in 14-self-edit-skill.md.
- **API-11** A plugin is bundled to CJS before it runs, so a plugin file cannot use top-level await and its `import.meta` is empty. A plugin therefore cannot find files that sit next to it. See 07-plugin-loading.md.
- **API-12** Every exported member and every interface property of the plugin API has a doc comment, and a check in CI fails the build when one is missing. The check is in 17-testing.md. The declaration files are what the agent reads to learn the API. In the image they are `/data/repo/node_modules/chad/dist/Plugin.d.ts`, `Session.d.ts` and `Turns.d.ts`.
- **API-13** The TypeScript source of the bundled plugins ships inside the package that `import { Plugin } from "chad"` resolves to, as worked examples of the API. How the agent reaches them is in 14-self-edit-skill.md.
- **API-96** The `chad` package gives plugin authors no test helper in v1. How plugins are tested is in 17-testing.md.

## Services chad supplies

`Plugin.Services` is the full set a plugin's Layer may require. Anything else is the plugin's own to provide before `Plugin.make`.

| Service | What it is |
| --- | --- |
| `Plugin.PluginContext` | The plugin's name, its key-value store and the owner ids. |
| `Turns.Turns` | Starts a turn now or on a schedule. |
| `Chat` from `effect/chat` | Posts to a thread without the agent. |
| `HttpClient` from `effect/http` | The host's HTTP client. |
| `FileSystem` | Effect's file system service. |
| `Path` | Effect's path service. |
| `DateTime.CurrentTimeZone` | The owner's timezone. |

- **API-14** chad supplies exactly these services to a plugin's Layer: `PluginContext`, `Turns`, effect/chat's `Chat`, `HttpClient`, `FileSystem`, `Path` and `DateTime.CurrentTimeZone`.
- **API-15** `PluginContext.name` is the plugin's name, as defined in API-1.
- **API-16** `PluginContext.owners` holds the ids allowed to trigger chad, each as `<platform>:<id>`. chad reads them when the plugin loads, and a change to the owners reloads the plugins.
- **API-17** chad holds one owner timezone and supplies it as Effect's `DateTime.CurrentTimeZone`. It is supplied at load like the owner ids, and a change made with `chad timezone` reloads the plugins the way an owner change does. Where the timezone is stored is in 10-cli.md.
- **API-18** A plugin posts to a thread without the agent through effect/chat's `Chat` service. effect/chat cannot open a direct message from a user id, so a plugin can only post to, or start a turn in, a thread that already exists on the platform. chad does not need to have a session there, as API-116 to API-118 describe.
- **API-19** The `HttpClient` a plugin gets is the host's own. It speaks http and https, and a plugin does not provide a client of its own.

## The key-value store

- **API-20** A plugin's state is `PluginContext.store`, an Effect `KeyValueStore` in chad's SQLite file that only that plugin can see.
- **API-21** chad builds each plugin's store on a table of its own through `KeyValueStore.layerSql({ table })`, so `keys`, `size` and `isEmpty` read only that plugin's keys. See 02-storage.md.
- **API-22** The store has no expiry. A plugin prunes its own keys.
- **API-23** A plugin that is removed or turned off keeps its table and its data until `chad plugin purge <name>` drops them. Which plugins the purge accepts is in 11-settings.md, and the command is in 10-cli.md.
- **API-24** A plugin gets no `SqlClient` and no directory of its own.

## Settings through Config

A plugin reads its settings and secrets with Effect's `Config`. The file that holds them, `chad.json`, and what an apply checks in it are in 11-settings.md.

- **API-25** A plugin's `Config` reads from `ConfigProvider.fromUnknown` over that plugin's `settings` object in `chad.json` and nothing else. `Config.String("url")` reads `plugins.<name>.settings.url`. Nested objects and arrays are read as JSON. There is no fallback to process env.
- **API-26** chad installs the plugin's ConfigProvider for the load and keeps it installed for the plugin's tool handlers, hooks and background fibers, so a `Config` read at call time sees the settings that version loaded with and never the daemon's process env.
- **API-27** A secret is read with `Config.Redacted("token")`. In `chad.json` its value is written `${NAME}`, and chad expands `${NAME}` and `${NAME:-default}` in every string of the plugin's settings before it builds the provider. The expansion rules are in 11-settings.md.
- **API-28** A missing value fails the plugin's load with an error that names the key, for example `Expected string at ["bank"]`. An empty string reads as missing, so a plugin cannot be given "" as a value.
- **API-29** The CLI cannot list a plugin's settings without loading it. chad's provider records every key a plugin asks for, and `chad check`, `chad apply` and `chad status` report them as described in 11-settings.md.

## Tools

- **API-30** `Plugin.toolkit(toolkit)` adds an Effect `Toolkit` to every session's agent. It takes the toolkit only. The handlers come from `toolkit.toLayer`, which the plugin provides to the Layer that `Plugin.toolkit` returns.
- **API-31** A tool learns its session and turn by listing `Session.CurrentSession` in its `dependencies`. Any other dependency of a tool comes from the plugin's own Layers.
- **API-32** chad builds one clanka Agent per session and provides `CurrentSession` to it. `CurrentSession.session` is the session, and `CurrentSession.turn` reads a reference that chad sets when a turn starts.
- **API-136** A `Session` carries `directory`, the absolute path of the directory its agent works in. The agent's scripts run there, so a tool handler resolves a relative path the agent gives against it.
- **API-105** The type of `CurrentSession.turn` is `Effect<Option<Turn>>`. It stays an `Option` although clanka keeps a turn open while a background sub-agent runs, so a tool handler handles `None`.
- **API-33** A tool name that another plugin or clanka already uses fails the load, and the error names who holds the name. What a boot does with such a plugin is in 07-plugin-loading.md.
- **API-34** A sub-agent shares the main agent's handlers, and a handler cannot tell which of the two called it. A sub-agent inside a turn the owner started can therefore call a plugin's owner-only tools, which is accepted.
- **API-35** A tool handler that fails or dies fails only that call. clanka returns the failure to the calling script and the turn continues.
- **API-36** chad wraps every plugin tool handler. Once a swap replaces a plugin's running version, a running turn in any session cannot call that plugin's tools until the turn ends. The refusal rules are in 08-apply-and-swap.md.
- **API-97** A log call a plugin makes inside a tool handler is printed into the calling script's output, and chad writes a copy to its own log with the plugin's name, the session and the turn, at the level the plugin gave it. A log call a plugin makes anywhere else goes to chad's log only. The logger is in 16-failures-logs-status.md.
- **API-106** chad sets the plugin's name around everything it runs for a plugin, which is the Layer build, the tool handlers, the hooks, the prompt render, the finalizers and the `Plugin.background` fibers that chad forks at activation. A log line written from any of them carries the plugin's name.
- **API-125** chad writes every line a plugin logs through Effect's logger to its own log under the event name `plugin.log`, from whichever of the places in API-106 the line came. The table of event names is in 16-failures-logs-status.md.
- **API-37** A plugin contributes no skills and no MCP servers. See 12-skills-and-mcp.md.

## Prompt chunks

A prompt chunk is text a plugin appends to the system prompt.

- **API-38** `Plugin.prompt(render)` contributes one chunk. `render` receives the session and returns the text. An empty string means no chunk.
- **API-39** chad calls `render` before every turn and compares the text with what that session last saw. A changed chunk reaches the session in an update message while the system prompt stays frozen, as described in 08-apply-and-swap.md.
- **API-40** A render that fails or runs past its budget leaves the session with the text it last saw. It does not count as the chunk being removed, and no update message is sent for the failure or for the unchanged text after it.
- **API-41** A plugin whose chunk must stay fixed for a session keeps the text itself, in its store, and returns what it kept.

## Hook budgets and failing soft

A hook is a function a plugin registers for chad to call. The hooks are the prompt render, `beforeTurn`, `afterTurn` and `onSession`, and each has a time budget.

| Hook | Default budget | Where it runs |
| --- | --- | --- |
| `Plugin.prompt` render | 2 seconds | Before every turn, on the reply path. |
| `Plugin.beforeTurn` | 5 seconds | When a turn starts, on the reply path. |
| `Plugin.afterTurn` | 30 seconds | After a turn ends, off the reply path. |
| `Plugin.onSession` | 10 seconds | After a reset or a compaction, off the reply path. |

- **API-42** The default budgets are 2 seconds for the prompt chunk, 5 seconds for `beforeTurn`, 30 seconds for `afterTurn` and 10 seconds for `onSession`. A plugin can pass its own `timeout` in the hook's options.
- **API-43** A hook that fails, dies or runs past its budget is logged and skipped, and the turn carries on without it.
- **API-44** After 3 failures in a row of the same hook, chad sends the owner one notice under the key `hook-failing:<plugin>:<hook>`. A success of the hook, a restart of the daemon and a swap of the plugin each start the count again, as 09-repo-and-recovery.md states. chad never disables a plugin by itself. The notice rule, the wording and where the notice goes are in 16-failures-logs-status.md.
- **API-45** A hook may use services. They become requirements of the Layer the hook function returns, so the plugin's own Layers have to provide them before `Plugin.make`.
- **API-46** Hooks and tool handlers run on the daemon's main thread. A synchronous loop in a plugin freezes the whole daemon, and no hook budget can interrupt it.
- **API-47** While chad swaps plugin versions, everything in flight into the old version has one deadline of 30 seconds. A hook still running at that deadline is interrupted and logged like a hook past its budget, whatever `timeout` the plugin gave it. See 08-apply-and-swap.md.
- **API-98** The four default budgets are values of chad's `Timings` service, which is described in 17-testing.md.

## Before a turn

A turn is one run of the agent in a session, from the prompt that starts it to its outcome.

- **API-48** `beforeTurn` hooks run when a turn starts, on the reply path. They do not run for a message that steers a running turn.
- **API-49** A string that a `beforeTurn` hook returns reaches the model as its own user message, ahead of the owner's message in the same `send`, wrapped as `<plugin-context plugin="name">`. The order in a turn is the update message, then the hook messages in plugin name order, then the owner's message. The update message holds the chunk changes and the lines that tell the model what chad posted in the thread, which are in 16-failures-logs-status.md. The text stays in the history until a compaction.
- **API-50** `Turn.prompt` is the text chad sends the model to start the turn. It includes lines chad adds for attachments and, for a resumed turn, the restart note. A plugin that wants the owner's words reads `turn.origin.message.text`, which exists only when `turn.origin._tag === "Message"`.
- **API-51** A turn resumed after a restart keeps the first attempt's id and origin and has `resumed: true`. `beforeTurn` runs again for every start after the first, and the plugin decides what to do. A graceful stop does not count against a turn, so a turn can reach `beforeTurn` with `resumed: true` more than twice. `beforeTurn` does not run when chad gives up on a turn. The resume rules are in 03-sessions-and-turns.md.
- **API-52** A turn that starts while a swap is running waits for the activation before its `beforeTurn` hooks run, so they run on the new versions.

## After a turn

- **API-53** `afterTurn` hooks run after a turn ends, off the reply path. One plugin's calls run one at a time, in the order the turns ended. Different plugins' queues run side by side.
- **API-54** `afterTurn` runs once per turn, when the attempt that finishes ends. It runs for a turn the owner stopped, with the outcome `Stopped`. If chad gives up on a resumed turn, `afterTurn` runs once with `Failed` and the reason `GaveUp`.
- **API-55** `TurnEnded.steers` holds the owner's messages that steered the turn, which are the ones chad recorded as having steered it while it ran. The record is in 03-sessions-and-turns.md. `TurnEnded.appended` holds everything the turn added to the session's history. chad does not mask or redact what an `afterTurn` hook receives.
- **API-134** A message that was still waiting to steer when the turn was stopped or its session was reset is not in `TurnEnded.steers`. chad dropped it before the agent read it, and a plugin that stores turns would otherwise record text the model never saw. The dropping is in 03-sessions-and-turns.md.
- **API-107** chad builds `TurnEnded.appended` after the history reconcile at the turn's end. It therefore includes the messages that only the reconcile wrote, which happens when a Stop cut chad's reading of the turn's stream short. The reconcile is in 16-failures-logs-status.md.
- **API-56** `afterTurn` is not durable. A turn that ends just as chad is killed is never passed to it.
- **API-57** Nothing a plugin keeps in memory is sure to survive from a tool call or `beforeTurn` to `afterTurn`, because a reload can happen in between. What must survive goes in the plugin's store.
- **API-99** A turn whose answer could not be posted to a thread that still exists ends `Answered`. See 16-failures-logs-status.md.

## Session events

- **API-58** `onSession` hooks receive `Reset` and `Compacted`. They are queued with the plugin's `afterTurn` calls and run one at a time in the same queue.
- **API-59** `Reset` is sent when the owner resets a thread with `/new`. It carries `previous`, the session that is over, and `session`, the one that replaces it.
- **API-60** `Compacted` is sent when clanka replaced a session's history with a summary. It is delivered once after the turn ends, after that turn's `afterTurn`, even if the turn compacted twice, and never in the middle of a turn. The turn it belongs to is the one whose `send` stream carried clanka's `HistoryReplaced` output part, which can be a later turn than the one that started the summarizer. When the history reconcile at a turn's end finds a replacement that the stream did not deliver, `Compacted` is delivered as that turn's. The reconcile is in 16-failures-logs-status.md.
- **API-61** After a turn that compacted, chad finishes that session's queued `afterTurn` and `Compacted` hooks, inside their budgets, before the session's next turn starts. A message that arrives during the wait is not lost and runs afterwards. With the default budgets the wait is at most the 30 second and 10 second budgets one after the other for the slowest plugin. It measured 39.97 seconds with one plugin whose calls hang and 272 ms with hooks that return.
- **API-126** The first turn of the session that `/new` starts waits for the hooks that each plugin has queued ahead of it, the last of which is `Reset`. A `Reset` hook has therefore run or run out of its budget before the new session's first `beforeTurn`, so a plugin that flushes its state on `Reset` has flushed it by then. The wait, its bounds and where it sits are in 03-sessions-and-turns.md.
- **API-127** The doc comment of `Plugin.onSession` says that a `Reset` hook has run or timed out before the new session's first `beforeTurn`.
- **API-62** `SessionEvent` is an open union. More cases may be added, so a plugin matches with a default.
- **API-63** Plugins get no call that reads a session's history. A plugin handling `Reset` cannot read the old session.

## The hook queue across reloads and stops

- **API-64** The queue of hooks off the reply path belongs to the plugin's name and not to a version. A hook that is running when a swap starts finishes on the old version, inside the drain deadline. Hooks still queued at a swap run on the new version.
- **API-65** A queued hook of a kind the new version no longer registers is dropped and logged. When a plugin is removed, turned off, or switched off by `chad safe on`, its queued hooks are dropped and logged.
- **API-66** The `afterTurn` of a turn that started before a swap and ended after it goes to whichever version is current when the hook runs.
- **API-67** On a graceful stop chad runs the hooks queued off the reply path, inside their budgets, before it closes the plugins' scopes. On a kill they are lost, and a `Compacted` hook lost that way is never delivered. The time a stop allows for queued hooks is in 01-image-and-volume.md.

## Background fibers

- **API-68** `Plugin.background(effect)` returns a Layer like the other contribution functions. It forks the effect into the plugin's scope, and the fiber starts only when chad activates this version, which is after the previous version's scope has closed.
- **API-69** A fiber that a plugin forks directly while its Layer builds runs next to the previous version's fiber for a moment after a reload. A plugin uses `Plugin.background` for any fiber that must not do that.
- **API-70** `Plugin.background` fibers are interrupted when their version closes, and the swap's drain does not wait for them. The two versions' background work never overlaps unless old code ignores interruption, which chad logs.
- **API-108** A `Plugin.background` fiber that fails or dies is logged as one error under the plugin's name. chad does not start it again.
- **API-109** A `Plugin.background` fiber that returns normally is not an error. chad logs no error for it and does not start it again.
- **API-110** A `Plugin.background` fiber that is interrupted because its version is unloaded logs nothing.
- **API-111** The doc comment of `Plugin.background` says that a fiber which must keep running retries itself.
- **API-128** `Plugin.background` accepts an effect with any error type. It removes `Scope.Scope` from the effect's requirements, so the effect may use the plugin's scope, and every other requirement becomes a requirement of the Layer it returns.

## Starting a turn

- **API-71** A plugin starts a turn with `Turns.start({ thread, prompt, label, mention? })`. The turn runs in the session of that thread and its answer is posted there, the same way an owner message's would be. There is no option for a fresh session.
- **API-72** A plugin-started turn waits for the session to be idle and never steers a running turn. The request is persisted, so it survives a restart and restores a session that was passivated.
- **API-73** Every call to `Turns.start` gets a fresh id, so two calls are two turns.
- **API-74** Hooks see a plugin-started turn with `origin._tag === "Plugin"`, the plugin's name and the `label` the plugin gave.
- **API-75** A plugin-started turn looks like any other turn in chat, with a status message and a Stop button. Its answer is a plain post, because there is no message to reply to. See 04-discord.md, which also says what such a turn shows while it waits on a pending login.
- **API-76** `mention` is an optional user id. chad puts that mention at the start of the answer in a server thread and ignores it in a direct message. chad drops a mention whose id is not on the owner list when it posts, so a plugin cannot ping anyone but an owner. The message for a failed turn starts with the mention too, as described in 16-failures-logs-status.md. How the mention is made to notify is in 13-timers-and-cron.md.
- **API-77** For every plugin-started turn, an answer that is exactly `[SILENT]` is not posted, and the status message is removed as usual. The turn's `Outcome` is `Answered` with the text `[SILENT]`, for `afterTurn` and for the caller of `Turns.start`, so a plugin can tell.
- **API-78** `Turns.start` returns the turn's `Outcome`, which is `Answered` with the answer text, `Failed` with a reason, or `Stopped`. `Failed.reason` is a tagged value from a closed set of seven tags, which are `ThreadGone`, `ModelError`, `UsageLimit`, `LoginFailed`, `LoggedOut`, `GaveUp` and `Internal`. What each tag means, and what chad posts for it, is in 16-failures-logs-status.md.
- **API-112** The fields of `Failed.reason` have these types. `ModelError.reason` and `ModelError.message` are strings, and `ModelError.retries` is a number. `UsageLimit.resetsAt` is an optional `DateTime.Utc`. `LoginFailed.reason` is one of `TimedOut`, `DeviceFlowFailed`, `TokenExchangeFailed` and `RefreshFailed`. `Internal.message` is a string.
- **API-113** `ModelError.reason` holds the reason tag of the `AiError`, with one exception. A turn that chad ended at the silence bound has the reason `TurnTimeout`, which is chad's own value. The silence bound is in 16-failures-logs-status.md.
- **API-79** `Turns.start` called from a tool handler for the thread of the handler's own turn fails at once, with a defect whose message names `Turns.queue`. The turn it asked for would queue behind the turn that called the tool, so a call that waited would deadlock. The message reads "Turns.start cannot run a turn in the thread of the turn that called this tool, because that turn would wait for this one. Use Turns.queue, which returns once the turn is queued."
- **API-114** `Turns.queue(options)` takes the same options as `Turns.start` and returns `Effect<void>`. It returns once the request is saved and does not wait for the turn. A tool handler uses it to queue a turn in its own thread.
- **API-115** A turn queued with `Turns.queue` is started and treated the way a turn from `Turns.start` is. Every call queues its own turn, and a plugin that needs the outcome reads it in `afterTurn`.
- **API-137** `Turns.queue` takes an optional `timer`, the name of one of the plugin's timers, scheduled or not. The turn is then one of that timer's runs. The timer's scheduled runs and the turns queued for it start one at a time, in the order they were saved, whichever threads they run in, and this holds across a kill and a restart. A cancel or a replace of the timer leaves the turns queued for it. Hooks see the name on `origin.queuedFor`. The request is the only thing the call saves.
- **API-129** `Turns.start`, `Turns.queue`, `Turns.schedule` and `Turns.cancel` declare no error type, and no release adds one, because a new error type would fail the type-check of every applied plugin at an image upgrade. A failure of the call itself is therefore a defect, and its message is a text written for the model. API-79, API-130, API-133 and API-135 name the failures. clanka returns a handler's defect to the calling script, as API-35 says.
- **API-130** `Turns.queue` fails with such a defect when the request cannot be saved, which happens on a full disk. The message says that the turn was not queued and why. It reads "The turn was not queued, because chad could not save the request: <reason>", where the reason is the first line of the failure.
- **API-135** `Turns.start` fails with such a defect when its request cannot be saved, which happens on a full disk. The message says that the turn was not started and why. It reads "The turn was not started, because chad could not save the request: <reason>", where the reason is the first line of the failure. No turn starts, so the call has no `Outcome` to return, and no `afterTurn` hook runs for a turn that did not run.
- **API-80** `Turns.start` and `Turns.queue`, called by a version that is not active yet, wait for the activation.
- **API-131** A `Turns` call that a plugin's Layer build waits on cannot return, because the activation it waits for comes after the build. The deadline of the Layer build ends it, and the load's error names `Plugin.background` as the place for the call. The deadline is in 07-plugin-loading.md. `Turns.scheduled` is the call most likely to be written there, by a plugin that reads its timers while it builds.
- **API-81** A background fiber of an old version that is waiting on `Turns.start` when the version closes loses the outcome, while the turn carries on. A plugin that needs the outcome reads it in `afterTurn` or from its store.
- **API-82** chad's core adds no line to the prompt of a plugin-started turn. The prompt a plugin passes to `Turns.start`, `Turns.queue` or `Turns.schedule` has to state what started the turn and that nobody is there to answer questions, and the doc comments of all three calls say so. The agent reads that line to know it must not apply changes unasked, as 14-self-edit-skill.md describes.
- **API-83** A plugin-started turn has no owner present and never starts a model login. On a chad that is logged out with no login pending it ends at once, as `Failed` with the reason `LoggedOut`. When a login is already pending it waits for that login, and it ends as `Failed` with the reason `LoginFailed` if the login fails. The rule is in 05-model-and-login.md.
- **API-100** `Turns.start` takes a turn's outcome from the session in the same process, and not only from the reply that Effect Cluster saves for the persisted request. A call therefore returns when that reply could not be saved, which happens on a full disk. The full disk rules are in 16-failures-logs-status.md. The `Outcome` it returns is the one the session produced when the turn ended, so an `Answered` outcome carries the answer's text. A call does not outlive the process and every call has a request of its own. So a caller that is still waiting can receive a reply that chad made from the `turns` row of a turn that had already ended only if the entity failed between writing the row and saving the reply. That reply is `Answered` with an empty text (see 03-sessions-and-turns.md), and the doc comment of `Outcome` says that the text is empty in that case.
- **API-116** `Turns.start`, `Turns.queue` and `Turns.schedule` accept a thread that chad has no session in. A direct message or an existing Discord thread that has no session gets one for the turn. The session's thread is that direct message or that thread itself, and chad opens no new Discord thread for it. Its kind is `direct` or `thread`, read from effect/chat as 03-sessions-and-turns.md describes. A plugin-started turn has no message behind it, so it needs no mention, and what an owner's own first message in such a thread does, which is in 03-sessions-and-turns.md, does not decide it.
- **API-117** A plugin-started turn for a thread that the platform does not have ends `Failed` with the reason `ThreadGone`.
- **API-118** A plugin-started turn for a plain server channel runs in a session of kind `channel` that belongs to the channel, and its answer is posted in the channel. Only plugin-started turns run in that session, and on Discord no other session has that kind. `/stop`, the Stop button and `/new` act on it as on any other session. The rule for the kind is in 03-sessions-and-turns.md.
- **API-119** An owner's message in a plain server channel never starts or steers a turn in the channel's session. A mention there opens a Discord thread with a session of its own and any other message is ignored, as in a channel that has no session. Otherwise a digest channel named in a plugin's settings would turn every owner message in it into a trigger. See 03-sessions-and-turns.md.
- **API-120** A plugin-started turn that ends `Failed` with `LoggedOut`, `LoginFailed` or `UsageLimit` posts nothing in its thread. The rule, and the notice chad sends instead, are in 16-failures-logs-status.md.

## Scheduling a turn

A timer is a scheduled run that chad's core holds for a plugin. The table and the entity behind it are in 13-timers-and-cron.md.

- **API-84** `Turns.schedule` takes a timer `name`, either `at` with one time or `cron` with a 5-field cron expression and a `timezone`, and the same `thread`, `prompt`, `label` and optional `mention` as `Turns.start`.
- **API-121** Every time in the `Turns` API is a `DateTime.Utc`, which covers `at` in `Turns.schedule`, `Timer.nextRun` and `Origin.timer.scheduledAt`. `timezone` is an IANA timezone name, as a string.
- **API-122** `Timer` has the fields `name`, `schedule`, `thread`, `prompt`, `label`, the optional `mention` and `nextRun`. They mirror the timer's row in the `timers` table, which is in 13-timers-and-cron.md, without the plugin's name.
- **API-123** A cron expression passed to `Turns.schedule` follows the daylight saving behaviour of Effect's `Cron`, and chad adds no policy of its own. A time inside a skipped hour runs once, moved on by the length of the gap, so 02:30 on a night that skips 02:00 to 03:00 runs at 03:30. A time inside a repeated hour runs once, on the first occurrence, so an hourly timer misses one real hour each autumn.
- **API-124** The doc comment of `Turns.schedule` states the daylight saving behaviour of API-123.
- **API-85** Timer names are scoped to the plugin. Scheduling under a name that already has a run replaces it.
- **API-86** The core holds the schedule and starts the turn. For a scheduled run the core derives the turn's key from the plugin, the timer name and the scheduled time, so one scheduled time starts one turn. The plugin passes no key.
- **API-87** Hooks see a scheduled turn with `origin._tag === "Plugin"` and `origin.timer` set to the timer's name and the time the run was due.
- **API-88** The core schedules the next run of a recurring timer after the turn has ended, so two runs of one timer never overlap. Only the next run is ever stored. The core learns that the turn has ended from the session in the same process, as described in 13-timers-and-cron.md.
- **API-89** A stored run that is overdue fires once when chad comes back, however many runs were missed.
- **API-90** `Turns.cancel(name)` cancels the calling plugin's timer of that name. It does not stop a run that has started, and a timer cancelled during a run stays cancelled.
- **API-91** `Turns.scheduled()` returns the calling plugin's timers only.
- **API-132** `Turns.schedule`, `Turns.cancel` and `Turns.scheduled`, called by a version that is not active yet, wait for the activation as `Turns.start` does. Cron's use of them is in 13-timers-and-cron.md.
- **API-133** `Turns.schedule` and `Turns.cancel` fail with a defect of the kind in API-129 when the change cannot be saved, which happens on a full disk. The message says that nothing was changed and why.
- **API-92** A timer whose plugin is not loaded, is turned off, or is in the middle of a swap is held until the plugin is active again. If it is overdue by then it fires once. Removing a plugin's file or turning the plugin off keeps its timers. `chad plugin purge <name>` deletes them, and 11-settings.md says which plugins it accepts. `chad status` lists the timers held for a plugin that is not loaded, as described in 16-failures-logs-status.md.

## What a plugin cannot do

- **API-93** A plugin cannot start a turn in a fresh session, choose the model for a turn, or open a direct message from a user id.
- **API-94** A plugin cannot wait for MCP servers. When one apply changes plugins and `mcp.json`, the plugins activate without waiting for the MCP layer to connect. See 12-skills-and-mcp.md.
- **API-101** A plugin has no call that sends the owner a notice. A plugin's warnings and errors are log lines, and `chad status` shows a count of them for each plugin, as described in 16-failures-logs-status.md.

The other limits are stated where they belong: no CLI commands (API-8), only four chad modules and the image's packages (API-9, API-10), no top-level await and an empty `import.meta` (API-11), key-value storage only (API-24), settings from `chad.json` only (API-25), no skills or MCP servers (API-37), no way to tell a sub-agent from the main agent (API-34), and no call that reads a session's history (API-63).

## The declaration files

These are the four declaration files of the `chad` package, as they sit under `dist/`. A line marked `// adjusted: <ticket>` differs from the prototype the files were built from, and a marker after the closing `*/` of a doc comment covers that comment. A service class appears the way the TypeScript compiler emits it, as a `_base` constant and a class that extends it. In chad's source it is written `class PluginContext extends Context.Service<PluginContext, { ... }>()("chad/Plugin/PluginContext") {}`.

- **API-95** The plugin API is the four declaration files below. `chad` re-exports the other three modules as the namespaces `Plugin`, `Session` and `Turns`.

`chad`, in `dist/index.d.ts`:

```ts
/**
 * The chad plugin API. A plugin file imports `Plugin`, `Session` and `Turns`
 * from here, or each module by its own path: `chad/Plugin`, `chad/Session`
 * and `chad/Turns`. Nothing else in the package can be imported.
 */ // adjusted: TIM-553

/** What a plugin file exports, the functions that add to chad, and the services chad supplies. */ // adjusted: TIM-549
export * as Plugin from "./Plugin.js" // adjusted: TIM-553

/** The values chad hands to hooks and tool handlers: sessions, turns and how they ended. */ // adjusted: TIM-549
export * as Session from "./Session.js" // adjusted: TIM-553

/** The service a plugin uses to start a turn now or on a schedule. */ // adjusted: TIM-549
export * as Turns from "./Turns.js" // adjusted: TIM-553
```

`chad/Plugin`, in `dist/Plugin.d.ts`:

```ts
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import type { Chat } from "effect/chat"
import type * as Context from "effect/Context"
import type * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as HttpClient from "effect/http/HttpClient"
import type * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import type * as KeyValueStore from "effect/persistence/KeyValueStore"
import type * as Scope from "effect/Scope" // adjusted: TIM-538
import type { CurrentSession, Session, SessionEvent, Turn, TurnEnded } from "./Session.js" // adjusted: TIM-553
import type { Turns } from "./Turns.js" // adjusted: TIM-553

declare const TypeId: unique symbol // adjusted: TIM-559

/**
 * A plugin file's default export is a Layer that provides nothing and needs
 * only what chad supplies. chad builds it once, in a scope of its own, when
 * the plugin is loaded. Unloading or reloading closes that scope.
 *
 * Only `make` returns one. The brand is what tells a `Plugin` from a bare
 * Layer that needs the same services.
 */ // adjusted: TIM-559
export interface Plugin<E = unknown> extends Layer.Layer<never, E, Services> { // adjusted: TIM-559
  /** The brand that `make` puts on the value it returns. */ // adjusted: TIM-559
  readonly [TypeId]: typeof TypeId // adjusted: TIM-559
} // adjusted: TIM-559

/**
 * What chad supplies to a plugin's Layer. `DateTime.CurrentTimeZone` is the
 * owner's timezone. It is read when the plugin loads, and a change to it
 * reloads the plugins.
 */ // adjusted: TIM-539, TIM-542
export type Services =
  | PluginContext
  | Turns
  | Chat.Chat
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | DateTime.CurrentTimeZone // adjusted: TIM-539

/**
 * `Layer.mergeAll`, plus a check that only chad's services are still needed.
 * A plugin provides its own services to its Layers before it calls `make`.
 * Providing them afterwards does not compile. The value it returns is
 * branded as a `Plugin`, in its type and at runtime.
 */ // adjusted: TIM-559
export declare const make: <
  Layers extends [Layer.Layer<never, any, Services>, ...Array<Layer.Layer<never, any, Services>>]
>(...layers: Layers) => Plugin<Layer.Error<Layers[number]>>

/**
 * True only for a value that `make` returned. chad's check before a load
 * uses it to refuse a file whose default export is a bare Layer.
 */ // adjusted: TIM-559
export declare const isPlugin: (u: unknown) => u is Plugin // adjusted: TIM-559

declare const PluginContext_base: Context.ServiceClass<
  PluginContext,
  "chad/Plugin/PluginContext",
  {
    /** The plugin's name, which is its file or directory name under `plugins/`. */ // adjusted: TIM-549
    readonly name: string
    /**
     * A key-value store in chad's SQLite file that only this plugin can see.
     * It has no expiry, so a plugin prunes its own keys.
     */ // adjusted: TIM-536
    readonly store: KeyValueStore.KeyValueStore
    /**
     * The ids allowed to trigger chad, as `<platform>:<id>`. Read when the
     * plugin loads. Changing the owners reloads the plugins.
     */
    readonly owners: ReadonlyArray<string> // adjusted: TIM-539
  }
>
/**
 * The plugin's own name, store and owner ids. Settings are not here. A plugin
 * reads them with Effect's `Config`, which sees only this plugin's
 * `settings` object in `chad.json`.
 */ // adjusted: TIM-548, TIM-549
export declare class PluginContext extends PluginContext_base {}

/**
 * Adds a toolkit to every session's agent. The handlers come from
 * `toolkit.toLayer`. A tool lists `Session.CurrentSession` in its
 * `dependencies` to learn its session and turn, and any other dependency
 * comes from the plugin's own Layers. A tool name that another plugin or
 * clanka already uses fails the load.
 */
export declare const toolkit: <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
) => Layer.Layer<
  never,
  never,
  PluginContext | Tool.HandlersFor<Tools> | Exclude<Tool.HandlerServices<Tools[keyof Tools]>, CurrentSession>
>

/** Options every hook takes. */ // adjusted: TIM-549
export interface HookOptions {
  /**
   * How long chad waits for the hook. A hook that fails, dies or runs past its
   * budget is logged and skipped. The turn carries on without it. While chad
   * swaps plugin versions, a hook still running 30 seconds into the swap is
   * interrupted whatever this says.
   */ // adjusted: TIM-547
  readonly timeout?: Duration.Input | undefined
}

/**
 * A chunk appended to the system prompt. An empty string means no chunk.
 * Default budget 2s.
 *
 * chad calls `render` before every turn and compares the text with what the
 * session last saw. A plugin whose chunk must stay fixed for a session keeps
 * the text in its store and returns what it kept.
 *
 * A render that fails or runs past its budget leaves the session with the
 * text it last saw. It does not count as the chunk being removed.
 */ // adjusted: TIM-531, TIM-539
export declare const prompt: <R = never>(
  render: (session: Session) => Effect.Effect<string, unknown, R>,
  options?: HookOptions
) => Layer.Layer<never, never, PluginContext | R>

/**
 * Runs when a turn starts, on the reply path, and not for a message that
 * steers a running turn. A returned string is added to the turn as context
 * for the model and stays in the history until a compaction. Runs again for a
 * turn that is resumed after a restart. Default budget 5s.
 */ // adjusted: TIM-532, TIM-539
export declare const beforeTurn: <R = never>(
  hook: (turn: Turn) => Effect.Effect<string | void, unknown, R>,
  options?: HookOptions
) => Layer.Layer<never, never, PluginContext | R>

/**
 * Runs after a turn ends, off the reply path, once per turn. One plugin's
 * calls run one at a time, in the order the turns ended. Default budget 30s.
 *
 * It is not durable. A turn that ends as chad is killed never reaches it. A
 * reload can happen between a tool call or `beforeTurn` and this hook, so
 * what must survive until here goes in the store and not in memory.
 */ // adjusted: TIM-539, TIM-547
export declare const afterTurn: <R = never>(
  hook: (ended: TurnEnded) => Effect.Effect<void, unknown, R>,
  options?: HookOptions
) => Layer.Layer<never, never, PluginContext | R>

/**
 * Runs when a session is reset or compacted. Queued with `afterTurn`.
 * Default budget 10s.
 *
 * A `Reset` hook has run or timed out before the new session's first
 * `beforeTurn`.
 */ // adjusted: TIM-559
export declare const onSession: <R = never>(
  hook: (event: SessionEvent) => Effect.Effect<void, unknown, R>,
  options?: HookOptions
) => Layer.Layer<never, never, PluginContext | R>

/**
 * Forks `effect` into the plugin's scope as a fiber for the plugin's whole
 * life. The fiber starts only when chad activates this version, which is
 * after the previous version's scope has closed, and it is interrupted when
 * this version is unloaded. A fiber forked directly while the Layer builds
 * runs next to the previous version's for a moment after a reload.
 *
 * A fiber that fails or dies is logged as one error under the plugin's name
 * and is not started again, so a fiber that must keep running retries
 * itself. A fiber that returns is not an error and is not started again.
 */ // adjusted: TIM-538, TIM-559
export declare const background: <E, R = never>( // adjusted: TIM-538
  effect: Effect.Effect<unknown, E, R> // adjusted: TIM-538
) => Layer.Layer<never, never, PluginContext | Exclude<R, Scope.Scope>> // adjusted: TIM-538
```

`chad/Session`, in `dist/Session.d.ts`:

```ts
import type * as Prompt from "effect/ai/Prompt"
import type { ChatMessage, ChatThread } from "effect/chat"
import type * as Context from "effect/Context"
import type * as DateTime from "effect/DateTime"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"

/**
 * One conversation. A chat thread has one session at a time, and a reset gives
 * the thread a new session with a new id.
 */
export interface Session {
  /** The session's id. A reset gives the thread a session with a new id. */ // adjusted: TIM-558
  readonly id: string
  /** `{ platform, id }`, for example `{ platform: "discord", id: "<channel id>" }`. */
  readonly thread: ChatThread.ChatThread
  /** The kind of chat thread the session is in. */ // adjusted: TIM-558
  readonly kind: "direct" | "channel" | "thread"
  /**
   * The absolute path of the directory the session's agent works in. Its
   * scripts run there, so a relative path the agent names is relative to it.
   */ // adjusted: API-136
  readonly directory: string
}

/** What started a turn. A plugin started it when there is no chat message behind it. */
export type Origin =
  | {
    readonly _tag: "Message"
    /** Carries `author: { id, name?, isBot }`, `text`, `timestamp` and `attachments`. */
    readonly message: ChatMessage.ChatMessage
  }
  | {
    readonly _tag: "Plugin"
    readonly plugin: string
    /** What the plugin called this turn, for example a cron job's name. */
    readonly label: string
    /**
     * The timer's name and the time the run was due, set when
     * `Turns.schedule` started the turn. Absent for a turn started with
     * `Turns.start`.
     */ // adjusted: TIM-540
    readonly timer?: { readonly name: string; readonly scheduledAt: DateTime.Utc } | undefined // adjusted: TIM-540
    /** The timer named by `Turns.queue`'s `timer`, among whose runs the turn waited its place. */ // adjusted: API-137
    readonly queuedFor?: string | undefined // adjusted: API-137
  }

/** One run of the agent in a session, from the prompt that starts it to its outcome. */ // adjusted: TIM-549
export interface Turn {
  /** The turn's id. A turn that is resumed after a restart keeps it. */ // adjusted: TIM-558
  readonly id: string
  /** The session the turn runs in. */ // adjusted: TIM-558
  readonly session: Session
  /** What started the turn. */ // adjusted: TIM-558
  readonly origin: Origin
  /**
   * The text chad sends the model to start the turn, before any plugin adds
   * context to it. It can differ from what the owner typed: chad adds lines
   * for attachments, and a resumed turn starts from a restart note. A plugin
   * that wants the owner's words reads `origin.message.text`.
   */
  readonly prompt: string
  /** When the turn started. */ // adjusted: TIM-558
  readonly startedAt: DateTime.Utc
  /**
   * True when this turn was cut off by a restart and is being run again. The
   * id and the origin are those of the first attempt.
   */
  readonly resumed: boolean // adjusted: TIM-539
}

/**
 * Why a turn failed. A closed set. The message chad posts for each case is
 * not part of this value.
 */ // adjusted: TIM-540, TIM-557
export type FailedReason = // adjusted: TIM-540
  | { // adjusted: TIM-557
    /** The turn's thread is gone. */ // adjusted: TIM-540
    readonly _tag: "ThreadGone" // adjusted: TIM-540
  } // adjusted: TIM-557
  | { // adjusted: TIM-557
    /**
     * The model request failed, kept failing after the retries, or the model
     * did not answer for 15 minutes.
     */ // adjusted: TIM-557
    readonly _tag: "ModelError" // adjusted: TIM-557
    /**
     * The reason tag of the `AiError`, or `TurnTimeout` when chad ended the
     * turn because the model did not answer for 15 minutes.
     */ // adjusted: TIM-557, TIM-559
    readonly reason: string // adjusted: TIM-557
    /** The error's message. */ // adjusted: TIM-557
    readonly message: string // adjusted: TIM-557
    /** How many retries were made before the turn ended. */ // adjusted: TIM-557
    readonly retries: number // adjusted: TIM-557
  } // adjusted: TIM-557
  | { // adjusted: TIM-557
    /** The provider said the plan's usage limit is reached. */ // adjusted: TIM-557
    readonly _tag: "UsageLimit" // adjusted: TIM-557
    /** When the limit resets. Absent when the provider's error carried no time. */ // adjusted: TIM-557
    readonly resetsAt?: DateTime.Utc | undefined // adjusted: TIM-557
  } // adjusted: TIM-557
  | { // adjusted: TIM-557
    /** A model login that the turn started, or was waiting on, did not succeed. */ // adjusted: TIM-557, TIM-559
    readonly _tag: "LoginFailed" // adjusted: TIM-557
    /** `TimedOut`, or one of clanka's `CodexAuthError` reasons. */ // adjusted: TIM-557
    readonly reason: "TimedOut" | "DeviceFlowFailed" | "TokenExchangeFailed" | "RefreshFailed" // adjusted: TIM-557
  } // adjusted: TIM-557
  | { // adjusted: TIM-557
    /**
     * A turn with no owner present, on a chad that is logged out with no
     * login pending. It ends at once.
     */ // adjusted: TIM-557, TIM-559
    readonly _tag: "LoggedOut" // adjusted: TIM-557
  } // adjusted: TIM-557
  | { // adjusted: TIM-557
    /** A resumed turn that chad stopped retrying. */ // adjusted: TIM-557
    readonly _tag: "GaveUp" // adjusted: TIM-557
  } // adjusted: TIM-557
  | { // adjusted: TIM-557
    /** Any other defect in chad or clanka. A full disk is one. */ // adjusted: TIM-557
    readonly _tag: "Internal" // adjusted: TIM-557
    /** The defect's message. */ // adjusted: TIM-557
    readonly message: string // adjusted: TIM-557
  } // adjusted: TIM-557

/**
 * How a turn ended. An answer that is exactly `[SILENT]` is `Answered` with
 * that text. An answer that could not be posted to a thread that still
 * exists is `Answered` too.
 */ // adjusted: TIM-549, TIM-557
export type Outcome =
  | { readonly _tag: "Answered"; readonly text: string }
  | { readonly _tag: "Failed"; readonly reason: FailedReason } // adjusted: TIM-540
  | { readonly _tag: "Stopped" }

/** What an `afterTurn` hook receives. */ // adjusted: TIM-549
export interface TurnEnded {
  /** The turn that ended. */ // adjusted: TIM-558
  readonly turn: Turn
  /**
   * The owner's messages that steered the turn. A message that was still
   * waiting to steer when the turn was stopped or the session was reset was
   * dropped unread and is not here.
   */ // adjusted: TIM-559
  readonly steers: ReadonlyArray<ChatMessage.ChatMessage>
  /** How the turn ended. */ // adjusted: TIM-558
  readonly outcome: Outcome
  /** Everything this turn added to the session's history. */
  readonly appended: ReadonlyArray<Prompt.Message>
}

/** An open union. More cases may be added, so match with a default. */
export type SessionEvent =
  | {
    /** The owner reset the thread. `previous` is over and `session` replaces it. */
    readonly _tag: "Reset"
    readonly previous: Session
    readonly session: Session
  }
  | {
    /**
     * clanka replaced the history with a summary. The session id is unchanged.
     * Delivered once, after the turn in which it happened has ended and after
     * that turn's `afterTurn`.
     */ // adjusted: TIM-532
    readonly _tag: "Compacted"
    readonly session: Session
  }

declare const CurrentSession_base: Context.ServiceClass<
  CurrentSession,
  "chad/Session/CurrentSession",
  {
    readonly session: Session
    /** The turn that is running now. None when a background task outlives its turn. */
    readonly turn: Effect.Effect<Option.Option<Turn>>
  }
>
/**
 * Available inside a tool handler when the tool lists it in `dependencies`.
 * chad builds one clanka Agent per session and provides this to it. A
 * sub-agent shares the main agent's handlers, so a handler cannot tell which
 * of the two called it.
 */ // adjusted: TIM-539
export declare class CurrentSession extends CurrentSession_base {}
```

`chad/Turns`, in `dist/Turns.d.ts`:

```ts
import type { ChatThread } from "effect/chat"
import type * as Context from "effect/Context"
import type * as DateTime from "effect/DateTime" // adjusted: TIM-540
import type * as Effect from "effect/Effect"
import type { Outcome } from "./Session.js" // adjusted: TIM-553

/** A scheduled run that chad holds for the calling plugin. */ // adjusted: TIM-540
export interface Timer { // adjusted: TIM-540
  /** The name the plugin gave it. Names are scoped to the plugin. */ // adjusted: TIM-540
  readonly name: string // adjusted: TIM-540
  /** One time, or a 5-field cron expression with an IANA timezone. */ // adjusted: TIM-540
  readonly schedule: // adjusted: TIM-540
    | { readonly at: DateTime.Utc } // adjusted: TIM-540
    | { readonly cron: string; readonly timezone: string } // adjusted: TIM-540
  /** The thread whose session the turn runs in. */ // adjusted: TIM-558
  readonly thread: ChatThread.ChatThread // adjusted: TIM-540
  /** The prompt that starts the turn. */ // adjusted: TIM-558
  readonly prompt: string // adjusted: TIM-540
  /** What the plugin called the turn. */ // adjusted: TIM-558
  readonly label: string // adjusted: TIM-540
  /** A user id that chad mentions at the start of the answer in a server thread. */ // adjusted: TIM-558
  readonly mention?: string | undefined // adjusted: TIM-540
  /** When the next run is due. Only the next run is ever stored. */ // adjusted: TIM-540
  readonly nextRun: DateTime.Utc // adjusted: TIM-540
} // adjusted: TIM-540

declare const Turns_base: Context.ServiceClass<
  Turns,
  "chad/Turns",
  {
    /**
     * Runs a turn in the thread's session and posts the answer there, the same
     * way an owner message would. Waits behind a turn that is already running
     * and never steers it. Hooks see it with `origin._tag === "Plugin"`.
     * Every call starts its own turn.
     *
     * The prompt has to say what started the turn and that nobody is there to
     * answer questions. chad adds no such line itself, and the agent reads it
     * to know that it must not apply changes unasked.
     *
     * An answer that is exactly `[SILENT]` is not posted, and the outcome is
     * `Answered` with that text. `mention` is a user id. chad puts that
     * mention at the start of the answer in a server thread and ignores it in
     * a direct message. A mention of an id that is not an owner's is dropped.
     * The message for a failed turn starts with the mention too.
     *
     * Called from a tool handler for the thread of the handler's own turn, it
     * fails at once, because that turn queues behind the turn that called the
     * tool and a call that waited would deadlock. A tool handler uses `queue`
     * there. A fiber that is waiting when the plugin is reloaded loses the
     * outcome while the turn carries on, so a plugin that needs the outcome
     * reads it in `afterTurn`. Called by a version that is not active yet,
     * it waits for the activation.
     *
     * When the request cannot be saved, it fails with a defect, no turn
     * starts and no `afterTurn` hook runs.
     */ // adjusted: TIM-540, TIM-538, TIM-547, TIM-549, TIM-557, TIM-559
    readonly start: (options: {
      readonly thread: ChatThread.ChatThread
      readonly prompt: string
      readonly label: string
      readonly mention?: string | undefined // adjusted: TIM-540
    }) => Effect.Effect<Outcome>
    /**
     * Queues a turn the way `start` starts one and returns once the request
     * is saved, without waiting for the turn. A tool handler uses it to queue
     * a turn in its own thread. A plugin that needs the outcome reads it in
     * `afterTurn`.
     *
     * The prompt has to say what started the turn and that nobody is there to
     * answer questions, as for `start`.
     */ // adjusted: TIM-559
    readonly queue: (options: { // adjusted: TIM-559
      readonly thread: ChatThread.ChatThread // adjusted: TIM-559
      readonly prompt: string // adjusted: TIM-559
      readonly label: string // adjusted: TIM-559
      readonly mention?: string | undefined // adjusted: TIM-559
      /** A timer of this plugin's, whose runs the turn goes one at a time with (API-137). */ // adjusted: API-137
      readonly timer?: string | undefined // adjusted: API-137
    }) => Effect.Effect<void> // adjusted: TIM-559
    /**
     * Schedules a turn that survives a restart, once at `at` or repeating on
     * a 5-field cron expression in an IANA timezone. Scheduling under a name
     * that already has a run replaces it. The turn is started the way `start`
     * starts one, and hooks see the timer's name and the scheduled time on
     * `origin.timer`.
     *
     * chad stores only the next run. A run that came due while chad was down,
     * or while this plugin was not loaded, fires once when it can, however
     * many runs were missed. The next run of a repeating timer is saved after
     * the turn ends, so two runs of one timer never overlap.
     *
     * A cron expression follows the daylight saving behaviour of Effect's
     * `Cron`. A time inside a skipped hour runs once, moved on by the length
     * of the gap, so 02:30 on a night that skips 02:00 to 03:00 runs at 03:30.
     * A time inside a repeated hour runs once, on the first occurrence.
     *
     * The prompt has to say what started the turn and that nobody is there to
     * answer questions, as for `start`.
     */ // adjusted: TIM-540, TIM-549, TIM-559
    readonly schedule: ( // adjusted: TIM-540
      options: // adjusted: TIM-540
        & ( // adjusted: TIM-540
          | { readonly name: string; readonly at: DateTime.Utc } // adjusted: TIM-540
          | { readonly name: string; readonly cron: string; readonly timezone: string } // adjusted: TIM-540
        ) // adjusted: TIM-540
        & { // adjusted: TIM-540
          readonly thread: ChatThread.ChatThread // adjusted: TIM-540
          readonly prompt: string // adjusted: TIM-540
          readonly label: string // adjusted: TIM-540
          readonly mention?: string | undefined // adjusted: TIM-540
        } // adjusted: TIM-540
    ) => Effect.Effect<void> // adjusted: TIM-540
    /**
     * Cancels this plugin's timer of that name. A run that has already
     * started carries on, and no further run is saved for it.
     */ // adjusted: TIM-540
    readonly cancel: (name: string) => Effect.Effect<void> // adjusted: TIM-540
    /** The calling plugin's timers, and no other plugin's. */ // adjusted: TIM-540
    readonly scheduled: () => Effect.Effect<ReadonlyArray<Timer>> // adjusted: TIM-540
  }
>
/**
 * How a plugin starts a turn on its own, now or on a schedule. To post
 * without the agent, a plugin uses effect/chat's `Chat` service directly.
 *
 * No call here has a typed error. `start` reports a turn that failed in its
 * `Outcome`. `start`, `queue`, `schedule` and `cancel` die with a defect
 * whose message says why when what they asked for cannot be saved, and
 * `start` dies with one too when it is called for the thread of the calling
 * tool's own turn. Inside a tool handler clanka returns that message to the
 * calling script.
 *
 * Every call here, made by a version that is not active yet, waits for the
 * activation. A call that the Layer build itself waits on therefore never
 * returns, and the load fails. Such a call belongs in `Plugin.background`.
 */ // adjusted: TIM-540, TIM-559
export declare class Turns extends Turns_base {}
```

## Gaps

- **API-G17** [builder] The wording of the defect messages of API-79, API-130, API-133 and API-135, and of the load error of API-131. The TIM-559 round 3 rulings on API-G13 and API-G15 and the TIM-559 round 4 ruling on item 2 fix what each says and give no text. The model reads these texts, so the wording the builder writes is added to those rules.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| API-1 | TIM-530 resolution (reviewed, no separate yes), file layout from TIM-549 item 17 | Tim | not run |  | `rule` | `loader` |
| API-2 | TIM-530 resolution, amended by TIM-559 ruling on API-G2 | Tim for the Layer, Architect (Tim has not read) for the brand | run for the Layer, not run for the brand | TIM-559 | `rule` | `plugin-api` |
| API-3 | TIM-530 resolution | Tim | run |  | `rule` | `plugin-api` |
| API-4 | TIM-530 resolution, amended by TIM-538 item 9 | Tim | run |  | `rule` | `plugin-api` |
| API-5 | TIM-530 resolution | Tim | run |  | `rule` | `plugin-api` |
| API-6 | TIM-530 resolution, TIM-534 item 4, TIM-538, amended by TIM-559 ruling on API-G2 | Tim for the check, Architect (Tim has not read) for `Plugin.isPlugin` as the test | run for the check, read for the test (the TIM-538 prototype ran with `Plugin.isPlugin`) |  | `rule` | `loader` |
| API-7 | TIM-530 resolution | Tim | run |  | `rule` | `plugin-api` |
| API-8 | TIM-530 resolution, TIM-542 | Tim | not run |  | `definition` | - |
| API-9 | TIM-553 item 3 | Architect (Tim has not read) | run |  | `rule` | `plugin-api` |
| API-10 | TIM-538 items 4 and 5, TIM-541 item 22, amended by TIM-559 ruling on API-G12 | Tim for no dependencies of a plugin's own and the type-check, Architect (Tim has not read) for the promised list | run for the type-check, not run for the promised list | TIM-541, TIM-559 | `rule` | `loader` |
| API-11 | TIM-538 item 2 | Tim | run |  | `rule` | `loader` |
| API-12 | TIM-549 item 4, amended by TIM-558 item 31, paths from TIM-553 | Architect (Tim has not read) | not run for the check, run for the paths |  | `rule` | `plugin-api` |
| API-13 | TIM-549 item 4 | Architect (Tim has not read) | run |  | `rule` | `loader` |
| API-14 | TIM-530 resolution, amended by TIM-539 item 3 | Tim | run |  | `rule` | `plugin-api` |
| API-15 | TIM-530 resolution (reviewed, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| API-16 | TIM-539 item 2 | Tim | not run |  | `rule` | `apply` |
| API-17 | TIM-539 item 3, TIM-542 item 16 | Tim | run |  | `rule` | `settings` |
| API-18 | TIM-530 resolution, amended by TIM-559 ruling on API-G7 | Tim for the service and for no direct message from a user id, Architect (Tim has not read) for a thread chad has no session in | read | TIM-559 | `fact` | `plugin-api` |
| API-19 | TIM-530 resolution, TIM-539 notes for the port, TIM-549 item 3 | Tim for the service, Architect (Tim has not read) for not providing a client | not run |  | `rule` | `plugin-api` |
| API-20 | TIM-530 resolution | Tim | not run |  | `rule` | `plugin-api` |
| API-21 | TIM-536 item 3 | Tim | run |  | `rule` | `plugin-api` |
| API-22 | TIM-536 item 3 | Tim | not run |  | `rule` | `plugin-api` |
| API-23 | TIM-536 item 3, TIM-542, TIM-548 item 7 | Tim | not run |  | `rule` | `apply` |
| API-24 | TIM-536 item 3 | Tim | not run |  | `rule` | `plugin-api` |
| API-25 | TIM-530 resolution, amended by TIM-548 item 3 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| API-26 | TIM-548 item 3 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| API-27 | TIM-530 resolution, TIM-548 item 5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| API-28 | TIM-530 prototype comment item 7, TIM-548 items 4 and 5 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| API-29 | TIM-530 resolution, TIM-548 item 14 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| API-30 | TIM-530 resolution | Tim | run |  | `rule` | `plugin-api` |
| API-31 | TIM-530 resolution (reviewed, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| API-32 | TIM-530 prototype comment item 3 | Tim | not run |  | `rule` | `plugin-api` |
| API-33 | TIM-530 resolution (reviewed, no separate yes), TIM-549 item 20 | Tim | not run |  | `rule` | `plugin-api` |
| API-34 | TIM-539 item 1 | Tim | read |  | `fact` | `plugin-api` |
| API-35 | TIM-534 supporting facts | Tim | read |  | `fact` | `plugin-api` |
| API-36 | TIM-547 items 7 to 9, amended by TIM-552, amended by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| API-37 | TIM-537 item 4 | Tim | not run |  | `definition` | - |
| API-38 | TIM-530 resolution | Tim | not run |  | `rule` | `plugin-api` |
| API-39 | TIM-531 item 3, TIM-539 resolution | Tim | run |  | `rule` | `plugin-api` |
| API-40 | TIM-539 item 5, TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| API-41 | TIM-539 resolution (in the prototype, no separate yes) | Tim | run |  | `definition` | - |
| API-42 | TIM-530 resolution | Tim | not run |  | `rule` | `plugin-api` |
| API-43 | TIM-530 resolution | Tim | not run |  | `rule` | `plugin-api` |
| API-44 | TIM-534 item 8, amended by TIM-557 items 36 and 40 and TIM-559 round 3 C3 | Tim for the count and for never disabling, Architect (Tim has not read) for the key, the notice rule and what starts the count again | not run | TIM-557, TIM-559 | `rule` | `plugin-api` |
| API-45 | TIM-530 second prototype comment | Tim | run |  | `rule` | `plugin-api` |
| API-46 | TIM-534 supporting facts | Tim | read |  | `fact` | `plugin-api` |
| API-47 | TIM-547 item 4, amended by TIM-552 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| API-48 | TIM-532 item 9 | Tim | not run |  | `rule` | `plugin-api` |
| API-49 | TIM-532 item 9, amended by TIM-557 item 30 | Tim for the hook message and the order, Architect (Tim has not read) for what the update message holds | not run | TIM-557 | `rule` | `plugin-api` |
| API-50 | TIM-539 resolution (in the prototype, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| API-51 | TIM-539 item 4, amended by TIM-543 item 3 | Tim | run |  | `rule` | `plugin-api` |
| API-52 | TIM-552 item 5 | Tim | run |  | `rule` | `apply` |
| API-53 | TIM-530 resolution (reviewed, no separate yes), TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| API-54 | TIM-539 item 4, TIM-532 item 8, TIM-543, amended by TIM-557 item 12 | Tim for when the hook runs, Architect (Tim has not read) for the `GaveUp` reason | run for when the hook runs, not run for the reason | TIM-557 | `rule` | `plugin-api` |
| API-55 | TIM-530 resolution (reviewed, no separate yes), amended by TIM-554 and TIM-559 round 4 item 1 | Tim for the payload and for ruling out redaction, Architect (Tim has not read) for applying that ruling to `afterTurn` and for limiting `steers` to the messages recorded as having steered | not run | TIM-559 | `rule` | `plugin-api` |
| API-56 | TIM-539 item 8 | Tim | run |  | `rule` | `plugin-api` |
| API-57 | TIM-547 item 11 | Architect (Tim has not read) | not run |  | `definition` | - |
| API-58 | TIM-530 resolution (reviewed, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| API-59 | TIM-530 resolution, TIM-532 item 6 | Tim | not run |  | `rule` | `plugin-api` |
| API-60 | TIM-532 item 10, amended by TIM-543 item 1 and TIM-557 item 29 | Tim for the delivery, Architect (Tim has not read) for the reconcile | run for the delivery, not run for the reconcile | TIM-557 | `rule` | `plugin-api` |
| API-61 | TIM-539 item 6, TIM-543 item 5; answered for Tim by Jarvis, chat 2026-11-15 | Tim; the 40 second bound kept by Jarvis, delegated by Tim on 2026-11-15 (Tim has not read) | run |  | `rule` | `plugin-api` |
| API-62 | TIM-530 prototype (reviewed, no separate yes) | Tim | not run |  | `definition` | - |
| API-63 | TIM-539 item 7 | Tim | not run |  | `definition` | - |
| API-64 | TIM-547 item 10, run in TIM-552 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| API-65 | TIM-547 item 10, run in TIM-552 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| API-66 | TIM-547 item 11 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| API-67 | TIM-539 item 8, TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| API-68 | TIM-538 item 9 | Tim | run |  | `rule` | `plugin-api` |
| API-69 | TIM-538 item 9 | Tim | run |  | `rule` | `apply` |
| API-70 | TIM-547 item 6, amended by TIM-552 | Architect (Tim has not read) for the interruption, Tim for the overlap sentence | run |  | `rule` | `apply` |
| API-71 | TIM-530 resolution, TIM-540 items 1 and 14 | Tim | not run |  | `rule` | `plugin-api` |
| API-72 | TIM-532 items 2 and 4 | Tim | run |  | `rule` | `plugin-api` |
| API-73 | TIM-540 item 12 | Tim | not run |  | `rule` | `plugin-api` |
| API-74 | TIM-530 prototype comment item 5 | Tim | not run |  | `rule` | `plugin-api` |
| API-75 | TIM-533 item 11 | Tim | not run |  | `rule` | `plugin-api` |
| API-76 | TIM-540 item 14, amended by TIM-557 item 15 and TIM-559 ruling on CRON-G11 | Tim for the answer, Architect (Tim has not read) for the failed turn and the dropped mention | not run | TIM-557, TIM-559 | `rule` | `plugin-api` |
| API-77 | TIM-540 item 15, amended by TIM-557 item 13 | Tim for not posting, Architect (Tim has not read) for the outcome | not run | TIM-557 | `rule` | `plugin-api` |
| API-78 | TIM-530 resolution, amended by TIM-540 item 19 and TIM-557 item 12 | Tim for the outcome, Architect (Tim has not read) for the set of reasons | not run | TIM-557 | `rule` | `plugin-api` |
| API-79 | TIM-540 item 13, TIM-543, amended by TIM-559 ruling on API-G6 and TIM-559 round 3 on API-G13 | Tim for the queueing behind the calling turn, Architect (Tim has not read) for the failure and the defect | run for the queueing, not run for the failure | TIM-559 | `rule` | `plugin-api` |
| API-80 | TIM-538 item 9, amended by TIM-559 round 3 on API-G15 | Tim for `Turns.start`, Architect (Tim has not read) for `Turns.queue` | not run | TIM-559 | `rule` | `plugin-api` |
| API-81 | TIM-547 item 6 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| API-82 | TIM-549 item 8, amended by TIM-559 ruling on API-G6 and TIM-559 round 3 on SELF-G16 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-83 | TIM-535 resolution, TIM-546 item 13, amended by TIM-557 item 12 and TIM-559 ruling on MOD-G11, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Tim for never starting a login, Architect (Tim has not read) for the credential rule, the `LoggedOut` reason and the wait on a pending login | not run | TIM-557, TIM-559 | `rule` | `plugin-api` |
| API-84 | TIM-540 "What changes in the plugin API" (behaviour agreed, types not reviewed) | Tim | not run |  | `rule` | `timers-cron` |
| API-85 | TIM-540 "What changes in the plugin API" | Tim | not run |  | `rule` | `timers-cron` |
| API-86 | TIM-540 items 6 and 12 | Tim | run |  | `rule` | `timers-cron` |
| API-87 | TIM-540 item 16 | Tim | not run |  | `rule` | `timers-cron` |
| API-88 | TIM-540 items 8 and 10, TIM-543, amended by TIM-557 item 34 | Tim for the order, Architect (Tim has not read) for where the end is learned | run for the order, not run for where the end is learned | TIM-557 | `rule` | `timers-cron` |
| API-89 | TIM-540 item 9, TIM-543 | Tim | run |  | `rule` | `timers-cron` |
| API-90 | TIM-540 items 6 and 11, TIM-543 | Tim | run |  | `rule` | `timers-cron` |
| API-91 | TIM-540 "What changes in the plugin API" | Tim | not run |  | `rule` | `timers-cron` |
| API-92 | TIM-540 item 18, amended by TIM-542, TIM-543, TIM-547 item 13, TIM-548 item 7 and TIM-557 item 27 | Tim for the hold, Architect (Tim has not read) for the swap, the off plugin and the status line | run for the hold, not run for the status line |  | `rule` | `timers-cron` |
| API-93 | TIM-540 item 1, TIM-535 as carried into TIM-540, TIM-530 | Tim | read |  | `definition` | - |
| API-94 | TIM-549 item 28 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| API-95 | TIM-530 and TIM-539 prototypes, amended by TIM-540, TIM-538, TIM-548, TIM-549, TIM-547, TIM-553, TIM-557 items 12, 13 and 15, TIM-558 item 31, and TIM-559 rulings on API-G1, API-G2, API-G6, API-G8, CRON-G7, CRON-G11, FAIL-G5 and MOD-G11, and TIM-559 round 3 C1, API-G13 and API-G15, and TIM-559 round 4 items 1 and 2 | Tim for TIM-530, TIM-538, TIM-539 and TIM-540. Architect (Tim has not read) for the rest | run for the TIM-539 prototype, not run for the amendments | TIM-547, TIM-548, TIM-549, TIM-553, TIM-557, TIM-558, TIM-559 | `rule` | `plugin-api` |
| API-96 | TIM-558 item 50 | Architect (Tim has not read) | not run |  | `definition` | - |
| API-97 | TIM-557 items 7, 8 and 9 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-98 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-99 | TIM-557 item 13 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| API-100 | TIM-557 item 34; TIM-559 cold read; TIM-559 round 5 item 7 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| API-101 | TIM-557 item 28 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-102 | TIM-559 ruling on API-G2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| API-103 | TIM-559 ruling on API-G2 | Architect (Tim has not read) | read (the TIM-538 prototype ran with `Plugin.isPlugin`) | TIM-559 | `rule` | `plugin-api` |
| API-104 | TIM-559 ruling on API-G12 | Architect (Tim has not read) | not run | TIM-541, TIM-559 | `rule` | `bundled-skills` |
| API-105 | TIM-559 ruling on API-G9 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-106 | TIM-559 ruling on ASP-G12 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-107 | TIM-559 ruling on API-G5 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-108 | TIM-559 ruling on API-G1 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-109 | TIM-559 ruling on API-G1 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-110 | TIM-559 ruling on API-G1 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-111 | TIM-559 ruling on API-G1 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-112 | TIM-559 ruling on API-G4 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| API-113 | TIM-559 ruling on FAIL-G5 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| API-114 | TIM-559 ruling on API-G6 | Architect (Tim has not read) | not run for the call, read for the non-waiting request (TIM-543 ran it) | TIM-559 | `rule` | `plugin-api` |
| API-115 | TIM-559 ruling on API-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| API-116 | TIM-559 ruling on API-G7; TIM-559 cold read | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| API-117 | TIM-559 ruling on API-G7 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-118 | TIM-559 ruling on API-G7, TIM-559 round 3 C6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| API-119 | TIM-559 ruling on API-G7 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| API-120 | TIM-559 rulings on FAIL-G2 and CRON-G16 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-121 | TIM-559 ruling on API-G3 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| API-122 | TIM-559 ruling on API-G3 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| API-123 | TIM-559 rulings on API-G8 and CRON-G7 | Architect (Tim has not read) | read (Effect's `Cron.ts` at `e1ae842`, the head of the `effect-chat` branch) |  | `fact` | `timers-cron` |
| API-124 | TIM-559 ruling on API-G8 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| API-125 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-126 | TIM-559 round 3 C1 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| API-127 | TIM-559 round 3 C1 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-128 | TIM-559 round 3 A3, declaration from the TIM-538 prototype | Architect (Tim has not read) | not run for the ruling, run for the error parameter and the scope (the TIM-538 prototype) |  | `rule` | `plugin-api` |
| API-129 | TIM-559 round 3 on API-G13, TIM-559 round 4 item 2 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-130 | TIM-559 round 3 on API-G13 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-131 | TIM-559 round 3 on API-G15 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| API-132 | TIM-559 round 3 on API-G15, TIM-559 ruling on CRON-G9 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| API-133 | TIM-559 round 3 on API-G13 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| API-134 | TIM-559 round 4 item 1 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-135 | TIM-559 round 4 item 2 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| API-136 | Build, stage 3 | Builder (Tim has not read) | run |  | `rule` | `plugin-api` |
| API-137 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `timers-cron` |
