# Overview and architecture

This part says what chad is, what v1 contains and leaves out, which versions it is built on, which processes run, and how a message travels from Discord through a session to the agent and back. It then lists the behaviours of clanka and effect/chat that the design depends on, and ends with a glossary of the terms the other parts use. It is an orientation. Each rule states a top-level commitment and names the part that holds the detail, and the table under "Where the detail lives" lists every part.

## What chad is

chad is a personal assistant that one person runs for themselves. It replaces Hermes, the assistant Tim runs today. Three names recur below. effect/chat is the chat library of the Effect project, which is not released yet and is installed from a snapshot of effect pull request 10581 (branch `effect-chat`). clanka is the agent library from `Effectful-Tech/clanka`, which runs a model in a loop with tools, sub-agents and compaction. The daemon is the long-running chad process started by `chad serve`, and the agent is the clanka agent that the daemon runs for the owner.

- **OV-1** chad is a single-owner personal assistant daemon that replaces Hermes for Tim. effect/chat handles the chat side, clanka is the agent, and chad ships as one Docker image, `ghcr.io/tim-smart/chad`, with one data volume. Its source lives in the repo `tim-smart/chad`, which is public.
- **OV-2** Only a user whose id is on the owner allowlist can trigger the agent. chad has no multi-tenant use and gives no access to anyone who is not an owner.
- **OV-3** The container is the sandbox. clanka's tools are unsandboxed and the agent's `bash` runs inside the container as the daemon's user, so chad guards against the agent's mistakes and not against a hostile agent. Deliberate damage is left to backups of the volume (see 02-storage.md and 09-repo-and-recovery.md).
- **OV-4** The core stays thin, and bundled features are plugins too. chad modifies itself by editing files in the repo on the data volume, which hold its plugins, skills, MCP config, plugin settings and persona. A change to the core ships as a new image. chad does not edit its own core source and does not restart itself.

## What v1 contains

- **OV-5** The v1 chat platforms are Discord and a local dev adapter. The local dev adapter is a connection kind, added with `chad connection add local`. Inside the daemon it is a client that forwards the adapter's operations over effect RPC to a platform that listens at `run/local.sock`. That platform is effect/chat's `ChatTest` behind an RPC server. It runs outside the daemon because `ChatTest` keeps its threads in memory and would lose them when the daemon restarts. The platform lives in the repo's test support and in a short developer script and is not in the image, which carries only the adapter client (see 17-testing.md).
- **OV-6** Beyond what clanka brings, v1 adds scheduled tasks and sessions that survive a restart. Cron ships as a bundled plugin so that it proves the plugin API, and the schedule itself is held by the core (see 13-timers-and-cron.md).
- **OV-7** Plugins are TypeScript files that use Effect. They are hot reloaded, and chad can write its own. A plugin can add tools, contribute chunks to the system prompt and register lifecycle hooks (see 06-plugin-api.md and 07-plugin-loading.md).
- **OV-8** chad has a CLI, `chad`. The agent uses it to modify chad, and the owner uses it for the same changes and for first setup. The CLI does not write a plugin's source. The agent writes the source as files, and the CLI scaffolds, checks and applies it. A change takes effect only through a CLI command or the chat form of one, so chad has no file watcher (see 10-cli.md). The one exception is what clanka's own walk finds. clanka walks up from a session's working directory, and in every directory it visits it reads an `AGENTS.md` file and the skills under `.agents/skills` and `.kiro/skills` and shows them to that session without an apply. The daemon does nothing about the walk. `chad check` and an apply refuse `AGENTS.md`, `.agents/` and `.kiro/` in the repo, in the tree they export and on disk in `repo/work/`, so a line in `.gitignore` does not get one past them and an apply never commits one. A draft of one in `repo/work/` still reaches a session whose agent works there, and a boot does not look for one (see 12-skills-and-mcp.md for how far the walk reaches and for its test, and 07-plugin-loading.md for the refusal and for the boot).
- **OV-9** v1 runs `openai/gpt-6-astra` at effort `medium` on a Codex login through clanka's `openai` provider. `openai-compat` with a URL and a key from the environment is the path that needs no login (see 05-model-and-login.md).
- **OV-10** chad has no built-in memory. Memory is a plugin concern, and asphodel is the answer. The asphodel plugin is the acceptance test for the plugin API, and the spec shows it expressed against the API (see 18-asphodel-plugin.md). chad's repo carries the plugin as a test fixture, which runs through the real daemon against a fake asphodel daemon and is not in the image (see 17-testing.md). The fixture files in the repo are the source, and the code blocks of 18-asphodel-plugin.md are compared against them. Porting the real plugin is follow-up work in the asphodel repo and is not part of v1.
- **OV-11** v1 also contains the features in the table below, each specified in the part named.

| Feature | Detail in |
| --- | --- |
| Skills and MCP servers, with OAuth login for HTTP MCP servers | 12-skills-and-mcp.md |
| Recovery from a bad self-edit, with safe mode and `chad revert` | 09-repo-and-recovery.md |
| Plugin settings in `chad.json`, and turning a plugin off | 11-settings.md |
| The model login completed from Discord or from `chad login` | 05-model-and-login.md |
| Backup of chad's state on the volume to one tar, and restore from it | 02-storage.md |
| Credential tools, which are stored secrets, one-off codes and asking the owner for a value, with no browser in the image | 15-credentials.md |
| The bundled `self-edit` skill that teaches chad to change itself | 14-self-edit-skill.md |
| The log on standard output and in `logs/chad.log`, the `chad logs` command, what the owner is told when a turn fails or a condition needs attention, the tokens each turn used, and the bundled `diagnose` skill | 16-failures-logs-status.md |

## What v1 leaves out

