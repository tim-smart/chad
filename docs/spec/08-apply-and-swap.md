# Applying a change to live sessions

This part covers how a change made through the `chad` CLI reaches sessions that are already open, without a restart and without losing a conversation. It defines the generation counter, what a session carries over when it rebuilds its Agent, when the system prompt is rendered again and when it stays frozen, and the one swap path that replaces a plugin's running version. It also fixes what a running turn's tool calls do during and after a swap, and the exact messages returned to the model. It leans on 07-plugin-loading.md for how a plugin version is built, on 06-plugin-api.md for hooks, chunks and `Turns`, on 09-repo-and-recovery.md for the repo, a revert and safe mode, on 10-cli.md for the commands and their output, on 03-sessions-and-turns.md for turns, steering and hooks, on 12-skills-and-mcp.md for the MCP layer's own rebuild, on 13-timers-and-cron.md for timers, on 16-failures-logs-status.md for the log, the notices and the update message about what chad posted, and on 17-testing.md for how its rules are tested.

## Terms used in this part

An Agent is clanka's object for one conversation. It holds the tools, the history and the environment, and clanka fixes its tools when the Agent is built. A turn is one run of the Agent, from a prompt to the final answer.

A background task is a `bash` command or a sub-agent that clanka keeps running after the tool call that started it has returned, as read in clanka 0.28.0 (`src/AgentTools.ts`). clanka gives each task an id such as `bash_1`, and the Agent that started it reads, waits for, stops and lists its tasks with `taskOutput`, `waitTasks`, `stopTask` and `listTasks`. This part says how a task stays reachable when its Agent is rebuilt. What chad records about a session's running tasks, and what keeps the session in memory while one runs, is in 03-sessions-and-turns.md.

A version is one built instance of a plugin, which is the plugin's Layer built from one bundle in a scope of its own. The bundle hash is the hash of the plugin's bundled code (see 07-plugin-loading.md). A tool's declaration is the text that clanka's `ToolkitRenderer` renders for that tool in the system prompt.

A swap replaces the running versions of one or more plugins. The gate is what keeps new work out of a plugin while it is being swapped. The drain is the wait for work that was already running inside the old version. The activation is the moment the new versions become current and the gate opens.

The generation is a number in the daemon that tells a session whether what is loaded has changed since its Agent was built.

## Generations and when a session rebuilds its Agent

clanka cannot change the tools of an Agent that exists, so a change reaches a session by building a new Agent. chad does that only between turns.

- **SWAP-1** A `chad apply` loads and checks the change in the daemon and then bumps the generation number.
- **SWAP-2** An apply whose load or check fails keeps the last good version of everything running and does not bump the generation. The CLI prints the error and exits non-zero (see 10-cli.md).
- **SWAP-3** The check includes a trial `Agent.makeWith` with every plugin's tools, because clanka dies when two tools share a name. A name clash fails the apply before any session is rebuilt.
- **SWAP-4** A session whose generation is behind the daemon's rebuilds its Agent at the start of its next turn.
- **SWAP-5** An apply never interrupts a running turn, and chad never rebuilds an Agent in the middle of a turn. An idle session does nothing until its next turn.
- **SWAP-6** The turn that ran the apply keeps the tool list it was built with, so chad gets a tool it just wrote in the next turn, which normally starts with the next message.
- **SWAP-7** While a background sub-agent keeps a turn open, the owner's next message is steered into that turn and no new turn starts. A tool chad just wrote is therefore not there on that message, and the refusal says so (see SWAP-70).
- **SWAP-8** A change of the model override (`chad model` or `/model`) reaches each session at the start of its next turn through the same generation bump as an apply (see 05-model-and-login.md).
- **SWAP-9** A session sees a new, removed or renamed skill on its next turn. chad scans the skills itself and passes clanka an explicit list when it builds the Agent (see 12-skills-and-mcp.md).
- **SWAP-149** clanka's own walk for skill directories and `AGENTS.md` files in and above a session's working directory does not go through an apply. What it finds reaches the model with no apply and no generation bump. Its reach is in 12-skills-and-mcp.md, and what that means for a draft in `work/` is in 09-repo-and-recovery.md.
- **SWAP-10** An MCP server that a rebuild of the MCP layer added is callable from each session's next turn (see 12-skills-and-mcp.md).
- **SWAP-125** A successful apply and a successful revert each bump the generation, whatever they changed (see 09-repo-and-recovery.md for a revert).
- **SWAP-126** Every activation of the swap path bumps the generation, so a reload that is not an apply also makes each session rebuild its Agent at the start of its next turn.
- **SWAP-127** Every rebuild of the MCP layer bumps the generation, whatever caused it (see 12-skills-and-mcp.md).
- **SWAP-11** The session's row keeps the generation its Agent was built at, next to the system prompt last sent, the chunk text last seen and the fingerprint of SWAP-129 (see 03-sessions-and-turns.md and 02-storage.md).

## What a rebuild carries over

A rebuild has three steps. chad builds a new Agent, sets the old history and the old environment on it, and closes the old Agent's scope. Everything a session needs to keep lives outside the Agent, so it survives.

- **SWAP-12** A rebuild builds a new Agent, copies the old Agent's history and environment onto it with `MutableRef.set`, and then closes the old Agent's scope. The conversation continues on the new Agent.
- **SWAP-13** The old Agent's scope closes at a turn boundary, where the Agent has nothing running. clanka forks sub-agents in the run's scope and does not end a turn while one is running, so no sub-agent is lost.
- **SWAP-14** Each session has one executor, kept across rebuilds, so the working directory and the background processes survive a rebuild.
- **SWAP-15** chad wraps the `AgentExecutor` service so that the root agent's task owner id is the session id. A rebuilt Agent can then list and read the background tasks that an earlier Agent started.
- **SWAP-16** The wrapper takes the first owner id an Agent executes under to be its root's. That holds in the pinned clanka, because a sub-agent only exists once a root script has started one. It is not a documented contract of clanka.
- **SWAP-17** chad announces the completion of a background task that outlives a rebuild itself, in an update message, because the watcher that would have announced it closed with the old Agent.
- **SWAP-18** Withdrawn.
- **SWAP-132** chad keeps the task handles that pass through `onTask` in the owner id wrapper. Through them it sees a task end after the Agent that started it was discarded.
- **SWAP-133** If the pinned clanka does not pass task handles through `onTask`, the builder does not pick another way to raise the notice. The builder pends SWAP-17 with that reason and raises it as a change to this spec.
- **SWAP-134** The notice has the form clanka itself uses for a task that ends, which is the `<task id="..." kind="..." status="...">` element shown below, and chad sends it in an update message.
- **SWAP-135** chad sends the notice only for a task whose Agent was discarded, so no task is announced twice.
- **SWAP-136** chad does not recover a finished task's result that was still waiting in the old Agent's mailbox when a rebuild discarded that Agent. The output stays readable with `taskOutput` through the owner id wrapper.
- **SWAP-137** The notice names every task that ended since the old Agent's last turn, which covers the results of SWAP-136.
- **SWAP-19** The process has one `McpServers` instance, handed to every rebuilt Agent, so a plugin change reconnects no MCP server. Rebuilding that layer restarts every server and a stdio server loses its state, which is accepted. What rebuilds it is in 12-skills-and-mcp.md.
- **SWAP-20** A rebuild keeps the session's model layer. Only a model change, a login change or a restart builds a new model layer.
- **SWAP-21** On a Codex login and on `openai` with an API key, chad passes the session id as `prompt_cache_key` and also sends it in the `session-id` request header, through one `OpenAiClient` per session. The key alone keeps only the system prompt cached across a new connection. Which requests carry the header, the opening of the Codex WebSocket included, is in 05-model-and-login.md, and so is the `openai-compat` provider, which gets neither the key nor the header.
- **SWAP-116** chad's logger and the session's one object that holds the session id and the id of the turn that is running are in place where the session's executor layer is built and where each Agent is built, so a rebuilt Agent logs under the same session (see 16-failures-logs-status.md).