- **OV-12** chad does not validate Slack, and v1 writes no new effect/chat adapters such as Telegram or WhatsApp.
- **OV-13** v1 has no web dashboard, no chat CLI or TUI, no alternative terminal backends and no profiles. The `chad` CLI that manages chad and runs first setup is in scope.
- **OV-14** clanka is used as it is. v1 depends on no change to clanka except one, an auth provider argument on `McpServers.layer` for HTTP MCP servers that sign in with OAuth, and the pinned release carries it as `McpServers.layer(config, authProvider?)` (see 12-skills-and-mcp.md). The cost of this rule is that answer text cannot be streamed token by token.
- **OV-15** Moving from Hermes is not part of v1. Existing Hermes skills already use `SKILL.md` and are copied over as files, and chad imports no history.
- **OV-49** v1 works out no cost for a turn, moves to no other model by itself when a login reaches its usage limit, gives a plugin no API of its own to notify the owner, and gives plugin authors no test helper (see 16-failures-logs-status.md and 17-testing.md).

## Pinned versions

The table gives each pin and the version at which the design was read from source or run. Where the two differ, the facts under "Facts about clanka and effect/chat that the design leans on" were read at the older version. A builder who moves a pin has to expect those facts to move with it.

| Component | Pin | Where it was read or run |
| --- | --- | --- |
| Node | 26, the current LTS line. The image base is `node:26-trixie-slim`, pinned by digest. | The prototypes ran on Node 26.8.2. |
| clanka | 0.28.0 from npm, pinned by the lockfile and not vendored. | Read at commit `88a1e05`, which is 0.27.0. The published 0.28.0 was checked for `McpServers.layer(config, authProvider?)`, and its changelog shows that optional argument as the only change since 0.27.0. |
| `effect` and every `@effect/*` package | One snapshot of effect pull request 10581 (branch `effect-chat`) at one commit, vendored as tarballs under `vendor/` in the chad repo. The floor is commit `e1ae842`, and a manifest under `vendor/` names the exact commit. | Read at `0b51fb1`. The Discord adapter's handling of authors, its two gateway layers, the adapter's list of operations and `ChatTest` were read again at `e1ae842`. The image that was built vendored `0b51fb176db86e796a914921b11c544eac2670af`. |
| TypeScript | Version 7, the native compiler, shipped in the image for the type-check of an apply. | The prototypes used 7.0.2. |
| esbuild | Shipped in the image for bundling plugins. | The prototypes used 0.28.2. |
| dfx, the Discord library under effect/chat | No pin is decided. | Read at `4625778`. |

- **OV-16** chad runs on Node 26. clanka decides the runtime, because its executor depends on `node:vm` and `worker_threads` (see 07-plugin-loading.md and 01-image-and-volume.md).
- **OV-17** clanka is 0.28.0 from npm, pinned by the lockfile and not vendored (see 01-image-and-volume.md).
- **OV-18** `effect` and every `@effect/*` package come from one snapshot of the effect pull request at one commit, vendored as tarballs under `vendor/` in the chad repo, and the daemon holds exactly one copy of `effect`. A plugin's package imports are answered by the daemon's own copies, and CI fails when `node_modules` holds more than one `effect` (see 01-image-and-volume.md, 07-plugin-loading.md and 17-testing.md).
- **OV-51** The vendored effect snapshot is the `effect-chat` branch at commit `e1ae842` or a newer commit of that branch. When a newer commit may be taken is stated in 17-testing.md.
- **OV-52** A manifest under `vendor/` names the exact commit of the vendored snapshot. The spec names only the floor, so that moving to a newer snapshot changes the manifest and no rule (see 01-image-and-volume.md).
- **OV-53** If effect/chat ships in a release of effect before the first build slice, chad installs the released packages and the repo has no `vendor/` directory (see 19-build-order.md).

## Processes

chad is one program in one container. The sketch shows what runs where.

```
container, image ghcr.io/tim-smart/chad, user node (uid 1000)
  tini
    chad serve                     the daemon, one process
      Discord gateway connection   outbound, through effect/chat and dfx
      unix socket run/chad.sock    effect RPC, for the chad CLI
      Session entities             one per session, each with a clanka Agent and an executor
      Timer entities               scheduled plugin turns
      plugins                      bundled ones and the ones in repo/live, on the main thread
      MCP layer                    one for the process
      workers                      the agent's scripts
      child processes              the agent's commands (CHAD_SESSION=<session id>)
                                   stdio MCP servers (CHAD_SESSION=daemon)
  chad <command>                   a client, run by the owner with docker exec or by the agent
/data                              the data volume
other containers                   asphodel, and a browser if the owner wants one
```

- **OV-19** There is one `chad` executable. `chad serve` is the daemon and the container's command, and every other command is a short-lived client that reaches the daemon over a unix socket at `run/chad.sock` with effect RPC. chad listens on no network port, because the CLI uses the socket and Discord is reached over an outbound gateway connection (see 10-cli.md).
- **OV-20** One daemon runs per data volume. The daemon holds a SQLite lock on `state/daemon.lock` for its whole life, and a second `chad serve` on the same volume fails to take it and exits (see 10-cli.md).
- **OV-21** The daemon is one process that holds the chat connection, every session, the loaded plugins, the MCP connections and the timers. Plugin tools and hooks run on its main thread, the agent's scripts run in a worker, and the commands the agent runs and the stdio MCP servers are child processes of the daemon. A synchronous loop in a plugin therefore freezes the whole daemon, and the liveness probe `chad health` is the answer (see 07-plugin-loading.md and 01-image-and-volume.md).
- **OV-22** All of chad's own state is on the one data volume, mounted at `/data`. Sessions, turns, timers, the stored requests that dedupe chat events, the record of the notices chad has sent and plugin state are in one SQLite file, `db/chad.db`, and each plugin gets a namespaced key-value store in it. Chat connections with their owner ids, secrets, model tokens, the safe mode flag, the boot counter, the model override and the thread that notices go to are files outside the database and outside the repo (see 02-storage.md and 16-failures-logs-status.md).
- **OV-23** One queue in the daemon orders everything that changes what is loaded, so two such changes never run at once (see 10-cli.md).
- **OV-41** The daemon writes every log entry to two places, standard output as one logfmt line and `logs/chad.log` as one JSON line. The entries include the source and the output of the agent's scripts with nothing masked, so those go wherever the container's logs are shipped. The one exception to the two places is a boot that is refused before it holds the daemon lock. It writes its lines to standard output only and writes nothing to the volume (see 16-failures-logs-status.md and 01-image-and-volume.md).
- **OV-42** One function, `runDaemon(inputs)`, owns the parts of the daemon that belong to the process, and `chad serve` is a few lines that call it. Every duration the spec names lives in one `Timings` service (see 17-testing.md, which also specifies the one `Messages` module for what chad posts in chat, its CLI errors and the messages the model reads as tool results).

The owner can run other containers next to chad. asphodel runs as a second Compose service or a Kubernetes sidecar (see 01-image-and-volume.md and 18-asphodel-plugin.md), and a browser runs as a container that shares chad's network namespace (see 15-credentials.md). Neither is part of the chad image.

### The main parts of the daemon

The left column describes each part. The tickets fix names only where the name is in code font, and the module layout of the chad repo is not decided.

| Part | What it does | Detail in |
| --- | --- | --- |
| The gateway handler | Receives each Discord event from effect/chat, checks the owner and the mention, opens a thread when one is needed and saves the message as a request to the session. | 03-sessions-and-turns.md, 04-discord.md |
| The `Session` entity | Runs one session on effect cluster's `SingleRunner`. It holds the session's clanka Agent and executor, starts and steers turns, posts to chat and stores the history. | 03-sessions-and-turns.md |
| The `Timer` entity and the `timers` table | Hold each scheduled plugin turn until it is due, and save the next run of a recurring one. | 13-timers-and-cron.md |
| The loader | Bundles each plugin with esbuild, runs the bundle with `vm.compileFunction` and builds the plugin's Layer in a scope of its own. | 07-plugin-loading.md |
| The swap path and the generation counter | Replace running plugin versions and tell each session when to rebuild its Agent. | 08-apply-and-swap.md |
| The apply path | Snapshots `repo/work/`, checks it, commits it and moves `repo/live`. It also serves `chad check` and `chad revert`. | 09-repo-and-recovery.md, 07-plugin-loading.md |
| The services a plugin gets | `PluginContext`, `Turns`, effect/chat's `Chat`, `HttpClient`, `FileSystem`, `Path` and `DateTime.CurrentTimeZone`. | 06-plugin-api.md |
| The MCP layer | One clanka `McpServers` instance for the process, behind a wrapper that routes each call to the current layer. | 12-skills-and-mcp.md |
| The model layer and the login | One `CodexAuth` for the process and one `OpenAiClient` per session. | 05-model-and-login.md |
| The RPC server and the single queue | Serve the CLI on the unix socket and order every change to what is loaded. | 10-cli.md |
| The bundled plugins and skills | The plugins `cron` and `send-file` and the skills `self-edit`, `credentials` and `diagnose`, shipped in the image. | 13-timers-and-cron.md, 04-discord.md, 14-self-edit-skill.md, 15-credentials.md, 16-failures-logs-status.md |
| The logger and the notices | One logger writes chad's log to standard output and to `logs/chad.log` and leaves what a script's output shows the model unchanged. The notices tell the owner about a condition outside a turn. | 16-failures-logs-status.md |

## How a message flows

The rules in this section follow one owner message from Discord to the answer, then say what a restart and a self-edit do to that path. The session runtime was run with a test chat adapter, with kills and restarts. The Discord gateway side was read from source and has not been run against a real bot.

- **OV-24** A Discord event reaches chad's handler through effect/chat, whose Discord adapter drops nothing by author. The handler first drops a message that chad itself posted, then checks the owner and the mention, opens a Discord thread when the message is a mention in a plain channel, saves the message as a persisted request to the session's entity and returns without waiting for the turn. chad always answers in a direct message and answers in a server channel only when mentioned, and in a thread that already has a session any owner message triggers it (see 03-sessions-and-turns.md).
- **OV-25** There is one session per chat thread, and each session is one `Session` entity on effect cluster's `SingleRunner` over the SQLite file. An owner message starts a turn when the session is idle and steers the running turn otherwise. A turn that a plugin or a timer starts is a request to the same entity and waits for the session to be idle. clanka does not reject a second `send` on a busy Agent, so the entity is what keeps a session to one `send` at a time (see 03-sessions-and-turns.md).
- **OV-26** At the start of a turn chad rebuilds the session's Agent if the session's generation is behind, checks the model login, puts any changed prompt chunks and an account of what chad itself posted in the thread since the last answered turn into one `<environment-update>` message, runs the `beforeTurn` hooks and then calls clanka's `send` (see 03-sessions-and-turns.md, 08-apply-and-swap.md, 05-model-and-login.md and 16-failures-logs-status.md).
- **OV-27** A turn in Discord is one status message, posted when the turn starts and edited in place while the agent works. clanka runs the agent's scripts in the session's executor, and a script's calls to plugin tools and MCP tools go through chad's wrappers, which route each call to the version that is current or refuse it (see 04-discord.md, 08-apply-and-swap.md and 12-skills-and-mcp.md).
- **OV-28** The answer is posted once, as normal messages, after clanka's stream ends with `AgentFinished`, and the status message is removed however the turn ends. clanka sends text and reasoning deltas as the same output part and the clean final answer only at the end, so chad does not stream answer text (see 04-discord.md).
- **OV-29** chad stores the history as clanka appends it, and at the end of every turn, however it ends, it makes the stored history equal to the Agent's history before it records the turn's end. It keeps one `turns` row per turn request, which is its record of what has run, how it ended and how many tokens it used. After a turn ends, the plugins' `afterTurn` hooks run off the reply path (see 03-sessions-and-turns.md, 02-storage.md and 16-failures-logs-status.md).
- **OV-30** A session survives a restart. An idle session is passivated after 30 minutes and restored from SQLite by its next message, a turn that a restart cut off is resumed, and chad gives up on a turn after two starts that ended in a kill. A start that a graceful stop cut does not count towards the two. `/new` starts a fresh session in the same thread and tells plugins, and `/stop` interrupts the running turn (see 03-sessions-and-turns.md).
- **OV-31** A self-edit follows one path. The agent edits files in `repo/work/` and runs `chad apply`. The daemon checks the files, commits them, moves `repo/live`, swaps the plugins that changed and bumps the generation, and each session picks the change up at the start of its next turn. A change that fails a check keeps the last good version running, an edit that was not applied stays a draft, and a boot loads the last applied commit (see 08-apply-and-swap.md, 09-repo-and-recovery.md and 07-plugin-loading.md).
- **OV-43** A turn that fails ends as `Failed` with a reason from a closed set. For most reasons chad itself, without the model, posts one message in the thread that names the reason and the turn id, and `chad logs --turn <id>` shows what the turn did (see 16-failures-logs-status.md).
- **OV-44** What chad tells the owner outside a turn is a notice. It is a normal message and not subtext, and in a server thread it carries the owner's mention. A notice about a condition is sent once when the condition begins and is not sent again while the condition holds (see 16-failures-logs-status.md).
- **OV-45** The Discord gateway side of this flow is tested in two places. A wire slice runs the real `DiscordChat.layerDispatchHook` and a real dfx shard over a scripted socket, and a nightly job has a second bot drive chad on a real gateway (see 17-testing.md).