The session's side of a rebuild, from the host that ran the swap with live sessions. `Plugins.wrapper` is the prototype's wrapper. It took the bundle hash and the declaration because it routed calls, and chad's wrapper takes neither (SWAP-153).

```ts
// One executor per session, kept across rebuilds.
const executor = yield* Layer.build(AgentExecutor.layerLocal({ directory }))
const real = Context.get(executor, AgentExecutor.AgentExecutor) // adjusted: TIM-531 item 4

let agent: Agent.Agent | undefined
let agentScope: Scope.Closeable | undefined
let generation = -1
/** Plugin name to the bundle hash this session's Agent was built on. */
let built = new Map<string, string>()

/** Build this session's Agent on the plugin versions that are current now. */
const rebuild = Effect.gen(function*() {
  const versions = [...Plugins.slots.values()].flatMap((s) => s.current ? [s.current] : [])
  const handlers: Record<string, (params: any) => Effect.Effect<any, any>> = {} // adjusted: TIM-552, the scenarios' own test tools removed
  const nextBuilt = new Map<string, string>()
  for (const version of versions) {
    nextBuilt.set(version.plugin, version.hash)
    for (const [tool, entry] of version.tools) {
      handlers[tool] = Plugins.wrapper(row.id, version.plugin, tool, { hash: version.hash, decl: entry.decl, instance: version.instance, tool: entry.tool })
    }
  }
  const toolkit: any = Toolkit.merge(CoreTools, ...versions.flatMap((v) => v.toolkits))
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(toolkit.toLayer(handlers) as Layer.Layer<any>, scope)
  const next: Agent.Agent = yield* (Agent.makeWith({ loopTools: toolkit, skills, instructions: Option.none() }) as any).pipe( // adjusted: TIM-537, chad passes its own skill list
    Effect.provideContext(context),
    Effect.provideService(AgentExecutor.AgentExecutor, stableOwner(real, row.id)), // adjusted: TIM-531 item 4, the executor is passed through the owner id wrapper
    Scope.provide(scope)
  )
  if (agent !== undefined) {
    MutableRef.set(next.history, agent.history.current)
    MutableRef.set(next.environment, agent.environment.current)
    // The old Agent's scope closes at a turn boundary, where it has nothing running.
    yield* Scope.close(agentScope!, Exit.void)
  } else {
    // First build after a start or a passivation: the history and environment come from SQLite (see 03-sessions-and-turns.md).
  }
  agent = next
  agentScope = scope
  generation = Plugins.generation
  built = nextBuilt
})

const runTurn = (prompts: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    // A swap that began after the beforeTurn hooks: the Agent is still built on what is active afterwards.
    yield* waitForSwap(row.id)
    if (agent === undefined || generation !== Plugins.generation) yield* rebuild
    const running = { built, subagents: 0 }
    Plugins.runningTurns.set(row.id, running)
    // agent.send(...) follows. The stream's SubagentStart and SubagentComplete parts
    // raise and lower running.subagents.
  }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => void Plugins.runningTurns.delete(row.id))))
```

The owner id wrapper, from the run that listed and read background tasks across a rebuild. A new wrapper is made for each Agent that is built.

```ts
// The first id an Agent executes under is its root's: sub-agents only
// exist once a root script has started one.
const stableOwner = (real: AgentExecutor.AgentExecutor["Service"], sessionId: string) => { // adjusted: TIM-531 item 4, takes the executor and the session id
  let root: string | undefined
  return AgentExecutor.AgentExecutor.of({
    capabilities: real.capabilities,
    executeUnsafe: real.executeUnsafe,
    renderEnvironment: real.renderEnvironment,
    execute: (options) => {
      root ??= options.agentId
      return real.execute(options.agentId === root ? { ...options, agentId: sessionId } : options) // adjusted: TIM-531 item 4, the session id
    }
  })
}
```

What the runs measured. With no wrapper a rebuilt Agent's `listTasks()` returned `[]` and `taskOutput("bash_1")` answered `No task with id "bash_1". You can only address tasks you started`. With the wrapper it listed both tasks and returned the output, and no completion notice reached the history. On a real Codex login a rebuild that kept the model layer read 8,832 of 9,054 input tokens from the cache. With the model layer rebuilt and only the key sent, it read 1,664.

clanka's own notice for a task that ends, as read in the source of clanka 0.27.0 and found unchanged in clanka 0.28.0 (`src/AgentSubagents.test.ts:1109`). chad's notice for a task that outlived a rebuild carries the same element inside its update message.

```text
<task id="bash_1" kind="bash" status="completed" exitCode="0">
To read the output, call taskOutput("bash_1").
</task>
```

## The system prompt, rendered again or kept frozen

The tool declarations are part of the system prompt, so a rebuilt Agent with different tools produces a different prompt. The frozen prompt is the system prompt text a session last sent. chad sends it again unchanged for as long as nothing forces a new render, so the model provider's prompt cache keeps reading the history.

- **SWAP-22** chad keeps each session's frozen prompt itself and returns it from the `system` function it passes to `send`. With Codex the system prompt travels as `instructions` and is not stored in the history, so the history cannot supply it.
- **SWAP-23** A tool, skill or MCP change renders the session's system prompt again on its next turn. Losing the cached history once at that point is accepted.
- **SWAP-24** chad does not declare a new tool in an update message while leaving the prompt frozen, although that ran and kept the cache. A removed or changed tool would leave a stale declaration in the system prompt.
- **SWAP-25** The system prompt is also rendered again at a reset and on the turn after a compaction.
- **SWAP-26** A change to `persona.md` renders each session's system prompt again on its next turn.
- **SWAP-128** A change to `persona.md` has no path of its own to a session. It arrives with the generation bump of the apply or the revert that carried it, and the rebuild that follows renders the prompt again.
- **SWAP-27** Turning safe mode on or off always renders the system prompt again, even with an empty repo. While safe mode is on, the rendered prompt has one more line that says so and says that nothing from the repo is loaded. That line is part of the render and is not sent as an update message.
- **SWAP-28** The rendered prompt has chad's core block first, which carries the two fixed sentences below. The persona follows the core block and comes before the plugin chunks. Safe mode leaves the persona out (see 14-self-edit-skill.md and 09-repo-and-recovery.md).
- **SWAP-129** A session's fingerprint is a hash of the system prompt as chad would render it now, with the plugin chunks left out. A change to a tool, a skill, the MCP config, the persona, the safe mode line or the core block therefore changes it, and a change to a chunk does not.
- **SWAP-29** When a session is restored from storage, a fingerprint that matches the stored one reuses the frozen prompt. A different fingerprint renders the prompt again.
- **SWAP-130** A rebuild in a live session makes the same comparison as a restore. A fingerprint that matches the stored one keeps the frozen prompt and the cached history, and a different one renders the prompt again.
- **SWAP-131** A new image whose core block differs changes the fingerprint, so each session renders its prompt again on its first turn under that image.

The two fixed sentences in the core block:

```text
Your plugins, skills, MCP servers, settings and persona are files you can change with the `chad` CLI. Read the `self-edit` skill before you do.
```

How chad sends the frozen prompt, from the run on clanka 0.27.0:

```ts
const frozen = session.frozenSystem
const stream = yield* session.live.agent.send({
  prompt: [...updates.map((content) => ({ role: "user" as const, content })), { role: "user" as const, content: text }],
  system: (options) => (session.frozenSystem = frozen ?? renderSystem(session.chunks)(options))
})
```

What the run measured, on the first model call of a turn with about 5,700 tokens of history. A turn with nothing changed read 7,296 of 7,517 input tokens from the cache. A turn after a chunk change with the prompt frozen read 7,424 of 7,583. A turn after a tool change with the prompt rendered again read 1,792 of 7,655, which is the part of the system prompt before the new tool's declaration.

## Prompt chunks and the update message

A chunk is the text a plugin contributes to the system prompt through `Plugin.prompt` (see 06-plugin-api.md). An update message is a user message wrapped in `<environment-update>`. It is the one kind of message clanka drops at a compaction.

- **SWAP-30** Before each turn chad renders every chunk and compares it with the text that session last saw.
- **SWAP-31** The differences go into one `<environment-update>` message, sent ahead of the owner's message in the same `send`, and the system prompt stays frozen.
- **SWAP-32** Within a turn's prompt the chunk update message comes first, then the `beforeTurn` hook messages in plugin name order, then the owner's message (see 03-sessions-and-turns.md).
- **SWAP-117** When the update message about what chad posted in the thread is due on the same turn as a chunk change, both go in the one `<environment-update>` message and the system prompt stays frozen (see 16-failures-logs-status.md).
- **SWAP-33** A chunk that was removed gets a line in the update message saying that its section no longer applies.
- **SWAP-34** A chunk that changed because its plugin was reloaded and a chunk whose text changed on its own are the same case. Both reach the session through the update message with the prompt frozen.
- **SWAP-35** A render that fails or runs past its budget leaves the session with the text it last saw. It does not count as the chunk being removed, and no update message is sent for it.
- **SWAP-36** The chunks are folded into the system prompt whenever it is rendered again. The rules under "The system prompt, rendered again or kept frozen" say when that is, and a tool change, a reset and the turn after a compaction are three of those times.
- **SWAP-37** clanka drops every update message when it compacts and announces only its own again. That is why the turn after a compaction renders the system prompt again with the chunks folded in.
- **SWAP-38** A session's queued `Compacted` hooks finish before its next turn starts, so the chunks folded in on the turn after a compaction come from plugins that have already seen the compaction (see 03-sessions-and-turns.md).
- **SWAP-150** The first turn of the session that a `/new` starts waits in the same way for the hooks each plugin queued ahead of it, the last of which is `Reset`. The chunks in that turn's prompt therefore come from plugins that have handled the reset or have run out of budget. The wait, its bounds and how `/stop` ends it are in 03-sessions-and-turns.md.

The update message for a changed chunk, as the run sent it:

```text
<environment-update>
# Plugin context changed

The "weather" section of your instructions is replaced by:

Today's weather: high 30°C, rain 4mm.
</environment-update>
```

## The swap path

Every change to which plugin versions are running goes through one path with five steps. All new versions build. The gates close. Work in flight into the old versions drains. The old scopes close. The new versions activate together.

- **SWAP-39** There is one swap path. An apply uses it, and so does every reload that is not an apply, which means `chad plugin reload`, a secret change, an owner change, a timezone change and `chad safe on|off`. `chad safe on` is a swap to nothing.
- **SWAP-40** All of these go through one queue in the daemon, so two of them never swap plugins at once (see 10-cli.md).
- **SWAP-41** An apply swaps a plugin when its code or its settings changed. A plugin whose bundle hash and settings did not change is left running and is not part of the swap (see 07-plugin-loading.md and 11-settings.md).
- **SWAP-42** A swap starts only after every new version in it has built. In an apply, one failed build means nothing swaps.
- **SWAP-43** Once the builds are done every gate closes, the drains run in parallel under one deadline, the old scopes close and the new versions activate together. A reload of every plugin is one swap and not one swap per plugin.
- **SWAP-44** The gate closes at the start of the swap, before the drain.
- **SWAP-45** The drain has one deadline of 30 seconds, a constant, for everything in flight into the old versions. Tool calls and hooks share it.
- **SWAP-46** At the drain deadline chad interrupts what is still running and waits up to 1 second for it to stop. Only then is the caller answered, and the answer says which of the two happened (see SWAP-113 and SWAP-114).
- **SWAP-47** Closing the old versions' scopes has its own deadline of 10 seconds. Past it chad logs, abandons the finalizers and activates the new versions.
- **SWAP-48** The wait of up to 1 second for an interrupted call or hook comes out of the 10 second close deadline, so a swap takes at most 40 seconds from the gate closing to the activation.
- **SWAP-118** The 30 second drain deadline, the 10 second close deadline and the 1 second wait are defaults of the `Timings` service, which the constants in the code below stand for. The shipped binary has no setting that changes them (see 17-testing.md).
- **SWAP-49** The old version's `Plugin.background` fibers are interrupted when the old version closes, and the drain does not wait for them.
- **SWAP-50** A background fiber of the old version that is waiting on `Turns.start` loses the outcome at the swap while the turn carries on. A plugin that needs the outcome reads it in `afterTurn` or from its store.
- **SWAP-51** The new version's `Plugin.background` fibers start only at the activation, and `Turns.start` from a version that is not active yet waits for it (see 07-plugin-loading.md).
- **SWAP-151** `Turns.queue`, `Turns.schedule`, `Turns.cancel` and `Turns.scheduled` called by a version that is not active yet wait for the activation in the same way as `Turns.start`. What such a call does when it is made inside the plugin's build is in 06-plugin-api.md.
- **SWAP-52** The two versions' work never overlaps unless old code ignores interruption, which is logged. Abandoned finalizers and a handler in an uninterruptible region are the two ways it happens.
- **SWAP-53** A handler or hook that did not stop when interrupted is logged when the swap moves on and again when it ends. For a tool the line says that two versions of the plugin now overlap. For a hook it says that the plugin's hook queue has moved on to the new version.
- **SWAP-119** A handler or hook that did not stop, two versions of a plugin that overlap, and hooks dropped in a swap or in a stop are log lines only. chad sends the owner no notice for them (see 16-failures-logs-status.md).
- **SWAP-120** The log lines of a swap, of the wrapper and of an abandoned swap follow the logging rules in 16-failures-logs-status.md and take their event names from its closed list, where every name is `area.name` with exactly one dot. A handler or hook that did not stop is `swap.overrun` when the swap moves on and `swap.overrun-ended` when it ends (SWAP-53). A close past its deadline is `swap.close-abandoned` (SWAP-47). A hook interrupted at the drain deadline is `hook.failed` (SWAP-82). A queued hook that is dropped is `hook.dropped` (SWAP-83, SWAP-84 and SWAP-105). An apply is `apply.done` or `apply.failed` (SWAP-56 and SWAP-147). The names in this part's code blocks are the prototype's and are not chad's.
- **SWAP-54** When one apply changes plugins and `mcp.json`, the plugins activate without waiting for the MCP layer to connect (see 12-skills-and-mcp.md).
- **SWAP-55** An apply cancelled before its commit changes nothing. From its commit on it finishes, even when the CLI that started it is killed (see 10-cli.md). Only a graceful stop ends it early (see SWAP-101 to SWAP-106).
- **SWAP-56** From its commit on, an apply moves `live`, swaps and writes its `apply.done` log line inside a region the CLI client cannot interrupt. That region gives way to a graceful stop.
- **SWAP-121** An apply, a `chad revert`, a `chad safe on|off`, a `chad secret rm` or a `chad timezone` that was run from a session and succeeded posts one subtext line in that session's thread. The same command from the owner's shell posts nothing, and a failed one that changed nothing posts nothing. The line's text and the full list of commands that post it are in 16-failures-logs-status.md.
- **SWAP-138** When one of those commands is a reload that is not an apply and it exits 1 because some plugins failed to build while the others swapped (see SWAP-96), it still posts the line when it was run from a session. The change is stored and took effect for the plugins that built.
- **SWAP-139** In that case the line names the plugins that were kept on their previous version.
- **SWAP-147** An apply that is refused or that fails writes one `apply.failed` log line, which carries the stage it failed at and the error (see 16-failures-logs-status.md).
- **SWAP-148** Each reload that is not an apply writes one `command.ran` log line when its command finishes. The line carries the command, the caller, which is the owner, a session id or the daemon, and the outcome, and it never carries a secret's value (see 16-failures-logs-status.md).
- **SWAP-57** An apply in safe mode runs every check, commits and moves `live`, and loads nothing from the repo until safe mode goes off (see 09-repo-and-recovery.md).
- **SWAP-58** The one exception in safe mode is the `enabled` flag of a bundled plugin. An apply that flips it takes effect at once (see 11-settings.md).

What the run measured with the real constants. The drain took 30.0 seconds, the finalizer that hangs was abandoned at 10.0 seconds, and the new version activated 40.0 seconds after the gate closed. A call already in flight finished on the old instance while the swap waited 3.0 seconds for it. A handler in an uninterruptible region ran 4.5 seconds past the deadline inside a version whose scope had closed.

The swap itself, from the prototype that ran it. `Version` is one built instance of a plugin and `Slot` is what the daemon keeps per plugin name. The prototype's two diagnostic switches and some of its log lines are left out. The prototype named a session as affected only when a plugin's bundle hash changed. chad names it for any plugin in the swap (SWAP-75).

```ts
/** One deadline for everything in flight into the old versions: tool calls and hooks together. */
export const DRAIN_MS = 30_000
/** Closing the old versions' scopes. */
export const CLOSE_MS = 10_000
/** How long the drain waits for an interrupted call or hook to actually stop. It comes out of the close deadline. */
const STUBBORN_MS = 1_000

interface ToolEntry {
  /** The tool definition, for its schemas. */
  readonly tool: any
  readonly decl: string
  readonly handler: (params: any) => Effect.Effect<any, any>
}
interface HookEntry {
  readonly run: (payload: any) => Effect.Effect<any, any>
  readonly timeout: number | undefined
}
/** One thing running inside a version: a tool call or a hook. */
interface Flight {
  readonly kind: "tool" | "hook"
  readonly label: string
  readonly session: string | undefined
  readonly startedAt: number
  readonly done: Deferred.Deferred<void>
  fiber: Fiber.Fiber<any, any> | undefined
  /** Set by the drain when it interrupts this flight at the deadline. */
  cut: boolean
  /** Set when the flight was still running after the wait that follows the interruption. */
  stuck: boolean
  /** Done by the drain once it stops waiting for this flight. The caller is answered here if the handler has not stopped. */
  readonly cutNow: Deferred.Deferred<void>
}
export interface Version {
  readonly plugin: string
  readonly instance: number
  readonly hash: string
  readonly code: string
  readonly settings: string
  readonly scope: Scope.Closeable
  readonly activated: Deferred.Deferred<void>
  readonly toolkits: Array<any>
  readonly tools: Map<string, ToolEntry>
  readonly hooks: Map<Plugin.HookKind, HookEntry>
  readonly inflight: Set<Flight>
  state: "built" | "active" | "closed"
}
type Status = "loaded" | "removed" | "off" | "safe" | "between"
interface Job {
  readonly kind: Plugin.HookKind
  readonly payload: any
  readonly done: Deferred.Deferred<void>
}
interface Slot {
  readonly name: string
  current: Version | undefined
  status: Status
  /** Defined from the moment the gate closes until the activation. */
  swap: { readonly gate: Deferred.Deferred<void>; readonly incoming: Version | undefined; readonly becoming: Status } | undefined
  readonly jobs: Array<Job>
  working: boolean
  /** "running with the previous <reason>: <error>" */
  note: string | undefined
}

/** Bumped by every activation. A session rebuilds its Agent at the start of its next turn when it is behind. */
export let generation = 0
/** Sessions with a turn running, and the bundle each plugin had when the turn's Agent was built. */
export const runningTurns = new Map<string, { readonly built: Map<string, string>; subagents: number }>()

interface Change {
  readonly plugin: string
  readonly next: Version | undefined
  readonly status: Status
}

const swap = (label: string, changes: ReadonlyArray<Change>) =>
  Effect.gen(function*() {
    const started = Date.now()
    const gate = Deferred.makeUnsafe<void>()
    const olds: Array<Version> = []
    // 1. Every gate closes.
    swapping = { gate, label }
    for (const change of changes) {
      const s = slot(change.plugin)
      s.swap = { gate, incoming: change.next, becoming: change.status }
      if (s.current !== undefined) olds.push(s.current)
    }

    // 2. One drain, one deadline, for the tool calls and hooks in flight into the old versions.
    const flights = olds.flatMap((v) => [...v.inflight])
    yield* Effect.forEach(flights, (f) => Deferred.await(f.done), { concurrency: "unbounded", discard: true }).pipe(Effect.timeoutOption(DRAIN_MS))
    const late = olds.flatMap((v) => [...v.inflight].map((f) => ({ f, v })))
    const interrupted: Array<string> = []
    for (const { f, v } of late) {
      f.cut = true
      interrupted.push(f.kind + ":" + f.label + (f.session ? " in " + f.session : ""))
      log(f.kind === "tool" ? "call.interruptedBySwap" : "hook.interruptedBySwap", { label: f.label, session: f.session, on: id(v), ranMs: Date.now() - f.startedAt })
    }
    // Interruption is asked for, and waited on for a moment only. A handler in an uninterruptible
    // region keeps running on a version that is about to close.
    const stopStarted = Date.now()
    yield* Effect.forEach(late, ({ f, v }) =>
      f.fiber === undefined ? Effect.void : Fiber.interrupt(f.fiber).pipe(
        Effect.timeoutOption(STUBBORN_MS),
        Effect.map((done) => {
          if (Option.isNone(done)) {
            f.stuck = true
            log("flight.ignoredInterrupt", {
              kind: f.kind, label: f.label, session: f.session, on: id(v),
              note: f.kind === "tool" ? "two versions of " + v.plugin + " now overlap" : v.plugin + "'s hook queue moves on to the new version while this hook is still running"
            })
            f.fiber!.addObserver(() => log("flight.endedAfterAbandon", { kind: f.kind, label: f.label, on: id(v), ranMs: Date.now() - f.startedAt }))
          }
          // The caller is answered now, and told which of the two happened.
          Deferred.doneUnsafe(f.cutNow, Exit.void)
        })
      ), { concurrency: "unbounded", discard: true })
    // That wait comes out of the close deadline, so the two deadlines still add up to 40 seconds.
    const closeBudget = Math.max(0, CLOSE_MS - (Date.now() - stopStarted))
    const drainedMs = Date.now() - started

    // 3. The old scopes close, under their own deadline.
    const closeStarted = Date.now()
    yield* Effect.forEach(olds, (v) => close(v, label, closeBudget), { concurrency: "unbounded", discard: true })

    // 4. The new versions activate together and the gates open.
    const affected: Array<string> = []
    for (const [session, turn] of runningTurns) {
      const lost = changes.filter((c) => turn.built.has(c.plugin) && turn.built.get(c.plugin) !== c.next?.hash).map((c) => c.plugin)
      if (lost.length > 0) affected.push(session + " loses " + lost.join(", ") + " until its turn ends (" + turn.subagents + " sub-agents running)")
    }
    for (const change of changes) {
      const s = slot(change.plugin)
      s.current = change.next
      s.status = change.status
      s.note = undefined
      if (change.next !== undefined) {
        change.next.state = "active"
        Deferred.doneUnsafe(change.next.activated, Exit.void)
      } else {
        dropQueued(s, "the plugin is " + change.status)
      }
    }
    generation++
    for (const change of changes) slot(change.plugin).swap = undefined
    swapping = undefined
    Deferred.doneUnsafe(gate, Exit.void)
    return { label, generation, waitedMs: Date.now() - started, drainedMs, closeMs: Date.now() - closeStarted, interrupted, affected }
  })

/** Closes a version's scope under the close deadline. Past it the finalizers are abandoned. */
const close = (version: Version, why: string, budget = CLOSE_MS) =>
  Effect.gen(function*() {
    version.state = "closed"
    const started = Date.now()
    const fiber = Effect.runFork(Scope.close(version.scope, Exit.void))
    const exit = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(budget))
    if (Option.isNone(exit)) {
      // Not interrupted: a finalizer runs uninterruptibly, so all chad can do is stop waiting for it.
      log("close.abandoned", { version: id(version), why, ms: Date.now() - started })
      return false
    }
    log("close.done", { version: id(version), why, ms: Date.now() - started })
    return true
  })

export interface ApplyResult {
  readonly ok: boolean
  readonly exit: number
  readonly errors: ReadonlyArray<string>
  readonly reloaded: ReadonlyArray<string>
  readonly kept: ReadonlyArray<string>
  readonly swap?: { readonly waitedMs: number; readonly interrupted: ReadonlyArray<string>; readonly affected: ReadonlyArray<string> } | undefined
}
```