## Facts about clanka and effect/chat that the design leans on

Each rule pairs a behaviour of clanka or of effect/chat with what chad does because of it. The behaviours were read from source at charting, clanka at 0.27.0 and effect/chat at `0b51fb1`, and the parts named hold what was later run. The two rules about effect/chat, OV-39 and OV-40, were read again at `e1ae842`, the floor of the pin, and hold there. The Provenance table marks each of these rules as a fact. A fact is tested against the pinned versions, or it carries a waiver that names the rule whose test would fail if the fact stopped holding (see 17-testing.md).

- **OV-32** clanka fixes an Agent's tools when the Agent is built, and `send` takes only `prompt` and `system`. chad therefore applies a change of tools, skills or MCP servers to a session by building a new Agent between turns. clanka's history and environment are `MutableRef` values with Schema codecs, so the new Agent continues the conversation after `MutableRef.set` on both (see 08-apply-and-swap.md).
- **OV-33** clanka's tool declarations are part of the system prompt, so a tool change renders the system prompt again, and losing the prompt cache at that point is accepted. When only a plugin's chunk changes during a session, chad keeps sending the session's frozen prompt through the function form of `send({ system })`, clanka leaves the stored system message alone because the text is identical, and the change reaches the session as an update message, so prompt cache reads survive (see 08-apply-and-swap.md).
- **OV-34** clanka's Codex model layer picks a random `prompt_cache_key` each time it is built unless one is passed. chad passes the session id as the key and also sends it as a `session-id` request header, because the key alone loses the cached history on every new connection. It does both on a Codex login and with `openai` on an API key. With `openai-compat` it sends neither, because a gateway may refuse a field it does not know (see 05-model-and-login.md).
- **OV-35** clanka connects MCP servers once, when the layer is built, and has no add, remove or reload. Its config is `{ mcpServers: { name: stdio | http } }`. chad keeps one `McpServers` instance for the process, hands it to every rebuilt Agent and rebuilds the layer as a whole, never one server at a time (see 12-skills-and-mcp.md for what starts a rebuild).
- **OV-36** Left to itself, clanka reads the skills in `$HOME` and `$HERMES_HOME` once per Agent. chad scans its skill directories itself and passes clanka an explicit list each time it builds an Agent. The list takes the place of that discovery, so a skill under `$HOME` or `$HERMES_HOME` is not loaded, and a session sees a skill change on its next turn. One walk of clanka's stays on with a list in place. It goes up from the working directory, reads `AGENTS.md` and the project skills in every directory it visits, and announces what it has not shown yet in an `<environment-update>` user message. chad does not stop it, because stopping it needs a change to clanka (see 12-skills-and-mcp.md).
- **OV-37** A clanka prompt can carry images as `FilePart`, and no clanka output part carries files. An image on an owner message that starts a turn goes to the model, and any other file is saved in the session's working directory. How the agent sends a file to the owner is in 04-discord.md. clanka's `steer` takes a string, so every attachment on a steering message, images included, is saved in the working directory with its path in the text (see 03-sessions-and-turns.md and 04-discord.md).
- **OV-38** clanka's providers are the Codex login, Copilot, xAI, Claude through an installed Claude Code, and openai-compat, and it has no direct Anthropic API. clanka hands a device code to its `DeviceCodeHandler` service. chad's handler posts the code to the owner in Discord, in the thread that needed it, and chad keeps the tokens on the data volume (see 05-model-and-login.md).
- **OV-39** effect/chat runs Discord over the gateway through dfx and keeps no store of the events it has seen. With `layerGateway` an event that is refused, or cut off by a crash, is dropped and Discord does not send it again. chad uses `layerDispatchHook`, the at-least-once option, which resumes after a restart and replays a refused event, and it drops a second delivery by the request's primary key, `ChatEvent.dedupeKey`. The Discord gateway has no accept deadline, since the 2.5 second one belongs to Slack's webhook. A slow handler is still not safe. Under `layerDispatchHook` a handler that takes longer than about 41 seconds makes the shard reconnect, so the handler saves the message and returns (see 03-sessions-and-turns.md).
- **OV-40** effect/chat has no typing indicator and no operation that adds a reaction, does not deliver inbound edits or deletions, and sends files through `post` and not through `stream`. chad shows progress with the status message, sees no later edit or deletion of an owner's message, and sends every file as a post (see 04-discord.md).
- **OV-46** clanka retries a model call that fails, or that sends nothing for its `TurnTimeout` of 5 minutes, up to its `MaxRetries` of 20, and each retry arrives as an `ErrorRetry` part with no attempt number. A provider that accepts the connection and never answers would cost one call about 117 minutes. chad keeps both defaults, counts the retries itself for the status message, and ends a turn at the third timeout in a row on one model call, which is 15 minutes of silence (see 16-failures-logs-status.md).
- **OV-47** clanka prints a log call made on a script's fiber into that script's output, which the model reads, and it logs a failing script at Fatal. chad's one logger prints such a call into the script's output exactly as plain clanka does and sends a copy to chad's own log, with the copy of clanka's own lines capped at Info (see 16-failures-logs-status.md).
- **OV-48** effect cluster gives up on a reply it cannot save, without a log line, and delivers the request again only after a restart. Nothing in chad therefore learns a turn's end from cluster's reply alone (see 16-failures-logs-status.md).

## Glossary

The parts use these terms with the meanings below. Paths are relative to the data volume, which is `/data` in the image.