## Routing a running turn's tool calls

clanka resolves a tool's handler from the context when the Agent is built, and it decodes each call's parameters and encodes its result with the toolkit of that Agent. A running turn therefore cannot be given new tools, and a call it makes after a swap would reach a version whose scope has closed. chad puts a wrapper round every plugin tool handler to decide, per call, whether the version the Agent was built on is still the current one.

- **SWAP-59** chad wraps every plugin tool handler it hands to clanka. The wrapper keeps which version of the plugin the Agent was built on, and it looks up the plugin's current version when a call is made.
- **SWAP-122** The wrapper sets the plugin's name around the plugin's handler, in a `Context.Reference` that chad's logger reads from the fiber, so the copy of a handler's log line in chad's log carries the plugin's name (see 16-failures-logs-status.md).
- **SWAP-60** A running turn keeps its tool list across a swap. Each call it makes to a plugin tool is either answered by the version its Agent was built on or refused, and the turn carries on either way.
- **SWAP-153** After a swap replaced a plugin's running version, a call that a running turn or one of its sub-agents makes to a tool of that plugin fails at once. The handler does not run and the turn carries on. This holds whatever caused the swap, which is an apply that changed the plugin's code or its settings, `chad plugin reload`, or a secret, owner or timezone change. It also holds for a call that arrives while the swap is in progress, or after a graceful stop abandoned the swap with the old version closed, so no call is held at the gate. The message says that the tool changed and that it is back in the session's next turn (SWAP-69). chad compares no bundle hash and no declaration and re-encodes nothing across schemas, and the wrapper only needs to know which version the turn's Agent was built on. A plugin that is not part of the swap is untouched, and its tools keep working in a running turn (SWAP-41). After a reload that is not an apply the exact wording of the message is the builder's choice.
- **SWAP-61** Withdrawn.
- **SWAP-62** Withdrawn.
- **SWAP-63** Withdrawn.
- **SWAP-64** Withdrawn.
- **SWAP-65** Withdrawn.
- **SWAP-66** Withdrawn.
- **SWAP-67** Withdrawn.
- **SWAP-68** Withdrawn.
- **SWAP-69** A call that SWAP-153 fails gets message 1 in "The messages returned to the model", unless a rule below names another message. The rule is per plugin, so a tool whose own code did not change fails too when its plugin was swapped.
- **SWAP-70** While the turn has a sub-agent running, the refusal is message 2, the longer form that says the next turn cannot start while a sub-agent is running. Turns without a sub-agent keep the plain message.
- **SWAP-71** A call to a tool that the swap removed fails with message 3.
- **SWAP-72** A call to a tool of a plugin that safe mode turned off fails with message 4.
- **SWAP-140** A call to a tool of a plugin that an apply turned off with `"enabled": false` fails with message 3, the same message as for a tool that the swap removed.
- **SWAP-73** Withdrawn.
- **SWAP-74** Withdrawn.
- **SWAP-75** Once a swap replaces a plugin's running version, a running turn in any session loses that plugin's tools until the turn ends. That includes sessions other than the one that ran the apply or the reload.
- **SWAP-76** An agent that fixes a tool and applies cannot call the fixed tool in the same turn. The fixed tool is in its next turn.
- **SWAP-77** Calls from sub-agents follow the same rules as calls from the turn's main agent.
- **SWAP-78** The apply output names the sessions with a running turn that it affects, counts their sub-agents, says how long it waited and names any call it interrupted (see 10-cli.md).

The prototype that ran this part had a wrapper that routed a call to the plugin's current version when the bundle hash and the declaration were unchanged, and chad's wrapper does not (SWAP-153).

## Hooks across a swap

The `afterTurn` hook and the `onSession` hook, which carries events such as `Compacted`, run off the reply path, one at a time per plugin, from a queue (see 06-plugin-api.md). A swap has to say which version runs a hook that was queued before it.

- **SWAP-79** The queue of hooks off the reply path belongs to the plugin's name and not to a version. A queued job holds the hook's kind and payload, and the version that runs it is looked up when its turn in the queue comes.
- **SWAP-80** A hook that is running when the gate closes finishes on the old version, and the swap waits for it inside the drain. The swap waits for that hook only and not for the hooks queued behind it.
- **SWAP-81** Hooks still queued at a swap wait for the activation and run on the new version.
- **SWAP-82** A hook still running at the drain deadline is interrupted and logged like a hook past its budget, whatever timeout the plugin gave it. During a swap a hook's own `timeout` is cut at the 30 second drain deadline.
- **SWAP-83** A queued hook of a kind that the new version no longer registers is dropped and logged.
- **SWAP-84** When a plugin is removed, turned off, or switched off by `chad safe on`, its queued hooks are dropped and logged and its timers are held.
- **SWAP-85** The `afterTurn` of a turn that started before a swap and ended after it goes to whichever version is current when the hook runs.
- **SWAP-86** Nothing a plugin keeps in memory is sure to survive from a tool call or `beforeTurn` to `afterTurn`. What must survive goes in the plugin's store (see 06-plugin-api.md).

## Turns and timers that start during a swap

- **SWAP-87** A turn that starts while a swap is running waits for the activation before it builds its Agent.
- **SWAP-88** That turn waits before its `beforeTurn` hooks run, so they run on the new versions.
- **SWAP-89** The wait is at most the drain deadline plus the close deadline, which is 40 seconds.
- **SWAP-90** A timer's handler is core code that starts a turn and waits for it, so the drain neither waits for it nor interrupts it. Only the gate applies to it.
- **SWAP-91** A timer that fires while its plugin is in the middle of a swap is held until the activation and then fires.
- **SWAP-92** A timer whose plugin the swap removed or turned off is held like any unloaded plugin's timer. A plugin deleted from the repo keeps its data and its timers until `chad plugin purge <name>` (see 13-timers-and-cron.md and 10-cli.md).
- **SWAP-93** A rebuild of the MCP layer does not make a starting turn wait the way a plugin swap does. What such a turn gets is in 12-skills-and-mcp.md.