| Term | Meaning | Detail in |
| --- | --- | --- |
| Daemon | The long-running chad process started by `chad serve`. | 10-cli.md |
| Core | The code in the image that is not a plugin. It changes only with a new image. | 01-image-and-volume.md |
| Agent | With a capital, clanka's object for one conversation, which holds the tools, the history and the environment. In lower case, the model-driven worker that runs a turn for the owner. | 08-apply-and-swap.md |
| Owner | A user whose id is on the allowlist of a chat connection. Only an owner can start or steer a turn, and an id on the list is an owner whether or not it belongs to a bot. Plugins see owner ids as `<platform>:<id>`. | 03-sessions-and-turns.md, 10-cli.md |
| Thread | effect/chat's thread, which on Discord is a channel id. A direct message channel and a Discord thread are both threads. chad names a thread by the string `ChatThread.toString(thread)`, which is `discord:<channel id>` on Discord, and stores that string wherever it stores a thread. | 03-sessions-and-turns.md |
| Session | One conversation between an owner and the agent, which is a direct message channel or a Discord thread. A plain server channel has a session only for the turns a plugin starts there (see 06-plugin-api.md). It has one history, one working directory at `sessions/<session-id>/` and one executor, and a reset gives the thread a session with a fresh id. | 03-sessions-and-turns.md |
| Executor | The clanka service that runs a session's scripts and background processes. A session keeps its executor when its Agent is rebuilt. | 08-apply-and-swap.md |
| Turn | One run of the agent, from a prompt to an outcome of `Answered`, `Failed` or `Stopped`. An owner message, a plugin or a timer starts it. A `Failed` turn carries a reason from a closed set. | 03-sessions-and-turns.md, 16-failures-logs-status.md |
| Status message | The one Discord message chad posts when a turn starts and edits in place while the agent works. It shows the last few actions, carries the Stop button and is removed when the turn ends. | 04-discord.md |
| Notice | A message that chad itself writes, without the model. A line inside a turn's flow is in Discord's subtext, apart from the ones that 04-discord.md and 16-failures-logs-status.md name as normal messages. A notice outside a turn is a normal message, which carries the owner's mention in a server thread. It goes to the owner's most recently active direct message session, which chad records in `state/notice-thread`, and it is always logged. A notice about a condition has a key and is sent once when the condition begins. | 04-discord.md, 16-failures-logs-status.md |
| Plugin | A TypeScript file `plugins/<name>.ts`, or a directory `plugins/<name>/index.ts`, in the repo. Its default export is a Layer made with `Plugin.make` that adds tools, prompt chunks, hooks, background work and scheduled turns. | 06-plugin-api.md |
| Bundled plugin | A plugin that ships in the image. v1 has `cron` and `send-file`. A bundled plugin stays on in safe mode, and its source can be read at `repo/examples`. | 13-timers-and-cron.md, 14-self-edit-skill.md |
| Bundled skill | A skill that ships in the image. v1 has `self-edit`, `credentials` and `diagnose`. | 14-self-edit-skill.md, 15-credentials.md, 16-failures-logs-status.md |
| Chunk | The text a plugin contributes to the system prompt through `Plugin.prompt`. | 06-plugin-api.md, 08-apply-and-swap.md |
| Hook | A function a plugin registers with `Plugin.prompt`, `Plugin.beforeTurn`, `Plugin.afterTurn` or `Plugin.onSession`, which chad calls around a turn or on a session event. | 06-plugin-api.md |
| Repo | The git repository under `repo/` that holds the files chad can change about itself, which are `plugins/`, `skills/`, `mcp.json`, `chad.json` and `persona.md`. It is local and never pushed. It is not chad's source repo, `tim-smart/chad`, which the spec calls the chad repo. | 09-repo-and-recovery.md |
| Work | `repo/work/`, the checkout that the agent edits. An edit there that has not been applied is a draft. | 09-repo-and-recovery.md |
| Live | `repo/live`, a symlink to a tree exported under `repo/versions/` from the last applied commit. It is the applied version that the daemon runs and that a boot loads. | 07-plugin-loading.md, 09-repo-and-recovery.md |
| Apply | The command `chad apply -m <why>`. It checks the whole of `repo/work/`, commits it, moves `live` and makes the daemon load the change. | 10-cli.md, 08-apply-and-swap.md |
| Generation | A number in the daemon that tells a session whether what is loaded has changed since its Agent was built. A session that is behind rebuilds its Agent at the start of its next turn. | 08-apply-and-swap.md |
| Swap | The step in which new versions of plugins take over from the old ones. All new versions build, a gate closes, work in flight drains, the old scopes close and the new versions activate together. | 08-apply-and-swap.md |
| Safe mode | chad as the image ships it. Nothing from the repo is loaded except the `enabled` flags of bundled plugins. It is turned on by `CHAD_SAFE_MODE=1`, `/safe on` or `chad safe on`, and it starts by itself after three unclean boots. | 09-repo-and-recovery.md |
| Timer | A scheduled run of a plugin turn that the core holds for a plugin. A plugin creates one with `Turns.schedule`, and it lives as a delayed request to the `Timer` entity plus a row in the `timers` table. | 13-timers-and-cron.md |
| Local platform | effect/chat's `ChatTest` behind an RPC server that listens at `run/local.sock`, outside the daemon. The local dev adapter is the daemon's client to it. | 17-testing.md |
| Slice | A named group of rules that is built together. Every rule's row in a Provenance table names its slice, and a rule is pending while its slice is not delivered. | 19-build-order.md, 17-testing.md |
| Stage | One of the five build issues. A stage is a run of slices, and the five stages run one after another on one shared branch and one pull request. | 19-build-order.md |
| Docs | The user documentation of chad, which is the files under `docs/` in the chad repo apart from `docs/spec/`. The names of those files are the builder's. A rule in any part that says the docs state something is tested by finding the sentence in those files, in the slice the rule is tagged with. | 01-image-and-volume.md, 03-sessions-and-turns.md, 17-testing.md |

## Where the detail lives