In the run with the real constants, a turn that started during the swap waited 39.8 seconds and ran on the new version, and a timer that fired during it was held 37.9 seconds.

## Reloads that are not applies

A reload that is not an apply rebuilds plugins whose code did not change, because something they read while building did change. These are the triggers:

| Trigger | What is swapped |
| --- | --- |
| `chad plugin reload <name>` | The one named plugin |
| `chad secret set <NAME>` and `chad secret rm <NAME>` | The plugins whose settings name that secret |
| An owner change (`chad owner add` or `chad owner remove`) | Every plugin |
| A timezone change (`chad timezone <zone>`) | Every plugin |
| `chad safe on` | Everything that came from the repo, swapped to nothing |
| `chad safe off` | Whatever `live` holds, loaded the way a boot loads it. Nothing while `CHAD_SAFE_MODE=1` is set (SWAP-152) |

- **SWAP-94** The triggers in the table above each reload the plugins the table names, through the swap path and the daemon's one queue.
- **SWAP-95** `chad plugin reload <name>` rebuilds one plugin whose code did not change. It builds the new instance first and keeps the old one if the build fails.
- **SWAP-143** A reload also builds a plugin that a boot skipped when its trigger names that plugin, which means `chad plugin reload <name>` and the reload after `chad secret set`. It loads the plugin when the build succeeds (see 09-repo-and-recovery.md).
- **SWAP-144** A reload leaves out a plugin that is off in `chad.json`, and `chad plugin reload <name>` refuses one (see 11-settings.md).
- **SWAP-96** In a reload that is not an apply, the change is already stored when the builds run. The plugins that built are swapped, the ones that failed keep their old version, and the command exits 1 and names each failed plugin and its error.
- **SWAP-97** `chad status` marks a plugin that kept its old version with the text "running with the previous <secret|timezone>: <error>".
- **SWAP-141** A plugin that kept its old version after an owner was added is marked with the same line and the word for what changed, "running with the previous owners: <error>".
- **SWAP-142** A plugin that kept its old version after a failed `chad plugin reload` is marked "running with the previous instance: <error>".
- **SWAP-98** The next boot builds with the new value and skips the plugin if it still fails.
- **SWAP-99** When an owner is removed, a plugin whose new build fails is unloaded and does not keep its old version, so that it cannot keep answering the removed person.
- **SWAP-100** `chad safe off` loads `live` the way a boot does and skips and names what fails. It never refuses over what `live` holds (see 09-repo-and-recovery.md).
- **SWAP-152** While `CHAD_SAFE_MODE=1` is set, `chad safe off` and `/safe off` change nothing, the stored flag included. No swap runs, the generation is not bumped, and the subtext line of SWAP-121 is not posted. What they answer and the exit code are in 09-repo-and-recovery.md and 10-cli.md.

In the run, a timezone reload with one plugin that failed to build swapped the other plugin, left the failed one answering on its old instance, exited 1 with `picky: Error: unknown time zone Mars/Olympus`, and status showed `running with the previous timezone: Error: unknown time zone Mars/Olympus`.

## A graceful stop during a swap

- **SWAP-101** A graceful stop abandons a swap that is running. It does so first, before anything waits on requests in flight.
- **SWAP-102** A stop that lands before an apply's commit cancels the apply, which changes nothing. `live` does not move and the next boot loads the old version.
- **SWAP-103** Once `live` has moved, new versions that are not active yet are closed without being activated.
- **SWAP-104** Old versions that are not closed yet go through the ordinary graceful stop, with their queued hooks run inside their budgets.
- **SWAP-105** A plugin that is between its close and its activation when the stop lands drops its queued hooks with a log line.
- **SWAP-106** After a stop that landed after the commit, the next boot loads the new version, and a turn the stop cut resumes on it.
- **SWAP-107** Withdrawn.
- **SWAP-108** Withdrawn.
- **SWAP-109** A graceful stop has no 10 second step of its own for closing the plugins. The plugins' scopes close in the stop's last step, before the MCP layer, and that step ends 60 seconds from SIGTERM. The stop's order and its 60 second deadline are in 01-image-and-volume.md.

The abandon step, from the prototype that ran it at four points of a swap. It is the swap's interruption handler.

```ts
// A graceful stop abandons the swap wherever it is.
Effect.onInterrupt(() =>
  Effect.gen(function*() {
    const report: Array<string> = []
    for (const change of changes) {
      const s = slot(change.plugin)
      if (s.swap === undefined) continue // already activated
      const old = s.current
      if (old !== undefined && old.state === "closed") {
        // Between its close and its activation: nothing of this plugin is left to run a hook.
        s.current = undefined
        s.status = "between"
        dropQueued(s, "the plugin is between its close and its activation")
        report.push(change.plugin + ": old version closed, new one never activated")
      } else report.push(change.plugin + ": stays on " + (old ? id(old) : "nothing") + " for the graceful stop")
      if (change.next !== undefined) yield* close(change.next, "abandoned before its activation")
      s.swap = undefined
    }
    const open = swapping
    swapping = undefined
    if (open !== undefined) Deferred.doneUnsafe(open.gate, Exit.void)
    log("swap.abandoned", { label, report })
  })
)
```

## Sub-agents

- **SWAP-110** clanka keeps a turn open while a background sub-agent runs, even after the model has answered. A message the owner sends meanwhile is steered into that turn and runs on the old Agent.
- **SWAP-111** Calls from a background sub-agent need no rule of their own. They are a running turn's calls, and no background task calls a plugin tool outside a turn.
- **SWAP-112** The apply output counts "sub-agents" for each affected session.

The host that ran this counted a turn's sub-agents from the `SubagentStart` and `SubagentComplete` parts of the turn's stream. In the run a foreground and a background sub-agent each made one call that was refused after a code change.

## The messages returned to the model

Each message below is the failure text of a plugin tool call, and the table names the rule that sends it. `<tool>` is the tool's name.

- **SWAP-113** A call interrupted at the drain deadline whose handler stopped within the 1 second wait fails with message 5. The message does not tell the model to call again, because that is unsafe for a tool with side effects.
- **SWAP-114** A call interrupted at the drain deadline whose handler did not stop within the 1 second wait fails with message 6.
- **SWAP-123** The six messages in the table below are templates in chad's one `Messages` module, and a test refers to each by its name there (see 17-testing.md).

| # | Text | Sent by |
| --- | --- | --- |
| 1 | `<tool> was changed by an apply. The new version is in your next turn.` | SWAP-69 |
| 2 | `<tool> was changed by an apply. The new version is in your next turn, which cannot start while this turn has a sub-agent running.` | SWAP-70 |
| 3 | `<tool> was removed by an apply and is gone from your next turn.` | SWAP-71, SWAP-140 |
| 4 | `<tool> is off in safe mode.` | SWAP-72 |
| 5 | `<tool> was interrupted by an apply, it may have partly run.` | SWAP-113 |
| 6 | `<tool> did not stop when an apply interrupted it and may still be running.` | SWAP-114 |

## Carried to the test suite