| Part | Covers |
| --- | --- |
| 00-overview.md | This orientation. |
| 01-image-and-volume.md | The image, its user and environment variables, the volume's directory tree, the pinned packages, boot checks, the health probe, stopping, and the Compose and Kubernetes examples. |
| 02-storage.md | The SQLite database and its tables, the files kept outside it, backup and restore, pruning, and an unusable database. |
| 03-sessions-and-turns.md | Sessions, the `Session` entity, steering, `/new` and `/stop`, what is stored, passivation, a turn cut by a restart, and the order of hooks around a turn. |
| 04-discord.md | What a turn looks like in Discord, which is the status message, the answer, the buttons, sent files and the notices. |
| 05-model-and-login.md | The model setting, the providers, the login from a container with no terminal, the token store and the prompt cache. |
| 06-plugin-api.md | What a plugin exports, the services it gets, hooks and their budgets, background work, and starting or scheduling a turn. |
| 07-plugin-loading.md | The runtime, bundling and running a plugin, the type-check, the exported trees and the order of an apply. |
| 08-apply-and-swap.md | Generations, the Agent rebuild, the frozen system prompt, the swap path and what a running turn's tool calls do. |
| 09-repo-and-recovery.md | The git repo, drafts, `chad revert`, boot, safe mode and unclean boots. |
| 10-cli.md | Every `chad` command, the socket, the daemon lock, the queue, exit codes and the chat commands. |
| 11-settings.md | `chad.json`, a plugin's settings and turning a plugin off. |
| 12-skills-and-mcp.md | Skills, `mcp.json`, OAuth for HTTP MCP servers and the MCP layer's rebuild. |
| 13-timers-and-cron.md | The timer machinery in the core and the bundled cron plugin. |
| 14-self-edit-skill.md | The bundled `self-edit` skill, the core prompt's fixed sentences and the persona. |
| 15-credentials.md | `chad secret`, one-off codes, asking the owner for a value and the `credentials` skill. |
| 16-failures-logs-status.md | The log formats and `chad logs`, the reasons a turn fails and what the owner is told, retries and the usage limit, the usage columns of the `turns` table, the blocks of `chad status`, a full disk, the notices and the bundled `diagnose` skill. |
| 17-testing.md | How chad is tested, which is the six layers, the harness around `runDaemon`, the local platform, the rule ids on tests, what gates the pull request, and the nightly and live checks. |
| 18-asphodel-plugin.md | The asphodel plugin written against the plugin API. |
| 19-build-order.md | The order in which chad is built, which is five stages that each run a list of named slices on one shared branch and one pull request, when a stage is done, and the point from which Tim can run the image on his own server. |
| 20-for-tim.md | What Tim has to read and answer, which is the size of the build, the questions that were his with the answers given for him, every rule that states something he agreed in person and that a ticket he has not read then changed, his to-do list, and one paragraph for each ticket he has not read. It states no rule, so it has no rule ids, no Gaps section and no Provenance table. |

- **OV-50** Every rule in this spec has a stable id that is never renumbered or reused, and every test names the ids of the rules it covers in its title. 17-testing.md holds the rules that state this and their tests, so this sentence has no test of its own.
- **OV-54** The spec lives in the chad repo under `docs/spec/`, one file per part.
- **OV-55** An `AGENTS.md` at the root of the chad repo, `tim-smart/chad`, holds the builder's contract, which is what a builder has to follow on every run (see 19-build-order.md).
- **OV-56** chad is built in five stages, which are five build issues that run one after another and share one branch and one pull request. Each stage is a run of slices, and its rules are the rules whose Provenance row names one of those slices. A stage is done when its work is implemented and reviewed on the shared branch and no rule of its slices is pending without a recorded reason. Tim merges the one pull request after stage 5, and the first usable build is the end of stage 2 (see 19-build-order.md and 17-testing.md).

Every part that states rules ends with a Provenance table that has one row per rule. Most rules are bullets that start with the id in bold, and some are rows of a table whose first cell is the id in bold. A gap id, such as OV-G3, is not a rule and has no row. A withdrawn rule keeps its row, with its kind and the slice `-`. The columns are read as follows.

| Column | What it holds |
| --- | --- |
| Rule | The rule's id. |
| Source | The tickets and items the rule comes from. |
| Agreed by | Who agreed the rule as it now reads, which is Tim, Architect standing in for Tim, the charting of the map, or Jarvis, who assembled the spec. "Jarvis, delegated by Tim on 2026-11-15" marks an answer to a question that was open with Tim. Tim handed those questions to Jarvis in chat on that day and has not read the answers. |
| Support | Whether a prototype ran the rule, it was read from source, or nothing ran. |
| Changed by | The tickets Tim has not read that changed something he agreed in person. It is empty for every other rule, and 20-for-tim.md is built from it. |
| Kind | `rule` for chad's own behaviour, which a test can break. `fact` for what a dependency does, which a rule rests on. `definition` for a term, a reason or an overview sentence with nothing to test. |
| Slice | The build slice in which the rule's test first passes (see 19-build-order.md). A rule never has a slice that comes before a slice it rests on. A fact takes the slice of the first rule that rests on it, and a definition or a withdrawn rule has `-`. |

## Gaps

- **OV-G3** [builder] The version of dfx. It was read at `4625778` and at 1.1.1, and the image prototype's package used `^1.1.1`. TIM-532, TIM-553 and TIM-558.
- **OV-G4** [builder] The names and module layout of chad's internal services, beyond `runDaemon`, `Timings` and `Messages`. The image prototype's stand-in had `src/`, `plugins/`, `bin/` and `vendor/`. TIM-553 and TIM-558 items 13, 17 and 33.
- **OV-G7** [builder] What "a newer commit of that branch" means in OV-51, and how a test checks it without the network. The branch belongs to a pull request and can be rewritten, so a test cannot rely on the new commit being a descendant of `e1ae842`, and the spec gives the floor as seven characters while the manifest of OV-52 names the exact commit. The two readings are a descendant of the floor and a commit of the branch with a later commit date. Recommended: the later commit date. The first vendoring takes the floor itself, the manifest records the full hash and the commit date, and the test accepts the floor's hash or a manifest date after the floor's. TIM-559 ruling on OV-G2.
- **OV-G8** [builder] What the build does if effect/chat has shipped in a release of effect when the `repo` slice starts (OV-53). No ruling says which release is pinned, or what becomes of the rules that describe `vendor/` and its manifest, which are OV-18, OV-51 and OV-52 here, the vendoring rules of 01-image-and-volume.md and the vendor clause of the CI rules in 17-testing.md. Recommended: pin the newest release that carries effect/chat exactly, write the tests of those rules so that they apply when `vendor/` exists, and report the move on the parent build issue before going on, because every fact in the spec was read at the snapshot. TIM-559 ruling on OV-G2.
- **OV-G9** [builder] The names and layout of the files of the docs, which the glossary defines as the files under `docs/` in the chad repo apart from `docs/spec/`, and whether the README links them. Recommended: one file for each subject that a rule names, such as owners and running the image, linked from the README. TIM-558 item 40.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| OV-1 | Map "Destination" and "Agreed at charting"; image name TIM-541 item 6; the repo being public Tim, chat 2026-11-15 | charting; image name Architect (Tim has not read); Tim for the repo being public | not run; image built in TIM-553 around a stand-in daemon |  | `definition` | - |
| OV-2 | Map "Agreed at charting" and "Out of scope"; TIM-532 item 5 | charting | read |  | `rule` | `harness` |
| OV-3 | Map "Agreed at charting" and "Facts found at charting"; TIM-534 item 1 | charting; Tim | read |  | `definition` | - |
| OV-4 | Map "Agreed at charting" and "Out of scope"; TIM-534 item 2; settings file TIM-542 item 15 and TIM-548 item 1 | charting; Tim | not run |  | `definition` | - |
| OV-5 | Map "Agreed at charting"; TIM-558 items 20 to 22 | charting; Architect (Tim has not read) for the connection kind and the platform outside the daemon | not run; `ChatTest` keeping threads in memory read (TIM-558) | TIM-558 | `rule` | `cli` |
| OV-6 | Map "Agreed at charting"; TIM-532; TIM-540 item 6 | charting; Tim | run (TIM-543) |  | `rule` | `timers-cron` |
| OV-7 | Map "Agreed at charting"; TIM-530 | charting; Tim | run (TIM-538, TIM-552) |  | `rule` | `apply` |
| OV-8 | Map "Agreed at charting"; TIM-542 items 1, 11 and 22; the exception for what clanka's walk finds, and the refusal, TIM-559 ruling on MCP-G19, TIM-559 round 3 A1 and TIM-559 round 4 items 7 and 8 | charting; Tim; Architect (Tim has not read) for the exception | read; the walk read at clanka 0.28.0 (`src/AgentEnvironment.ts:62-117`); the refusal not run | TIM-559 | `rule` | `apply` |
| OV-9 | Map "Agreed at charting"; TIM-535 "Model" and "Providers" | charting; Tim | run (TIM-544) |  | `rule` | `models` |
| OV-10 | Map "Agreed at charting" and "Out of scope"; TIM-539; fixture TIM-558 item 49; the fixture files as the source TIM-559 ruling on ASP-G9 | charting; Tim; Architect (Tim has not read) for the fixture | run on a stand-in host (TIM-539); the fixture not run |  | `rule` | `asphodel` |
| OV-11 | TIM-537; TIM-534; TIM-548; TIM-535; TIM-536 items 7 and 8; TIM-546 amended by TIM-554; TIM-549; TIM-557 items 1, 11, 14, 24, 36 and 43 | Tim (TIM-537, TIM-534, TIM-535, TIM-536, TIM-554 items 1 and 2); Architect (Tim has not read) for TIM-548, TIM-546, TIM-549 and TIM-557 | not run | TIM-557 | `definition` | - |
| OV-12 | Map "Out of scope" | charting | not run |  | `definition` | - |
| OV-13 | Map "Out of scope" | charting | not run |  | `definition` | - |
| OV-14 | Map "Agreed at charting" and "Out of scope"; TIM-537 items 9 and 14; the pinned release carrying the argument TIM-559 ruling on OV-G1 | charting; Tim; Architect (Tim has not read) for the pinned release | read |  | `rule` | `repo` |
| OV-15 | Map "Out of scope" | charting | not run |  | `definition` | - |
| OV-16 | TIM-538 item 1; Map "Facts found at charting"; TIM-541 item 1 | Tim; image base Architect (Tim has not read) | run |  | `rule` | `repo` |
| OV-17 | TIM-559 ruling on OV-G1 | Architect (Tim has not read) | read |  | `rule` | `repo` |
| OV-18 | Map "Facts found at charting"; TIM-538 item 4; TIM-541 item 21; TIM-553 item 1; TIM-558 items 19 and 54; `vendor/` TIM-559 ruling on OV-G2 (main session, the pins) | charting; Tim (TIM-538); Architect (Tim has not read) for the vendoring and the tests | run; the tests of TIM-558 not run |  | `rule` | `loader` |
| OV-19 | TIM-542 items 1 and 2; TIM-541 item 6; Map "Facts found at charting" | Tim; Architect (Tim has not read) for the image | run (TIM-550) for the socket, read for the Discord gateway |  | `rule` | `cli` |
| OV-20 | TIM-542 item 3; TIM-550 item 8; TIM-553 item 5 | Tim; Architect (Tim has not read) for TIM-550 and TIM-553 | run |  | `rule` | `cli` |
| OV-21 | TIM-534 "How well each is supported"; TIM-538; TIM-550 item 3 | Tim; Architect (Tim has not read) for TIM-550 | read |  | `rule` | `timers-cron` |
| OV-22 | Map "Agreed at charting"; TIM-536 items 1 to 3; TIM-532 item 2; TIM-534 item 11; TIM-557 items 36 and 38 | charting; Tim; Architect (Tim has not read) for the notice record and the notice thread | run for `node:sqlite` and the session tables, read for the rest; the notice record and the notice thread not run |  | `rule` | `timers-cron` |
| OV-23 | TIM-542 item 4; TIM-550 item 1 | Tim | run (TIM-550) |  | `rule` | `cli` |
| OV-24 | Map "Agreed at charting"; TIM-532 items 1, 3 and 5, amended by TIM-558 item 40 | charting; Tim; Architect (Tim has not read) for the drop of chad's own messages | read; the drop not run | TIM-558 | `rule` | `turns` |
| OV-25 | Map "Agreed at charting" and "Facts found at charting"; TIM-532 items 2 and 4; TIM-540 item 12 | charting; Tim | run (TIM-543) |  | `rule` | `timers-cron` |
| OV-26 | TIM-531 items 1 and 3; TIM-532 item 9; TIM-535 "Login"; TIM-544 item 3; TIM-557 item 30 | Tim; Architect (Tim has not read) for the account of what chad posted | run (TIM-531, TIM-543, TIM-544); the account of what chad posted not run | TIM-557 | `rule` | `plugin-api` |
| OV-27 | Map "Agreed at charting"; TIM-533 item 1; TIM-547 item 7; TIM-549 item 24 | charting; Tim; Architect (Tim has not read) for the wrappers | read for the status message, run (TIM-552, TIM-555) for the wrappers | TIM-547 | `rule` | `skills-mcp` |
| OV-28 | Map "Agreed at charting", "Facts found at charting" and "Out of scope"; TIM-533 items 3 and 6 | charting; Tim | read |  | `rule` | `discord-ui` |
| OV-29 | TIM-532 item 11; TIM-536; TIM-530; TIM-543 "Facts the spec can rely on"; TIM-557 items 23, 24 and 29 | Tim; Architect (Tim has not read) for the reconcile at turn end and the token counts | run (TIM-543); the reconcile and the token counts not run | TIM-557 | `rule` | `plugin-api` |
| OV-30 | Map "Agreed at charting"; TIM-532 items 6, 7, 8, 12 and 13, amended by TIM-543 item 3 | charting; Tim | run (TIM-543) |  | `rule` | `plugin-api` |
| OV-31 | Map "Agreed at charting"; TIM-531 items 1 and 5; TIM-534 items 2 and 3, amended by TIM-538 item 6; TIM-550 item 11 | charting; Tim; Architect (Tim has not read) for TIM-550 | run (TIM-531, TIM-538, TIM-552) |  | `rule` | `apply` |
| OV-32 | Map "Agreed at charting" and "Facts found at charting"; TIM-531 item 1 | charting; Tim | run (TIM-531) |  | `fact` | `plugin-api` |
| OV-33 | Map "Agreed at charting" and "Facts found at charting"; TIM-531 items 2 and 3 | charting; Tim | run (TIM-531) |  | `fact` | `plugin-api` |
| OV-34 | Map "Facts found at charting"; TIM-531 item 7, amended by TIM-544 item 1; neither on `openai-compat` TIM-559 ruling on MOD-G18; TIM-559 cold read | Tim; Architect (Tim has not read) for `openai-compat` | run (TIM-544); `openai-compat` not run | TIM-559 | `fact` | `models` |
| OV-35 | Map "Facts found at charting"; TIM-531 item 6 | Tim | read; the rebuild run in TIM-555 |  | `fact` | `skills-mcp` |
| OV-36 | Map "Facts found at charting"; TIM-537 items 1 and 2; the walk that stays on TIM-559 round 3 A1 | Tim; Architect (Tim has not read) for the walk | read |  | `fact` | `skills-mcp` |
| OV-37 | Map "Facts found at charting"; TIM-532 item 15; TIM-533 item 7; attachments on a steering message TIM-559 ruling on SES-G6; TIM-559 cold read | Tim; Architect (Tim has not read) for attachments on a steering message | read | TIM-559 | `fact` | `turns` |
| OV-38 | Map "Agreed at charting" and "Facts found at charting"; TIM-535 "Login" and "Token store"; TIM-533 item 10 | charting; Tim | run (TIM-544) |  | `fact` | `models` |
| OV-39 | Map "Facts found at charting"; TIM-532 items 2 and 3; the second read TIM-559 round 2 R8; TIM-559 cold read | Tim | read at `0b51fb1` and again at `e1ae842` |  | `fact` | `wire` |
| OV-40 | Map "Facts found at charting"; TIM-533 items 1, 6 and 7; the second read TIM-559 round 2 R8 | Tim | read at `0b51fb1` and again at `e1ae842` |  | `fact` | `discord-ui` |
| OV-41 | TIM-557 items 1 and 4; TIM-559 cold read | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| OV-42 | TIM-558 items 13, 17 and 33; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| OV-43 | TIM-557 items 11, 12, 14 and 15 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| OV-44 | TIM-557 items 36 and 37; the notice as subtext that it changes is TIM-533 item 12 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| OV-45 | TIM-558 items 26, 27 and 36 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| OV-46 | TIM-557 items 17 and 18 | Architect (Tim has not read) | run (TIM-557) for clanka's retries and the 117 minutes; chad's count and the silence bound not run | TIM-557 | `fact` | `models` |
| OV-47 | TIM-557 items 7 and 9 | Architect (Tim has not read) | run (TIM-557) for the one logger with the script's output unchanged; the Info cap not run |  | `fact` | `failures` |
| OV-48 | TIM-557 item 34 | Architect (Tim has not read) | run (TIM-557) for cluster's behaviour; chad's handling not run |  | `fact` | `failures` |
| OV-49 | TIM-557 items 20, 25 and 28; TIM-558 item 50 | Architect (Tim has not read) | not run |  | `definition` | - |
| OV-50 | TIM-558 item 2; TIM-559 cold read | Architect (Tim has not read) | not run |  | `definition` | - |
| OV-51 | TIM-559 ruling on OV-G2 (main session, the pins); TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `repo` |
| OV-52 | TIM-559 ruling on OV-G2 (main session, the pins) | Architect (Tim has not read) | not run |  | `rule` | `repo` |
| OV-53 | TIM-559 ruling on OV-G2 (main session, the pins) | Architect (Tim has not read) | not run |  | `rule` | `repo` |
| OV-54 | TIM-559 ruling on where the spec lives (main session) | Architect (Tim has not read) | not run |  | `rule` | `repo` |
| OV-55 | TIM-559 round 2 R10 | Architect (Tim has not read) | not run |  | `rule` | `repo` |
| OV-56 | Tim, chat 2026-11-15 | Tim | not run |  | `definition` | - |