- **SWAP-115** The check that a removed plugin's queued hook is dropped and logged depends on an order, which the test states. It holds the first hook open until the removal (see 17-testing.md).
- **SWAP-124** How the rules of this part are tested is in 17-testing.md, which holds the layer the swap scenarios run in.
- **SWAP-145** Withdrawn.
- **SWAP-146** Withdrawn.

## Gaps

- **SWAP-G3** [builder] The exact wording of the chunk update message. Only the text for one changed chunk ran. The line for a removed chunk, the text for a chunk the session has never seen, and the layout when several chunks change at once or share the message with the lines about what chad posted are not fixed (TIM-531 item 3, TIM-557 item 30).
- **SWAP-G8** [builder] The exact text of the apply output lines for the wait, the interrupted calls and the affected sessions. The prototype printed `s-c1 loses echo until its turn ends (0 sub-agents running)` for a session (TIM-547 item 9).
- **SWAP-G10** [builder] The wording of the safe mode line in the rendered prompt, and where in the prompt it goes (TIM-549 item 15).
- **SWAP-G12** [builder] Five things are decided and were never run, and no layer is named for their tests. They are a hook that ignores interruption, a secret change through the swap path, the next boot after a reload whose build failed, `stopTask` through the owner id wrapper, and the completion notice of SWAP-17 (TIM-552, TIM-531, TIM-558 items 51 to 55).
- **SWAP-G14** [builder] The closed list of event names in 16-failures-logs-status.md has no name for two lines the prototype wrote, which are a call the wrapper refused and a swap that a graceful stop abandoned. No ticket says whether chad logs them or under which name (TIM-557 items 2 and 3, TIM-559 round 2 R4).

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| SWAP-1 | TIM-531 item 1 | Tim | run |  | `rule` | `apply` |
| SWAP-2 | TIM-531 item 5, TIM-542 item 27 | Tim | run |  | `rule` | `apply` |
| SWAP-3 | TIM-531 item 5 | Tim | not run |  | `rule` | `apply` |
| SWAP-4 | TIM-531 item 1 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-5 | TIM-531 item 1, kept by TIM-552 question 1 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-6 | TIM-531 item 1 | Tim | run |  | `rule` | `apply` |
| SWAP-7 | TIM-552 question 1, amending TIM-531 item 1 | Tim | run |  | `rule` | `apply` |
| SWAP-8 | TIM-535 (the model setting) | Tim | not run |  | `rule` | `plugin-api` |
| SWAP-9 | TIM-537 items 1 and 2 | Tim | read |  | `rule` | `skills-mcp` |
| SWAP-10 | TIM-537 follow-up rule 7, kept by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| SWAP-11 | TIM-532 item 11, changed by the TIM-559 ruling on SWAP-G2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SWAP-12 | TIM-531 item 1 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-13 | TIM-531 item 1 and its source notes | Tim | read |  | `fact` | `plugin-api` |
| SWAP-14 | TIM-531 item 4 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-15 | TIM-531 item 4 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-16 | TIM-531 item 4 and its support notes (run on clanka 0.27.0, read again in clanka 0.28.0 `src/Agent.ts:1056-1067` and `1517`) | Tim | run |  | `fact` | `plugin-api` |
| SWAP-17 | TIM-531 item 4 | Tim | not run |  | `rule` | `plugin-api` |
| SWAP-18 | TIM-531 item 4, withdrawn by the TIM-559 ruling on SWAP-G4 | Architect (Tim has not read) | not run | TIM-559 | `rule` | - |
| SWAP-19 | TIM-531 item 6, amended by the TIM-537 follow-up | Tim | read |  | `rule` | `skills-mcp` |
| SWAP-20 | TIM-544 item 2, amending TIM-531 item 1 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-21 | TIM-531 item 7, replaced by TIM-544 item 1, TIM-559 cold read | Tim | run |  | `rule` | `models` |
| SWAP-22 | TIM-531 (prototype notes), map facts | Tim | run |  | `rule` | `turns` |
| SWAP-23 | Agreed at charting, TIM-531 item 2 | charting | run |  | `rule` | `plugin-api` |
| SWAP-24 | TIM-531 item 2 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-25 | TIM-531 item 3 | Tim | not run |  | `rule` | `plugin-api` |
| SWAP-26 | TIM-549 item 16 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `settings` |
| SWAP-27 | TIM-549 item 15 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `apply` |
| SWAP-28 | TIM-549 items 14 and 16 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `settings` |
| SWAP-29 | TIM-532 item 11, changed by the TIM-559 ruling on SWAP-G2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SWAP-30 | TIM-531 item 3 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-31 | Agreed at charting, TIM-531 item 3 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-32 | TIM-532 item 9 | Tim | read |  | `rule` | `plugin-api` |
| SWAP-33 | TIM-531 item 3 | Tim | not run |  | `rule` | `plugin-api` |
| SWAP-34 | TIM-531 item 3 | Tim | not run |  | `rule` | `plugin-api` |
| SWAP-35 | TIM-539 item 5, run in TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-36 | TIM-531 item 3 | Tim | not run |  | `rule` | `plugin-api` |
| SWAP-37 | TIM-531 item 3 | Tim | read |  | `fact` | `plugin-api` |
| SWAP-38 | TIM-539 (comment on TIM-531), run in TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| SWAP-39 | TIM-547 item 1 | Architect (Tim has not read) | run |  | `rule` | `apply` |
| SWAP-40 | TIM-542 item 4 | Tim | run |  | `rule` | `apply` |
| SWAP-41 | TIM-538 item 3, TIM-542 item 10 | Tim | run |  | `rule` | `apply` |
| SWAP-42 | TIM-547 item 2 | Architect (Tim has not read) | run |  | `rule` | `apply` |
| SWAP-43 | TIM-547 item 2, TIM-538 item 9 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-44 | TIM-547 item 3 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-45 | TIM-547 item 4 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-46 | TIM-552 decision 3, amending TIM-547 item 4 | Tim | run |  | `rule` | `apply` |
| SWAP-47 | TIM-547 item 5 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-48 | TIM-552 decision 3, amending TIM-547 items 5 and 12 | Tim | run |  | `rule` | `apply` |
| SWAP-49 | TIM-547 item 6 | Architect (Tim has not read) | run |  | `rule` | `apply` |
| SWAP-50 | TIM-547 item 6 | Architect (Tim has not read) | not run | TIM-547 | `rule` | `apply` |
| SWAP-51 | TIM-538 item 9 | Tim | run |  | `rule` | `apply` |
| SWAP-52 | TIM-538 item 9, amended by TIM-552 question 2 | Tim | run |  | `rule` | `apply` |
| SWAP-53 | TIM-552 decision 3 | Tim | run |  | `rule` | `apply` |
| SWAP-54 | TIM-549 item 28, kept by TIM-555, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| SWAP-55 | TIM-542 item 6, amended by TIM-547 item 15 and TIM-550 item 11 | Architect (Tim has not read) | run | TIM-547, TIM-550 | `rule` | `apply` |
| SWAP-56 | TIM-550 item 11 | Architect (Tim has not read) | run | TIM-547, TIM-550 | `rule` | `apply` |
| SWAP-57 | TIM-542 item 25 | Tim | not run |  | `rule` | `apply` |
| SWAP-58 | TIM-548 item 9 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| SWAP-59 | TIM-547 item 7, amended by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-60 | TIM-547 items 7 to 9 (comment on TIM-531), amended by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-61 | TIM-547 item 7, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-547 | `rule` | - |
| SWAP-62 | TIM-552 decision 1, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Tim | run |  | `rule` | - |
| SWAP-63 | TIM-552 decision 1, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Tim | run |  | `rule` | - |
| SWAP-64 | TIM-552 decision 2, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Tim | run |  | `rule` | - |
| SWAP-65 | TIM-552 decision 2, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Tim | run |  | `rule` | - |
| SWAP-66 | TIM-552 decision 2, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Tim | run |  | `rule` | - |
| SWAP-67 | TIM-547 item 7, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-547 | `rule` | - |
| SWAP-68 | TIM-549 item 12, amended by TIM-552, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Tim | run |  | `rule` | - |
| SWAP-69 | TIM-547 item 8, amended by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-70 | TIM-552 decision 7, amending TIM-547 item 8 | Tim | run |  | `rule` | `apply` |
| SWAP-71 | TIM-547 item 8 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-72 | TIM-547 item 8 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-73 | TIM-547 item 3, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-547 | `rule` | - |
| SWAP-74 | TIM-547 item 8, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-547 | `rule` | - |
| SWAP-75 | TIM-547 item 9, amended by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-76 | TIM-547 items 7 to 9 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-77 | TIM-547 item 8 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-78 | TIM-547 item 9, amended by TIM-552 decision 6 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-79 | TIM-547 item 10 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-80 | TIM-547 item 10 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-81 | TIM-547 item 10 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-82 | TIM-547 item 4 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-83 | TIM-547 item 10 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-84 | TIM-547 item 10 | Architect (Tim has not read) | run | TIM-547 | `rule` | `timers-cron` |
| SWAP-85 | TIM-547 item 11 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-86 | TIM-547 item 11 | Architect (Tim has not read) | not run | TIM-547 | `definition` | - |
| SWAP-87 | TIM-547 item 12 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-88 | TIM-552 decision 5, amending TIM-547 item 12 | Tim | run |  | `rule` | `apply` |
| SWAP-89 | TIM-547 item 12, kept by TIM-552 decision 3 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-90 | TIM-547 item 13 | Architect (Tim has not read) | run |  | `rule` | `timers-cron` |
| SWAP-91 | TIM-547 item 13 | Architect (Tim has not read) | run | TIM-547 | `rule` | `timers-cron` |
| SWAP-92 | TIM-547 item 13, TIM-542 item 12 | Architect (Tim has not read) | run |  | `rule` | `timers-cron` |
| SWAP-93 | TIM-537 follow-up rule 6, amended by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| SWAP-94 | TIM-542 items 10, 14, 16, 17 and 25, TIM-547 item 1 | Tim | run |  | `rule` | `settings` |
| SWAP-95 | TIM-542 item 10 | Tim | run |  | `rule` | `apply` |
| SWAP-96 | TIM-547 item 14 | Architect (Tim has not read) | run | TIM-547 | `rule` | `settings` |
| SWAP-97 | TIM-547 item 14 | Architect (Tim has not read) | run | TIM-547 | `rule` | `settings` |
| SWAP-98 | TIM-547 item 14 | Architect (Tim has not read) | not run | TIM-547 | `rule` | `settings` |
| SWAP-99 | TIM-547 item 14 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-100 | TIM-542 item 25, narrowed by TIM-559 round 3 C2 | Architect (Tim has not read) | run | TIM-559 | `rule` | `apply` |
| SWAP-101 | TIM-547 item 15, order from TIM-552 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-102 | TIM-547 item 15 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-103 | TIM-547 item 15 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-104 | TIM-547 item 15 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-105 | TIM-547 item 15 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-106 | TIM-547 item 15 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SWAP-107 | TIM-552 decision 4, amending TIM-547 item 15, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Tim | run |  | `rule` | - |
| SWAP-108 | TIM-552 decision 4, amending TIM-547 item 15, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Tim | run |  | `rule` | - |
| SWAP-109 | TIM-547 (passed to TIM-541), TIM-541 item 25, changed by TIM-553 question 1, provisional by TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run |  | `rule` | `apply` |
| SWAP-110 | TIM-552 question 1 | Tim | run |  | `fact` | `turns` |
| SWAP-111 | TIM-552 decision 6 | Tim | run |  | `definition` | - |
| SWAP-112 | TIM-552 decision 6, amending TIM-547 item 9 | Tim | run |  | `rule` | `apply` |
| SWAP-113 | TIM-547 item 4, wording from TIM-552 decision 3 | Tim | run |  | `rule` | `apply` |
| SWAP-114 | TIM-552 decision 3, amending TIM-547 item 4 | Tim | run |  | `rule` | `apply` |
| SWAP-115 | TIM-553 (comment on TIM-552), TIM-558 item 30 | Architect (Tim has not read) | run | TIM-553 | `rule` | `apply` |
| SWAP-116 | TIM-557 items 7 and 8 | Architect (Tim has not read) | run |  | `rule` | `plugin-api` |
| SWAP-117 | TIM-557 item 30 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| SWAP-118 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SWAP-119 | TIM-557 item 41 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SWAP-120 | TIM-557 items 2 and 3, TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SWAP-121 | TIM-557 item 39, defining TIM-550 item 11, changed by the TIM-559 ruling on SWAP-G13 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SWAP-122 | TIM-557 item 8 | Architect (Tim has not read) | run |  | `rule` | `plugin-api` |
| SWAP-123 | TIM-558 items 30 and 33, amended by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SWAP-124 | TIM-558 items 9, 29 and 42, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| SWAP-125 | TIM-559 ruling on SWAP-G1 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| SWAP-126 | TIM-559 ruling on SWAP-G1 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| SWAP-127 | TIM-559 ruling on SWAP-G1 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| SWAP-128 | TIM-559 ruling on SWAP-G1 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SWAP-129 | TIM-559 ruling on SWAP-G2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SWAP-130 | TIM-559 ruling on SWAP-G2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SWAP-131 | TIM-559 ruling on SWAP-G2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SWAP-132 | TIM-559 ruling on SWAP-G4 | Architect (Tim has not read) | read | TIM-559 | `rule` | `plugin-api` |
| SWAP-133 | TIM-559 ruling on SWAP-G4 | Architect (Tim has not read) | not run | TIM-559 | `definition` | - |
| SWAP-134 | TIM-559 ruling on SWAP-G4 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SWAP-135 | TIM-559 ruling on SWAP-G4 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SWAP-136 | TIM-559 ruling on SWAP-G5 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SWAP-137 | TIM-559 ruling on SWAP-G5 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SWAP-138 | TIM-559 ruling on SWAP-G13 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SWAP-139 | TIM-559 ruling on SWAP-G13 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SWAP-140 | TIM-559 ruling on SWAP-G7 and SET-G7 | Architect (Tim has not read) | not run | TIM-548, TIM-559 | `rule` | `settings` |
| SWAP-141 | TIM-559 ruling on SWAP-G9 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| SWAP-142 | TIM-559 ruling on SWAP-G9 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| SWAP-143 | TIM-559 ruling on REC-G19 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| SWAP-144 | TIM-559 ruling on SET-G8 and SET-G9 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| SWAP-145 | TIM-559 ruling on SWAP-G11, withdrawn by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| SWAP-146 | TIM-559 ruling on SWAP-G11, withdrawn by Jarvis's correction to Tim's ruling that chad has no release ceremony, TIM-560 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| SWAP-147 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SWAP-148 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SWAP-149 | TIM-559 round 3 A1 and MCP-G19 | Architect (Tim has not read) | read |  | `fact` | `skills-mcp` |
| SWAP-150 | TIM-559 round 3 C1 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SWAP-151 | TIM-559 round 3 API-G15 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| SWAP-152 | TIM-559 round 3 C2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| SWAP-153 | Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Tim; the wording Jarvis (Tim has not read) | not run |  | `rule` | `apply` |
