# The asphodel plugin

This part covers the asphodel plugin, which is asphodel's Hermes plugin written against chad's plugin API. asphodel is the long-term memory daemon that Tim runs next to his assistant, and Hermes is the assistant that chad replaces. The part gives the plugin's settings, the part of the asphodel daemon's HTTP interface that the plugin uses, the rules for each hook and tool, the complete source, the fake daemon and the twelve scenarios that run it. It leans on 06-plugin-api.md for the API, 11-settings.md for `chad.json`, 03-sessions-and-turns.md for the order of hooks around a turn, 17-testing.md for the suite the plugin runs in, 16-failures-logs-status.md for the log, `chad status`, the reasons a turn fails and the notices, and 01-image-and-volume.md for how the asphodel daemon runs next to chad.

Two daemons appear below. "chad" always means chad's own daemon, and "the asphodel daemon" is always written out. A bank is the named set of memories on the asphodel daemon that the plugin reads and writes.

## What the plugin is and why it is the acceptance test

chad has no built-in memory (see 00-overview.md). asphodel's Hermes plugin is the Python code under `plugin/` in `tim-smart/asphodel`, read at commit `f8ccdea`. It uses every kind of extension point a plugin needs: start-up and shutdown, a system prompt block per session, context injected before a turn, the transcript after a turn with its author and time, a notice on a reset and on a compaction, tools, settings, stored state and background work. A plugin API that can express all of it is enough for v1, so the plugin written against the API is the API's acceptance test.

- **ASP-1** Every extension point of asphodel's Hermes plugin is expressed against the plugin API in 06-plugin-api.md. No kind of hook exists only for this plugin.
- **ASP-2** The asphodel plugin is a test fixture in chad's repository, exactly as this part prints it, together with the fake asphodel daemon printed below. The fixture file is the source and this part prints it (see 17-testing.md).
- **ASP-3** The fixture is type-checked against the built declaration files of the `chad` package and run through the real chad daemon with the twelve scenarios listed below (see 17-testing.md).
- **ASP-4** The fixture is not in the image, and nothing from asphodel's repository enters chad's CI.
- **ASP-109** CI compares the two code blocks of this part, which are the plugin source and the fake asphodel daemon, with the two fixture files, and fails when they differ (see 17-testing.md).
- **ASP-5** The plugin imports `Plugin` and `Session` from `chad` and nothing else from chad. Every other import is a module of `effect`.
- **ASP-6** The plugin builds one service of its own per load, and that one service serves every session. State that belongs to a session or a turn is keyed by the session id or the turn id.

The table shows where each part of the Hermes plugin lands.

| Hermes plugin | chad plugin |
| --- | --- |
| `initialize` | The body of the plugin's own service Layer. chad builds it once per load, not once per session. |
| `shutdown` | The plugin's scope closing, which runs a finalizer and interrupts the plugin's fiber. |
| `system_prompt_block` | `Plugin.prompt`. The plugin fetches the block once per session and keeps the text in its store. |
| `on_turn_start` | Nothing. The author is on `turn.origin.message.author`. |
| `prefetch` | `Plugin.beforeTurn`, which returns the text. |
| `sync_turn` | `Plugin.afterTurn`. |
| The spool on disk | `PluginContext.store` under `spool/`, replayed after a successful ingest and by a `Plugin.background` fiber once a minute. |
| `on_session_switch` | `Plugin.onSession` for `Reset` and `Compacted`. chad has no rewind. |
| The four tools | One `Toolkit` whose tools list `Session.CurrentSession` in their `dependencies`. |
| `forget_requested` | The `memory_forget` handler records the turn id in the store and the `afterTurn` hook reads it. |
| Config and `save_config` | Effect's `Config` over the plugin's settings in `chad.json`. |
| `post_setup`, the built-in memory check, the history backfill | Nothing. Settings are edited in `chad.json`, chad has no built-in memory, and importing history is out of scope. |

## Settings and the entry in `chad.json`

The plugin's name is `asphodel`, so its file is `plugins/asphodel.ts` and its entry in `chad.json` is `plugins.asphodel` (see 06-plugin-api.md and 11-settings.md).

- **ASP-7** The plugin reads its settings with Effect's `Config` from `plugins.asphodel.settings` in `chad.json`. It reads all of them while it loads and none at call time.
- **ASP-8** Every setting has a default or is optional, so the plugin loads with no entry in `chad.json`.

| Setting | Read as | Default | What it is |
| --- | --- | --- | --- |
| `url` | `Config.String` | `http://127.0.0.1:7720` | The asphodel daemon's address. The plugin adds `/v1` and the path. |
| `token` | `Config.Redacted`, optional | none | The bearer token for the asphodel daemon. |
| `bank` | `Config.String` | `chad` | The bank's name. |
| `ownerName` | `Config.String`, optional | none | The owner's name, sent with the bank. |
| `assistantName` | `Config.String` | `chad` | The assistant's name, sent with the bank. |
| `timezone` | `Config.String`, optional | chad's timezone | An IANA zone name that replaces chad's timezone for this plugin. |
| `ingest` | `Config.Boolean` | `true` | Whether turns are sent to the asphodel daemon after they end. |

- **ASP-9** `token` is a secret. In `chad.json` its value is written `${ASPHODEL_TOKEN}`, which chad expands from the secret store or from process env before the plugin reads it (see 11-settings.md). When a token is set the plugin sends it as a bearer token on every request, and when none is set it sends no `Authorization` header.
- **ASP-10** The plugin reaches the asphodel daemon through the `HttpClient` that chad supplies, over http or https. A `unix:` address is not supported, so the asphodel daemon listens on a TCP port and `url` points at it.
- **ASP-11** The owner ids that the plugin sends and checks come from `PluginContext.owners`, each as `<platform>:<id>`, and never from the plugin's settings.
- **ASP-12** The timezone that the plugin sends is the `timezone` setting when it is set, and otherwise the name of chad's `DateTime.CurrentTimeZone`.
- **ASP-13** A change to the owners or to chad's timezone reloads the plugin (see 06-plugin-api.md). Each load sends the bank again, so the new values reach the asphodel daemon.
- **ASP-14** With `ingest` set to `false` the plugin sends no turn to the asphodel daemon. The system prompt block, the prefetch, the tools and the clear on a reset or a compaction still run.
- **ASP-15** In the Compose example the plugin's settings are `"url": "http://asphodel:7720"` and `"token": "${ASPHODEL_TOKEN}"`. On Kubernetes the asphodel daemon is a sidecar in chad's pod and `url` is `http://127.0.0.1:7720` (see 01-image-and-volume.md).

The entry for the Compose example:

```json
{
  "plugins": {
    "asphodel": {
      "settings": {
        "url": "http://asphodel:7720",
        "token": "${ASPHODEL_TOKEN}"
      }
    }
  }
}
```

The settings the prototype's scenarios ran with, written as an entry. The owner was `discord:1234` and chad's timezone was `Pacific/Auckland`.

```json
{
  "plugins": {
    "asphodel": {
      "settings": {
        "url": "http://asphodel:7720",
        "ownerName": "Tim"
      }
    }
  }
}
```

## What chad supplies on each turn

Everything the plugin needs about a turn is already on the values chad passes to hooks and tool handlers.

| What the plugin needs | Where it reads it |
| --- | --- |
| The author's id, name and bot flag | `turn.origin.message.author`, as `id`, `name` and `isBot` |
| The platform | `turn.session.thread.platform` |
| The session id | `turn.session.id` |
| The turn id | `turn.id` |
| The time of the owner's message | `turn.origin.message.timestamp` |
| The owner's words | `turn.origin.message.text` |
| Messages that steered the turn | `TurnEnded.steers` |
| The answer | `TurnEnded.outcome.text` when the outcome is `Answered` |
| The previous reply | The answer of the session's previous turn, which the plugin keeps in memory |
| Whether the turn was cut by a restart | `turn.resumed` |
| The owner ids | `PluginContext.owners` |
| The owner's timezone | `DateTime.CurrentTimeZone` |

- **ASP-16** The plugin takes the owner's words from `turn.origin.message.text` and never from `turn.prompt`, because `turn.prompt` carries the lines chad adds for attachments and, for a resumed turn, the restart note.
- **ASP-17** The plugin does not use `TurnEnded.appended`, and it needs no call that reads a session's history. Every turn is sent when it ends, and on a reset the plugin only clears the old session on the asphodel daemon.
- **ASP-18** chad does not mask or redact what the `afterTurn` hook receives, so the plugin sends the owner's words and the answer to the asphodel daemon as they were written (see 06-plugin-api.md and 15-credentials.md).

## The asphodel daemon's HTTP interface

This is the interface as far as the plugin uses it. It was read from the asphodel daemon's source at `f8ccdea` (`crates/asphodel/src/serve/api.rs`), and the daemon itself was not run. The fake daemon further down answers exactly these routes. In the table `<bank>` is the `bank` setting and `<session>` is a chad session id, both URL-encoded.

| Request | Body or query | Response the plugin reads |
| --- | --- | --- |
| `GET /v1/health` | none | 200 with `{ "ready": boolean, "version": string }`. The fake answers `ready` true and version `0.4.0`. |
| `PUT /v1/banks/<bank>` | `{ "owner_name": string or null, "owner_platform_ids": [string], "assistant_name": string, "timezone": string }` | Any 2xx. The fake answers 200 with `{ "name": "chad" }`. |
| `GET /v1/banks/<bank>/system-prompt` | Query `session_id` | 200 with `{ "id": string, "text": string }` |
| `POST /v1/banks/<bank>/prefetch` | `{ "session_id", "query", "previous_query"?, "previous_reply"? }` | 200 with `{ "recall_id": string, "text": string, "injected": [string], "reranked": boolean }`. The plugin reads `recall_id` and `text`. |
| `POST /v1/banks/<bank>/turns` | The turn body shown under "The ingest after a turn" | Any 2xx. The fake answers 200 with `{ "outcome": "stored" }`, or `"tombstone"` when `forget_requested` is true. |
| `POST /v1/banks/<bank>/recall` | The `memory_recall` parameters plus `session_id` | 200 with `{ "text": string, "results": [{ "id": string }] }`. The plugin reads `text`. |
| `POST /v1/banks/<bank>/forget` | `{ "ids": [string], "session_id": string }` | 200 with `{ "forgotten": [string], "unknown": [string] }`, returned to the model as it is. |
| `POST /v1/banks/<bank>/keep` | `{ "ids": [string] }` | 200 with `{ "ids": [string] }`, returned to the model as it is. |
| `POST /v1/banks/<bank>/unkeep` | `{ "ids": [string] }` | 200 with `{ "ids": [string] }`, returned to the model as it is. |
| `POST /v1/banks/<bank>/sessions/<session>/clear` | none | 204 with no body |

- **ASP-19** Every request goes to `<url>/v1<path>` with `Accept: application/json`. A request body is JSON. A response body that is not JSON is read as no body.
- **ASP-20** A response outside 2xx is an error that carries the status and the `error` field of the JSON body as its message.
- **ASP-21** A fetch of the system prompt block with a session id is not a plain read. The asphodel daemon maps the session to that block and marks the block's memories as in context. It expects one fetch per session and another after a compaction.
- **ASP-22** The clear of a session removes that mapping and the session's in-context set on the asphodel daemon. Until the next fetch the session gets no agenda updates.
- **ASP-23** The asphodel daemon identifies a turn by its session id, its message time and a hash of its text. A turn sent twice with the same session id, message time and text, such as a resumed turn or a replayed one, is safe to send.
- **ASP-24** A turn sent with `forget_requested` set to true is stored as a tombstone with no text.
- **ASP-25** A turn whose author is not one of the bank's owner ids is stored as a new person's turn. This is why the owner ids in the bank have to be the ones chad holds.

## Loading and unloading

- **ASP-26** When the plugin loads it sends `GET /health` with a 2 second timeout and then the bank `PUT` with a 2 second timeout.
- **ASP-27** An asphodel daemon that is down, slow or not ready does not fail the plugin's load. The plugin logs a warning and loads with memory off until the asphodel daemon answers.
- **ASP-28** The load can log three warnings. A health answer that is not status 200 with `ready` true logs "asphodel: the daemon isn't ready yet (status <status>)". A health answer whose version does not start with major version 0 logs "asphodel: the daemon is <version>, this plugin was written for 0.x". A health probe or a bank `PUT` that fails logs "asphodel: memory is off until the daemon is back (<error tag>)". Each starts with the plugin's name, which is `asphodel`.
- **ASP-29** The plugin's warnings are log lines. `chad status` shows the plugin's count of warnings and errors since it loaded, with the latest line (see 16-failures-logs-status.md). chad sends no notice for them, and has no API through which a plugin notifies the owner.
- **ASP-110** chad sets the plugin's name around everything it runs for the plugin, which is the Layer build, the tool handlers, the hooks, the prompt render, the finalizers and the `Plugin.background` fibers it forks at activation (see 06-plugin-api.md for the rule and 16-failures-logs-status.md for the logger).
- **ASP-111** The three load warnings, the lines the spool replay fiber logs and "asphodel: unloaded" are logged outside any handler, and each still carries the `plugin` annotation `asphodel` in chad's log. The warnings among them count in `chad status`.
- **ASP-115** Each line the plugin writes through Effect's logger, inside a handler or outside one, is written to chad's log as the event `plugin.log` (see 16-failures-logs-status.md for the event names).
- **ASP-30** The bank `PUT` carries `owner_name` from the `ownerName` setting or null, `owner_platform_ids` from `PluginContext.owners`, `assistant_name` from the `assistantName` setting, and `timezone`.
- **ASP-31** Every request under `/banks/<bank>` first sends the bank `PUT`, with that request's own timeout, until one `PUT` has succeeded in this load. After that the `PUT` is not sent again until the next load.
- **ASP-32** The plugin contributes one fiber with `Plugin.background`. chad forks it into the plugin's scope when it activates this version of the plugin (see 06-plugin-api.md), and the fiber replays the spool at once and again one minute after each replay ends.
- **ASP-112** After a reload, the new version's replay fiber starts only after the previous version's scope has closed, so two versions of the plugin never replay the spool at the same time unless the old version's code ignores interruption, which chad logs (see 08-apply-and-swap.md).
- **ASP-33** Unloading the plugin closes its scope, which interrupts that fiber and logs "asphodel: unloaded". Nothing is drained.

## Requests, timeouts and the circuit breaker

The circuit breaker is the plugin's guard against an asphodel daemon that is down. After a few failures it stops sending requests for a while, so a turn does not wait on one timeout after another.

- **ASP-34** A request that times out, fails in transport or meets an open breaker fails as `DaemonUnavailable`. A response outside 2xx fails as `DaemonError` with its status.
- **ASP-35** After 3 requests in a row that time out or fail in transport, the breaker opens for 30 seconds. While it is open every request fails at once as `DaemonUnavailable` with the reason "circuit breaker open", and nothing is sent.
- **ASP-36** Any response from the asphodel daemon, whatever its status, sets the count of failures back to zero and closes the breaker.
- **ASP-37** The breaker's state is kept in memory, per load, and is shared by every session.

The constants in the source:

| Constant | Value | Meaning |
| --- | --- | --- |
| `DAEMON_MAJOR_VERSION` | `"0"` | The asphodel daemon major version the plugin was written for. |
| `BREAKER_FAILURES` | 3 | Failures in a row that open the breaker. |
| `BREAKER_COOLDOWN_MS` | 30,000 | How long the breaker stays open. |
| `RERANK_CONTEXT_CHARS` | 300 | How much of the previous reply is sent with a prefetch. |
| `MAX_IDS` | 50 | The most memory ids one tool call takes. |
| `SPOOL_MAX_TURNS` | 500 | The most turns the spool holds. |
| `SPOOL_MAX_AGE_MS` | 7 days | The oldest a spooled turn can be. |

## The system prompt block

The block is the text the asphodel daemon wants in the system prompt of a session, which is its agenda for the owner. chad calls a prompt chunk's render before every turn (see 06-plugin-api.md), and the asphodel daemon's fetch is not a plain read, so the plugin fetches once per session and answers the later renders from its store.

- **ASP-38** The render returns the text stored under `block/<session id>` when there is one, and sends nothing to the asphodel daemon.
- **ASP-39** With no stored text the render sends `GET /system-prompt?session_id=<session id>` with a 2 second timeout, and tries once more when the first try fails as `DaemonUnavailable`. It stores the answer's `text` under `block/<session id>` and returns it.
- **ASP-40** When the fetch fails the render logs "asphodel: no system prompt block (<error tag>)". In that case, and when the answer has no `text`, the render stores nothing and returns an empty string, and the next turn's render tries again.
- **ASP-41** A session that starts while the asphodel daemon is down gets its block on a later turn. The block then reaches the model in an update message, because the chunk's text changed while the system prompt stays frozen (see 08-apply-and-swap.md). When chad also owes the model an update about what it posted in the thread, both go in that one message (see 16-failures-logs-status.md).
- **ASP-42** The render's budget is 5 seconds, which the plugin passes as `timeout` in place of the 2 second default.
- **ASP-43** A render that runs past that budget, or fails on something the plugin does not catch such as its store, leaves the session with the block it last saw. chad does not treat it as the block being removed (see 06-plugin-api.md).
- **ASP-44** A restart of chad or a reload of the plugin does not fetch a second block for a session that already has one, because the text is in the store.

## The prefetch before a turn

The prefetch asks the asphodel daemon for memories that fit the owner's message. The text it returns reaches the model as its own user message ahead of the owner's, wrapped as `<plugin-context plugin="asphodel">`, and stays in the history until a compaction (see 06-plugin-api.md).

- **ASP-45** The `beforeTurn` hook does nothing for a turn that a plugin started, such as a cron run. Such a turn has no speaker.
- **ASP-46** The `beforeTurn` hook does nothing for a turn with `resumed: true`, on every start after the first. The first attempt already put its context in the history, and its recall id is still in the store.
- **ASP-47** The `beforeTurn` hook does nothing when the owner's message has no text.
- **ASP-48** Otherwise the hook sends `POST /prefetch` with a 5 second timeout. The body has `session_id` and `query`, which is the owner's message text. It also has `previous_query` when the plugin remembers a prefetch in this session, and `previous_reply` when the turn of that prefetch was answered.
- **ASP-49** `previous_reply` is the first 300 characters of that answer.
- **ASP-50** The answer's `recall_id` is stored under `recall/<turn id>`, and the hook returns the answer's `text` when it is not empty.
- **ASP-51** No prefetch runs for a message that steers a running turn, because chad runs `beforeTurn` only when a turn starts.
- **ASP-52** A prefetch that fails is not caught by the plugin. The hook fails, chad logs and skips it, and the turn runs without memories. The plugin's memory of the session's previous prefetch is left as it was.
- **ASP-53** The plugin keeps each session's last prefetch (the turn id, the query and later the reply) in memory, so a restart or a reload of the plugin forgets it and the next prefetch carries no `previous_query`.

## The ingest after a turn

The ingest sends a finished turn to the asphodel daemon, which builds memories from it.

- **ASP-54** The `afterTurn` hook does nothing for a turn that a plugin started. The `[SILENT]` rule applies only to such a turn, which ends as `Answered` with the text `[SILENT]`, and the hook skips it by its origin, so a `[SILENT]` answer is never ingested.
- **ASP-55** For a turn that started from a message, the hook reads the recall id under `recall/<turn id>` and removes the key, whatever the turn's outcome. It also reads the mark that `memory_forget` left under `forget/<turn id>` and removes that key.
- **ASP-56** A turn whose outcome is `Stopped` or `Failed` is not ingested, and the owner's words in it do not reach the asphodel daemon. The plugin reads only the outcome's tag, so this holds for every reason a `Failed` outcome carries (the set is in 16-failures-logs-status.md). That includes the reason `GaveUp`, which chad reports when it gives up on a resumed turn, and for which the hook still removes the turn's recall key.
- **ASP-57** For an answered turn the hook records the first 300 characters of the answer as the session's previous reply, when the session's last prefetch belongs to this turn.
- **ASP-58** For an answered turn, with `ingest` on, the hook sends `POST /turns` with a 10 second timeout and the body shown below.
- **ASP-107** A turn whose answer could not be posted to a thread that still exists ends as `Answered`, so it is ingested with its answer, which the owner did not see (see 16-failures-logs-status.md).
- **ASP-59** `user_text` is the owner's message text followed by the text of each message that steered the turn, joined by a blank line.
- **ASP-60** A resumed turn is ingested once, when the attempt that finishes ends, with the owner's original message, that message's time and the recall id of the first attempt.
- **ASP-61** `forget_requested` is true when `memory_forget` succeeded during the turn.
- **ASP-113** A reload of the plugin between a `memory_forget` call that succeeded and the turn's `afterTurn` does not lose the mark, so the turn is still ingested with `forget_requested` true.
- **ASP-114** `author.is_bot` in the body is the author's bot flag, so a turn from a bot on the owner list is sent with `is_bot` true.
- **ASP-62** After an ingest that succeeds the hook replays the spool.
- **ASP-63** An ingest that fails as `DaemonUnavailable`, or with a status of 500 or more, logs "asphodel: ingest failed (<error tag>); spooling the turn" and puts the turn in the spool.
- **ASP-64** An ingest that fails with any other status logs "asphodel: daemon answered <status>; dropping the turn", and the turn is not spooled.
- **ASP-65** `afterTurn` is not durable, so a turn that ends just as chad is killed is never ingested. The spool covers the asphodel daemon being down and does not cover chad being killed (see 06-plugin-api.md).

The body of `POST /turns`:

```json
{
  "session_id": "<turn.session.id>",
  "message_at": "<turn.origin.message.timestamp as an ISO 8601 string>",
  "timezone": "<the plugin's timezone>",
  "user_text": "<the owner's message text, then each steering message>",
  "assistant_text": "<outcome.text>",
  "author": { "id": "<author.id>", "name": "<author.name or null>", "is_bot": false },
  "platform": "<turn.session.thread.platform>",
  "recall_id": "<the stored recall id or null>",
  "forget_requested": false
}
```

One body from the scenario run:

```json
{"session_id":"session-1","message_at":"2026-11-14T09:00:00.000Z","timezone":"Pacific/Auckland","user_text":"book a table for two\n\nmake it three","assistant_text":"Booked for three.","author":{"id":"1234","name":"Tim","is_bot":false},"platform":"discord","recall_id":"recall-3","forget_requested":false}
```

## The spool

The spool holds the turns the asphodel daemon did not take, in the plugin's key-value store, until they can be sent.

- **ASP-66** A spooled turn is stored under `spool/<time>-<turn id>`, where the time is the current time in milliseconds padded to 15 digits, so the keys sort oldest first. The value is the JSON body of the ingest.
- **ASP-67** After each write the plugin removes spooled turns older than 7 days and every turn beyond the newest 500.
- **ASP-68** A turn that cannot be written to the spool logs "asphodel: could not spool a turn" and is lost. The hook does not fail.
- **ASP-69** A replay sends the spooled turns oldest first, each as `POST /turns` with a 10 second timeout. A turn that is accepted, or refused with a status under 500, is removed from the spool. A turn that fails as `DaemonUnavailable` or with a status of 500 or more stops the replay, and it and the turns after it stay.
- **ASP-70** The spool is replayed after each ingest that succeeds and by the plugin's fiber once a minute, so a spooled turn reaches the asphodel daemon without waiting for the owner's next message.
- **ASP-71** A replay that fails for another reason, such as the store, logs "asphodel: spool replay failed" and ends without failing the hook or the fiber.

## Reset and compaction

- **ASP-72** The `onSession` hook acts on `Reset`, for the session in `previous`, and on `Compacted`, for the session in `session`. It ignores any other event.
- **ASP-73** For that session the hook removes `block/<session id>`, forgets the session's last prefetch, and then sends `POST /sessions/<session id>/clear` with a 2 second timeout.
- **ASP-74** After a compaction the session keeps its id. Its next turn fetches a fresh block, which chad folds into the system prompt it renders again on that turn, and that turn's prefetch carries no `previous_query` (see 08-apply-and-swap.md).
- **ASP-75** After `/new` the old session is cleared on the asphodel daemon, and the new session fetches its own block under its own id on its first turn.
- **ASP-76** A clear that fails is not caught by the plugin. The hook fails after the block text is already removed, chad logs and skips it, and the asphodel daemon keeps the old in-context set for that session until its next compaction or reset.
- **ASP-77** A `Compacted` hook that is lost because chad was killed is never delivered. The plugin then keeps the old block text, and the asphodel daemon keeps a stale in-context set for that session until the next compaction or reset.

## The four tools

The plugin contributes one toolkit of four tools to every session's agent. Each tool lists `Session.CurrentSession` in its `dependencies` and reads the session and the running turn from it. Their descriptions and parameters are in the source.

- **ASP-78** `memory_recall` sends `POST /recall` with a 10 second timeout, carrying its parameters and `session_id`. It returns the answer's `text`, or "No memories recalled." when the text is missing or blank. It works in every turn, including a turn a plugin started.
- **ASP-79** `memory_recall` with a blank query fails with "memory_recall needs a non-empty query." and sends nothing.
- **ASP-80** `memory_forget`, `memory_keep` and `memory_unkeep` run only in an owner turn. A turn is an owner turn when it started from a message and `<platform>:<author id>` is in `PluginContext.owners`, whether or not the author is a bot. Otherwise the call fails with "Only the owner may call <tool>." and sends nothing.
- **ASP-81** The three owner-only tools are therefore refused in a turn a plugin started, and whenever `CurrentSession.turn` is `None`. clanka keeps a turn open while a background sub-agent runs, so no background task calls a tool outside a turn, and the handler still handles `None` because the type stays an `Option` (see 06-plugin-api.md).
- **ASP-82** A sub-agent inside a turn the owner started can call the three owner-only tools, because a handler cannot tell a sub-agent from the main agent. This is accepted (see 06-plugin-api.md).
- **ASP-83** The three owner-only tools take `ids`, a list of 1 to 50 memory ids. A list outside that range fails with "<tool> needs 1 to 50 memory ids." and sends nothing.
- **ASP-84** `memory_forget` sends `POST /forget` with the ids and `session_id`. `memory_keep` sends `POST /keep` and `memory_unkeep` sends `POST /unkeep`, each with the ids only. Each has a 10 second timeout and returns the asphodel daemon's JSON answer to the model.
- **ASP-85** When `memory_forget` succeeds, the handler marks the turn so its ingest carries `forget_requested`, and forgets the session's last prefetch so the forget request is not sent as the next `previous_query`. clanka has no tool-call rows to scan, so the handler does this itself. The mark is the key `forget/<turn id>` in the plugin's store.
- **ASP-86** A tool call that fails as `DaemonUnavailable` returns "Asphodel's daemon can't be reached right now; try again later." to the model. One that fails with a status returns "<tool>: Asphodel answered <status>: <message>". The turn carries on (see 06-plugin-api.md).

## Order and time budgets

chad decides when the hooks run, and those rules are in 06-plugin-api.md and 03-sessions-and-turns.md. This section states what they mean for this plugin. A budget is the time chad gives a hook before it logs and skips it. A timeout is the plugin's own limit on one request.

| Call | Request timeout | Hook and its budget |
| --- | --- | --- |
| `GET /health` at load | 2 seconds | None. It runs while the Layer builds. |
| Bank `PUT` at load | 2 seconds | None. It runs while the Layer builds. |
| Bank `PUT` ahead of another request | That request's timeout | That request's hook |
| `GET /system-prompt` | 2 seconds, tried twice | The prompt render, 5 seconds |
| `POST /prefetch` | 5 seconds | `beforeTurn`, 5 seconds |
| `POST /turns` for an ingest | 10 seconds | `afterTurn`, 30 seconds |
| `POST /turns` for each replayed turn | 10 seconds | `afterTurn`, 30 seconds, or none in the fiber |
| `POST /sessions/<session>/clear` | 2 seconds | `onSession`, 10 seconds |
| `POST /recall`, `/forget`, `/keep`, `/unkeep` | 10 seconds | None. It is a tool call. |

- **ASP-87** For a turn that starts from a message, the order is the block render, then the prefetch, then the agent's run with any tool calls, then the ingest after the turn ends. In the scenario run a session's first turn sent `GET /system-prompt`, `POST /prefetch` and `POST /turns` in that order.
- **ASP-88** The block render and the prefetch run on the reply path, so a slow asphodel daemon delays the answer by at most their budgets. The ingest and the clear run off the reply path and do not delay the answer to the turn they belong to. They hold back the start of a later turn in two cases, which are the turn after a compaction (ASP-90) and the first turn after `/new` (ASP-116).
- **ASP-89** The plugin's ingests and clears run one at a time, in the order chad queued them, so the ingest of a turn that compacted reaches the asphodel daemon before that session's clear.
- **ASP-90** After a turn that compacted, chad finishes that turn's ingest and the session's clear, inside their budgets, before the session's next turn starts. The order at the asphodel daemon is therefore the ingest, the clear, a fresh block fetch and then the next prefetch.
- **ASP-91** The turn that compacted is the turn whose `send` stream carried clanka's `HistoryReplaced` part, or the turn at whose end chad's history reconcile found a replace that the stream did not deliver. That can be a later turn than the one that started the summarizer, and it is the turn whose ingest runs ahead of the clear (see 03-sessions-and-turns.md and 16-failures-logs-status.md).
- **ASP-92** The wait after a compaction is at most the 30 second `afterTurn` budget and then the 10 second `onSession` budget when the plugin's requests hang. It happens only on the turn after a compaction, and it measured 39.97 seconds with one plugin whose calls hang and 272 ms with hooks that return (see 06-plugin-api.md).
- **ASP-116** After `/new`, the new session's first turn does not start until the hooks the plugin has queued for the old session have finished or run out of budget. Those hooks are the clear on `Reset` and, when `/new` stopped a turn, that turn's `afterTurn` ahead of it (see 03-sessions-and-turns.md for the wait, where it sits and its bounds). The plugin may rely on the clear of the old session having been sent, or its hook having been skipped, before the new session's first block fetch and prefetch. It does not depend on that order, because the clear names the old session id and the state the plugin keeps for a session or a turn is keyed by that session's id or that turn's id.
- **ASP-117** The wait of ASP-116 is bounded by the hook budgets, like the wait after a compaction. It is at most the 10 second `onSession` budget after a `/new` on an idle session. When `/new` stopped a turn, that turn's `afterTurn` runs ahead of the clear inside its own 30 second budget, and it sends nothing, because a stopped turn is not ingested.
- **ASP-93** On a graceful stop chad runs the plugin's queued ingests and clears, inside their budgets, before it closes the plugin's scope. The stop gives queued hooks until 50 seconds from SIGTERM, and chad logs the ones it drops at that point (see 01-image-and-volume.md). On a kill they are lost (see 06-plugin-api.md).
- **ASP-94** An ingest or a clear that is queued when the plugin is reloaded runs on the new version. The block text, the recall ids and the forget marks are in the store, so they survive the reload (see 08-apply-and-swap.md).
- **ASP-108** A queued ingest or clear that chad drops in a swap or a stop is recorded as a log line only, and the owner gets no notice of it (see 16-failures-logs-status.md).

The prototype also ran a compaction without the wait before the next turn. The next turn froze the old block into the system prompt it rendered after the compaction, the clear then wiped what the new prefetch had just injected, and a second block arrived a turn later.

## When the asphodel daemon is down or slow

Nothing in the plugin stops a turn. Each rule below is stated in full in the section for its hook and is repeated here as one picture of an outage.

- **ASP-95** With the asphodel daemon down, a turn runs without a block and without memories, its answer is posted as usual, and the turn is spooled when it ends.
- **ASP-96** In a new session's first turn with the asphodel daemon down, the block render's two tries and the prefetch make three failed requests. The breaker then opens, and the ingest is spooled without a fourth request.
- **ASP-97** When the asphodel daemon is back and the breaker's 30 seconds have passed, the session's next turn fetches its block, prefetches, ingests, and then delivers the spooled turns.
- **ASP-98** When the owner says nothing more after an outage, the plugin's fiber delivers the spooled turns within a minute of the asphodel daemon coming back, with no turn running.
- **ASP-99** chad never disables the plugin because its hooks fail. After 3 failures in a row of the same hook chad sends the owner one notice under the key `hook-failing:asphodel:<hook>`. It does not send it again while the failures go on, or when the failures begin again within 24 hours of that notice (see 06-plugin-api.md and 09-repo-and-recovery.md, and 16-failures-logs-status.md for the notice rule and its wording). With the asphodel daemon down the hooks that fail are the prefetch and the clear, because the block render and the ingest catch the failure themselves.

## What the plugin keeps

The plugin needs nothing beyond its key-value store (see 06-plugin-api.md and 02-storage.md).

| Where | Key or name | Value | Removed when |
| --- | --- | --- | --- |
| Store | `block/<session id>` | The block text the session was given | The session is reset or compacted |
| Store | `recall/<turn id>` | The recall id of the turn's prefetch | The turn's `afterTurn` runs |
| Store | `forget/<turn id>` | A mark that `memory_forget` succeeded in the turn | The turn's `afterTurn` runs |
| Store | `spool/<time>-<turn id>` | The ingest body of a turn that was not taken | A replay delivers it, or the caps remove it |
| Memory | The last prefetch of each session | The turn id, the query and the reply | The session is reset or compacted, `memory_forget` succeeds, or the plugin is unloaded |
| Memory | The breaker and whether the bank `PUT` has succeeded | Counters and a flag | The plugin is unloaded |

- **ASP-100** The plugin keeps four kinds of key in its store, `block/<session id>`, `recall/<turn id>`, `forget/<turn id>` and `spool/<time>-<turn id>`, and uses no other storage.
- **ASP-101** The plugin as printed prunes only the spool. A session that is never reset or compacted leaves its `block/` key behind, and a turn whose `afterTurn` never runs leaves its `recall/` key behind, and its `forget/` key when it has one. The store has no expiry (see 06-plugin-api.md).

## The plugin source

This is the fixture file, `plugins/asphodel.ts`, complete. It is the prototype's file with the lines marked `// adjusted: <ticket>` changed. The lines marked TIM-559 change code in three places: the mark that `memory_forget` leaves is kept in the store, the spool replay fiber is contributed with `Plugin.background`, and the owner check no longer tests the author's bot flag. Every other marked line is a comment, because the final API in 06-plugin-api.md has the same imports, service names and hook signatures the prototype was written against, and the settings mechanism in 11-settings.md answers the same `Config` reads. The prototype's file passed `tsc` against effect at `0b51fb1` and ran the scenarios on a stand-in host. The file below has not been compiled and its changed lines have not been run. The type-check in 17-testing.md compiles it against the built declaration files. Comments that start "Hermes:" name the part of the Python plugin a block replaces.

```ts
// A test fixture for chad's plugin API. asphodel's Hermes plugin (`plugin/` in // adjusted: TIM-558
// tim-smart/asphodel at f8ccdea) written against chad's plugin API. It is not
// the port, which belongs to asphodel's repo, and it is not in the image. It // adjusted: TIM-558
// shows where each Hermes extension point lands and what the API has to // adjusted: TIM-558
// supply. Comments that start "Hermes:" name the part of the Python plugin a // adjusted: TIM-558
// block replaces. // adjusted: TIM-558
import { Plugin, Session } from "chad"
import { Tool, Toolkit } from "effect/ai"
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"

/** The daemon could not be reached, timed out, or the breaker is open. */
class DaemonUnavailable extends Data.TaggedError("DaemonUnavailable")<{ readonly reason: string }> {}
/** The daemon answered with a status outside 2xx. */
class DaemonError extends Data.TaggedError("DaemonError")<{ readonly status: number; readonly message: string }> {}
type DaemonFailure = DaemonUnavailable | DaemonError

const DAEMON_MAJOR_VERSION = "0"
const BREAKER_FAILURES = 3
const BREAKER_COOLDOWN_MS = 30_000
const RERANK_CONTEXT_CHARS = 300
const MAX_IDS = 50
const SPOOL_MAX_TURNS = 500
const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// -- the plugin's own service ---------------------------------------------------
// Hermes builds one provider per session. chad builds this once per plugin
// load and it serves every session, so what Hermes kept on `self` is keyed by
// session id or turn id here.

class Asphodel extends Context.Service<Asphodel>()("asphodel/Asphodel", {
  make: Effect.gen(function*() {
    const { name, store, owners } = yield* Plugin.PluginContext

    // Hermes: get_config_schema, save_config and config.json. The values are // adjusted: TIM-548
    // this plugin's `settings` object in chad.json. The token is written // adjusted: TIM-548
    // `${ASPHODEL_TOKEN}` there and chad expands it before this read. // adjusted: TIM-548
    const config = yield* Config.all({
      url: Config.String("url").pipe(Config.withDefault("http://127.0.0.1:7720")),
      token: Config.option(Config.Redacted("token")),
      bank: Config.String("bank").pipe(Config.withDefault("chad")),
      ownerName: Config.option(Config.String("ownerName")),
      assistantName: Config.String("assistantName").pipe(Config.withDefault("chad")),
      timezone: Config.option(Config.String("timezone")),
      ingest: Config.Boolean("ingest").pipe(Config.withDefault(true))
    })
    // Hermes: hermes_time.get_timezone_name(), then the configured default.
    const timezone = Option.getOrElse(config.timezone, () => "")
      || DateTime.zoneToString(yield* DateTime.CurrentTimeZone)

    // Hermes: client.py and breaker.py. `unix:/path` URLs are not carried
    // over, because the host's HttpClient speaks http and https only.
    const http = yield* HttpClient.HttpClient
    let failures = 0
    let openedAt: number | undefined
    const request = (
      method: "GET" | "POST" | "PUT",
      path: string,
      options: { readonly body?: unknown; readonly query?: Record<string, string>; readonly timeout: Duration.Input }
    ): Effect.Effect<{ readonly status: number; readonly json: any }, DaemonUnavailable> =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        if (openedAt !== undefined && now - openedAt < BREAKER_COOLDOWN_MS) {
          return yield* new DaemonUnavailable({ reason: "circuit breaker open" })
        }
        let req = HttpClientRequest.make(method)(`${config.url}/v1${path}`).pipe(HttpClientRequest.acceptJson)
        if (options.query) req = HttpClientRequest.setUrlParams(req, options.query)
        if (options.body !== undefined) req = HttpClientRequest.bodyJsonUnsafe(req, options.body)
        if (Option.isSome(config.token)) req = HttpClientRequest.bearerToken(req, Redacted.value(config.token.value))
        return yield* http.execute(req).pipe(
          Effect.flatMap((response) =>
            response.json.pipe(
              Effect.catch(() => Effect.succeed(undefined)),
              Effect.map((json) => ({ status: response.status, json: json as any }))
            )
          ),
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () => Effect.fail(new DaemonUnavailable({ reason: "timed out" }))
          }),
          Effect.catchTag("HttpClientError", (error) => Effect.fail(new DaemonUnavailable({ reason: error.reason._tag }))),
          Effect.tap(() => Effect.sync(() => { failures = 0; openedAt = undefined })),
          Effect.tapError(() => Effect.sync(() => { if (++failures >= BREAKER_FAILURES) openedAt = now }))
        )
      })
    const ok = (
      method: "GET" | "POST" | "PUT",
      path: string,
      options: { readonly body?: unknown; readonly query?: Record<string, string>; readonly timeout: Duration.Input }
    ): Effect.Effect<any, DaemonFailure> =>
      Effect.flatMap(request(method, path, options), ({ status, json }) =>
        status >= 200 && status < 300
          ? Effect.succeed(json)
          : Effect.fail(new DaemonError({ status, message: String(json?.error ?? "") })))

    // Hermes: _ensure_bank. Every bank operation retries the PUT until one works.
    const bankPath = `/banks/${encodeURIComponent(config.bank)}`
    let bankReady = false
    const ensureBank = (timeout: Duration.Input): Effect.Effect<void, DaemonFailure> =>
      bankReady ? Effect.void : ok("PUT", bankPath, {
        timeout,
        body: {
          owner_name: Option.getOrNull(config.ownerName),
          owner_platform_ids: owners,
          assistant_name: config.assistantName,
          timezone
        }
      }).pipe(Effect.tap(() => Effect.sync(() => { bankReady = true })), Effect.asVoid)
    const bank = (
      method: "GET" | "POST",
      path: string,
      options: { readonly body?: unknown; readonly query?: Record<string, string>; readonly timeout: Duration.Input }
    ) => Effect.andThen(ensureBank(options.timeout), ok(method, bankPath + path, options))

    // Hermes: initialize. A health probe and the bank PUT. A daemon that is
    // down must not fail the load. Hermes shows these warnings to the user
    // through `warning_callback`. chad has no such channel, so they are logs.
    yield* request("GET", "/health", { timeout: "2 seconds" }).pipe(
      Effect.tap(({ status, json }) => {
        const version = typeof json?.version === "string" ? json.version : undefined
        if (status !== 200 || !json?.ready) return Effect.logWarning(`${name}: the daemon isn't ready yet (status ${status})`)
        if (version && version.split(".")[0] !== DAEMON_MAJOR_VERSION) {
          return Effect.logWarning(`${name}: the daemon is ${version}, this plugin was written for ${DAEMON_MAJOR_VERSION}.x`)
        }
        return Effect.void
      }),
      Effect.andThen(ensureBank("2 seconds")),
      Effect.catch((error) => Effect.logWarning(`${name}: memory is off until the daemon is back (${error._tag})`))
    )

    // Hermes: spool.py. One entry per turn the daemon did not take, in the
    // plugin's key-value store. The key sorts oldest first.
    const spool = KeyValueStore.prefix(store, "spool/")
    const spoolTurn = (turn: Session.Turn, body: unknown) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        yield* spool.set(`${String(now).padStart(15, "0")}-${turn.id}`, JSON.stringify(body))
        const keys = [...(yield* spool.keys)].sort()
        const stale = keys.filter((key, index) =>
          Number(key.slice(0, 15)) < now - SPOOL_MAX_AGE_MS || index < keys.length - SPOOL_MAX_TURNS)
        yield* Effect.forEach(stale, (key) => spool.remove(key), { discard: true })
      }).pipe(Effect.catch((error) => Effect.logWarning(`${name}: could not spool a turn`, error)))
    // A 4xx drops the entry. A 5xx or no answer stops the replay and keeps the rest.
    const replaySpool: Effect.Effect<void> = Effect.gen(function*() {
      for (const key of [...(yield* spool.keys)].sort()) {
        const body = yield* spool.get(key)
        if (body !== undefined) {
          const sent = yield* bank("POST", "/turns", { body: JSON.parse(body), timeout: "10 seconds" }).pipe(Effect.result)
          if (sent._tag === "Failure" && (sent.failure._tag === "DaemonUnavailable" || sent.failure.status >= 500)) return
        }
        yield* spool.remove(key)
      }
    }).pipe(Effect.catch((error) => Effect.logWarning(`${name}: spool replay failed`, error)))
    // Hermes: shutdown. Nothing to drain. The scope closes the fiber.
    yield* Effect.addFinalizer(() => Effect.logInfo(`${name}: unloaded`))

    // Hermes: is_owner. With a turn id to hand, "a cron run is never the
    // owner" is "the turn did not start from a message". A sub-agent cannot
    // be told apart from the main agent, which is accepted. // adjusted: TIM-539
    // An id on the owner list is an owner whether or not it is a bot. // adjusted: TIM-559
    const isOwnerTurn = (turn: Option.Option<Session.Turn>): boolean => {
      if (Option.isNone(turn) || turn.value.origin._tag !== "Message") return false
      const { author } = turn.value.origin.message
      return owners.includes(`${turn.value.session.thread.platform}:${author.id}`) // adjusted: TIM-559
    }

    return {
      name,
      config,
      timezone,
      bank,
      spoolTurn,
      replaySpool,
      isOwnerTurn,
      /**
       * The system prompt block each session was given, by session id. Kept in
       * the store so a restart or a reload of the plugin does not fetch a
       * second block for a session that already has one.
       */
      blocks: KeyValueStore.prefix(store, "block/"),
      /** The last prefetch of each session, for previous_query and previous_reply. */
      last: new Map<string, { readonly turnId: string; readonly query: string; reply?: string }>(),
      /**
       * Turns in which memory_forget succeeded, by turn id. Hermes: the tool-call
       * scan in turns.py. Kept in the store so a reload of the plugin between
       * the tool call and afterTurn does not lose the mark.
       */ // adjusted: TIM-559
      forgets: KeyValueStore.prefix(store, "forget/"), // adjusted: TIM-559
      /** recall ids waiting for their turn to end, by turn id. Kept in the store so a resumed turn finds its own. */
      recalls: KeyValueStore.prefix(store, "recall/")
    }
  })
}) {
  static readonly layer = Layer.effect(this, this.make)
}

// -- the four tools (Hermes: tools.py and handle_tool_call) ---------------------

const Ids = Schema.Struct({ ids: Schema.Array(Schema.String) })
const ownerOnlyTool = <const Name extends string>(name: Name, description: string) =>
  Tool.make(name, {
    description: `${description} Only the owner may call it. Get ids from memory_recall; injected memories carry no ids.`,
    parameters: Ids,
    success: Schema.Json,
    failure: Schema.String,
    dependencies: [Session.CurrentSession]
  })

const Memory = Toolkit.make(
  Tool.make("memory_recall", {
    description: "Search Asphodel's long-term memory for what the user has said or done. "
      + "Use it for anything from an earlier conversation, and with phase 'upcoming' for what is coming up "
      + "after the agenda in the system prompt was built. Results join the session's context.",
    parameters: Schema.Struct({
      query: Schema.String,
      from: Schema.optionalKey(Schema.String),
      to: Schema.optionalKey(Schema.String),
      on: Schema.optionalKey(Schema.Literals(["happened", "said"])),
      phase: Schema.optionalKey(Schema.Literals(["upcoming", "past", "current", "any"])),
      kinds: Schema.optionalKey(Schema.Array(Schema.Literals(["fact", "event", "state", "task", "recurring"]))),
      entity: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Int)
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [Session.CurrentSession]
  }),
  ownerOnlyTool("memory_forget", "Irreversibly erase memories and every version of them. Only when the owner explicitly asks."),
  ownerOnlyTool("memory_keep", "Mark memories to keep so they never fade."),
  ownerOnlyTool("memory_unkeep", "Undo memory_keep.")
)

// Hermes: tool_error. The model sees the string as the tool's failure.
const toolError = (tool: string) => (error: DaemonFailure) =>
  error._tag === "DaemonUnavailable"
    ? "Asphodel's daemon can't be reached right now; try again later."
    : `${tool}: Asphodel answered ${error.status}: ${error.message}`

const MemoryHandlers = Memory.toLayer(Effect.gen(function*() {
  const asphodel = yield* Asphodel

  const ownerOnly = (tool: "memory_forget" | "memory_keep" | "memory_unkeep") =>
  ({ ids }: { readonly ids: ReadonlyArray<string> }) =>
    Effect.gen(function*() {
      const current = yield* Session.CurrentSession
      const turn = yield* current.turn
      if (!asphodel.isOwnerTurn(turn)) return yield* Effect.fail(`Only the owner may call ${tool}.`)
      if (ids.length < 1 || ids.length > MAX_IDS) return yield* Effect.fail(`${tool} needs 1 to ${MAX_IDS} memory ids.`)
      const body = tool === "memory_forget" ? { ids, session_id: current.session.id } : { ids }
      const result = yield* asphodel.bank("POST", `/${tool.slice("memory_".length)}`, { body, timeout: "10 seconds" }).pipe(
        Effect.mapError(toolError(tool))
      )
      if (tool === "memory_forget" && Option.isSome(turn)) {
        // Hermes finds this by scanning the transcript for the tool call.
        // clanka has no tool-call rows, so the handler records it.
        yield* Effect.orDie(asphodel.forgets.set(turn.value.id, "1")) // adjusted: TIM-559
        // The forget request isn't sent again as the next previous_query.
        asphodel.last.delete(current.session.id)
      }
      return result as Schema.Json
    })

  return Memory.of({
    memory_recall: (request) =>
      Effect.gen(function*() {
        const { session } = yield* Session.CurrentSession
        if (!request.query.trim()) return yield* Effect.fail("memory_recall needs a non-empty query.")
        const result = yield* asphodel.bank("POST", "/recall", {
          body: { ...request, session_id: session.id },
          timeout: "10 seconds"
        }).pipe(Effect.mapError(toolError("memory_recall")))
        return typeof result?.text === "string" && result.text.trim() ? result.text as string : "No memories recalled."
      }),
    memory_forget: ownerOnly("memory_forget"),
    memory_keep: ownerOnly("memory_keep"),
    memory_unkeep: ownerOnly("memory_unkeep")
  })
}))

const MemoryTools = Plugin.toolkit(Memory).pipe(Layer.provide(MemoryHandlers))

// -- the hooks ------------------------------------------------------------------

// Hermes: system_prompt_block, a 2s budget and one retry.
//
// chad renders a chunk before every turn. The daemon's fetch is not a plain
// read: with a session id it maps the session to the block and marks the
// block's memories as in context. So the plugin fetches once per session and
// answers from its store until the session is compacted or reset. Hermes
// needed `_pending_block_id` because it could fetch before it knew the
// session id. chad passes the session, so that is gone.
//
// When the fetch fails the chunk is empty and nothing is stored, so the next
// turn tries again and the block arrives as an update message. In Hermes a
// session that starts while the daemon is down never gets its block.
const PromptChunk = Plugin.prompt(
  (session) =>
    Effect.gen(function*() {
      const asphodel = yield* Asphodel
      const known = yield* asphodel.blocks.get(session.id)
      if (known !== undefined) return known
      const block = yield* asphodel.bank("GET", "/system-prompt", {
        query: { session_id: session.id },
        timeout: "2 seconds"
      }).pipe(
        Effect.retry({ times: 1, while: (error) => error._tag === "DaemonUnavailable" }),
        Effect.catch((error) => Effect.as(Effect.logWarning(`${asphodel.name}: no system prompt block (${error._tag})`), undefined))
      )
      if (typeof block?.text !== "string") return ""
      yield* asphodel.blocks.set(session.id, block.text)
      return block.text as string
    }),
  { timeout: "5 seconds" }
)

// Hermes: on_turn_start and prefetch, a 5s budget.
const Prefetch = Plugin.beforeTurn((turn) =>
  Effect.gen(function*() {
    const asphodel = yield* Asphodel
    // A cron turn has no speaker and nothing to recall for.
    if (turn.origin._tag !== "Message") return
    // The first attempt of a resumed turn already put its context in the
    // history, and its recall id is still in the store.
    if (turn.resumed) return
    // `turn.prompt` is what chad sends the model. The owner's words are here.
    const query = turn.origin.message.text
    if (!query.trim()) return
    const previous = asphodel.last.get(turn.session.id)
    const result = yield* asphodel.bank("POST", "/prefetch", {
      timeout: "5 seconds",
      body: {
        session_id: turn.session.id,
        query,
        ...(previous ? { previous_query: previous.query } : {}),
        ...(previous?.reply ? { previous_reply: previous.reply } : {})
      }
    })
    asphodel.last.set(turn.session.id, { turnId: turn.id, query })
    if (typeof result?.recall_id === "string") yield* asphodel.recalls.set(turn.id, result.recall_id)
    return typeof result?.text === "string" && result.text ? result.text as string : undefined
  })
)

// Hermes: sync_turn. Hermes matches a sync to its prefetch by comparing the
// user text, and guards the reply with a set of digests, because it has no
// turn id. chad's `turn.id` replaces both.
const SyncTurn = Plugin.afterTurn(({ turn, steers, outcome }) =>
  Effect.gen(function*() {
    const asphodel = yield* Asphodel
    // Hermes: agent_context == "primary" and human_turn(). A turn a plugin
    // started is not a conversation with the owner.
    if (turn.origin._tag !== "Message") return
    const { message } = turn.origin

    // The recall id is echoed once, whatever happens to the turn.
    const recallId = yield* asphodel.recalls.get(turn.id)
    yield* asphodel.recalls.remove(turn.id)
    const forgetRequested = (yield* asphodel.forgets.get(turn.id)) !== undefined // adjusted: TIM-559
    yield* asphodel.forgets.remove(turn.id) // adjusted: TIM-559

    // Parity with Hermes: a turn that was stopped or failed is not ingested.
    if (outcome._tag !== "Answered") return
    const last = asphodel.last.get(turn.session.id)
    if (last?.turnId === turn.id) last.reply = outcome.text.slice(0, RERANK_CONTEXT_CHARS)
    if (!asphodel.config.ingest) return

    const body = {
      session_id: turn.session.id,
      // The owner's message time, also for a resumed turn. The daemon's
      // idempotency key is session, time and a hash of the text.
      message_at: DateTime.formatIso(message.timestamp),
      timezone: asphodel.timezone,
      // Messages that steered the turn are the owner's words too.
      user_text: [message.text, ...steers.map((steer) => steer.text)].join("\n\n"),
      assistant_text: outcome.text,
      author: { id: message.author.id, name: message.author.name ?? null, is_bot: message.author.isBot },
      platform: turn.session.thread.platform,
      recall_id: recallId ?? null,
      forget_requested: forgetRequested
    }
    const sent = yield* asphodel.bank("POST", "/turns", { body, timeout: "10 seconds" }).pipe(Effect.result)
    if (sent._tag === "Success") return yield* asphodel.replaySpool
    if (sent.failure._tag === "DaemonUnavailable" || sent.failure.status >= 500) {
      yield* Effect.logWarning(`${asphodel.name}: ingest failed (${sent.failure._tag}); spooling the turn`)
      return yield* asphodel.spoolTurn(turn, body)
    }
    yield* Effect.logWarning(`${asphodel.name}: daemon answered ${sent.failure.status}; dropping the turn`)
  })
)

// Hermes: on_session_switch for reset and compression. chad has no rewind.
// Neither case needs to read the old session's history: every turn was sent
// to the daemon when it ended.
const SessionSwitch = Plugin.onSession((event) =>
  Effect.gen(function*() {
    const asphodel = yield* Asphodel
    const ended = event._tag === "Reset" ? event.previous : event._tag === "Compacted" ? event.session : undefined
    if (!ended) return
    yield* asphodel.blocks.remove(ended.id)
    asphodel.last.delete(ended.id)
    yield* asphodel.bank("POST", `/sessions/${encodeURIComponent(ended.id)}/clear`, { timeout: "2 seconds" })
  })
)

// Hermes replays the spool only after an ingest succeeds. This fiber also // adjusted: TIM-559
// does it on a timer. chad forks it when it activates this version, so it // adjusted: TIM-559
// never runs next to the previous version's fiber, and unloading the plugin // adjusted: TIM-559
// interrupts it. // adjusted: TIM-559
const SpoolReplay = Plugin.background( // adjusted: TIM-559
  Effect.gen(function*() { // adjusted: TIM-559
    const asphodel = yield* Asphodel // adjusted: TIM-559
    yield* asphodel.replaySpool.pipe(Effect.repeat(Schedule.spaced("1 minute"))) // adjusted: TIM-559
  }) // adjusted: TIM-559
) // adjusted: TIM-559

export default Layer.mergeAll(MemoryTools, PromptChunk, Prefetch, SyncTurn, SessionSwitch, SpoolReplay).pipe( // adjusted: TIM-559
  Layer.provide(Asphodel.layer),
  Plugin.make
)
```

## The fake asphodel daemon

The fake is an `HttpClient` that plays the asphodel daemon in memory and records every request. Setting `state.up` to false makes every request fail in transport as a refused connection, and `take()` returns the requests recorded since the last call. Block ids and recall ids count up from 1, which is how a scenario tells one fetch from the next.

```ts
// Test support for the asphodel fixture. An HttpClient that plays the asphodel // adjusted: TIM-558
// daemon in memory and records every request. The response shapes follow
// crates/asphodel/src/serve/api.rs at f8ccdea. Nothing here is the daemon.
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"

export interface Request {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  readonly body: any
}

export const make = () => {
  const state = { up: true, requests: [] as Array<Request>, refused: 0, blocks: 0, recalls: 0 }

  const answer = (request: Request): [status: number, body: unknown] => {
    const route = `${request.method} ${request.path.replace(/^\/v1/, "").replace(/^\/banks\/[^/]+/, "/bank")}`
    if (route === "GET /health") return [200, { ready: true, version: "0.4.0" }]
    if (route === "PUT /bank") return [200, { name: "chad" }]
    if (route === "GET /bank/system-prompt") {
      const id = `block-${++state.blocks}`
      return [200, { id, text: `[asphodel agenda, ${id}]` }]
    }
    if (route === "POST /bank/prefetch") {
      const id = `recall-${++state.recalls}`
      return [200, { recall_id: id, text: `[memories for "${request.body.query}", ${id}]`, injected: ["m1"], reranked: true }]
    }
    if (route === "POST /bank/turns") return [200, { outcome: request.body.forget_requested ? "tombstone" : "stored" }]
    if (route === "POST /bank/recall") return [200, { text: "m7: Tim's dentist is Dr. Lee", results: [{ id: "m7" }] }]
    if (route === "POST /bank/forget") return [200, { forgotten: request.body.ids, unknown: [] }]
    if (route === "POST /bank/keep" || route === "POST /bank/unkeep") return [200, { ids: request.body.ids }]
    if (/^POST \/bank\/sessions\/[^/]+\/clear$/.test(route)) return [204, undefined]
    return [404, { error: `no route ${route}` }]
  }

  const client = HttpClient.make((request, url) => {
    const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
    const seen: Request = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body }
    if (!state.up) {
      state.refused++
      console.log(`  daemon  ${seen.method} ${seen.path} -> connection refused`)
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" })
        })
      )
    }
    state.requests.push(seen)
    const [status, json] = answer(seen)
    const query = Object.keys(seen.query).length ? `?${new URLSearchParams(seen.query)}` : ""
    console.log(`  daemon  ${seen.method} ${seen.path}${query} ${body === undefined ? "" : JSON.stringify(body)} -> ${status}`)
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(json === undefined ? null : JSON.stringify(json), { status }))
    )
  })

  return {
    client,
    state,
    /** The requests since the last call, as "METHOD route". */
    take: (): Array<Request> => state.requests.splice(0)
  }
}
```

## The twelve scenarios

The scenarios ran on a stand-in host with a test clock, the owner `discord:1234`, the timezone `Pacific/Auckland` and the second entry shown under "Settings and the entry in `chad.json`". They held 30 checks, and all passed. In chad's suite each is run through the real chad daemon (see 17-testing.md). Scenario 7 has two variants. Scenario 8 was also run a second time with the next turn starting before the hooks had run, to show what happens without the wait after a compaction. chad never does that, so that variant and its 3 checks have no counterpart.

| Number | Scenario | What it checks |
| --- | --- | --- |
| 1 | The plugin loads | The health probe is sent, then the bank `PUT`. The bank gets the owner ids and the timezone from chad and not from the plugin's settings. |
| 2 | Two owner turns in a direct message | The first turn sends one block fetch with the session id, one prefetch and one ingest. The ingest echoes the prefetch's recall id and names the author and the platform. The second turn does not fetch the block again, and its prefetch carries the previous query and reply. |
| 3 | A message steers the turn | No prefetch runs for the steering message. The ingest's `user_text` holds both messages, joined by a blank line. |
| 4 | A cron turn | `memory_recall` works and `memory_forget` is refused with "Only the owner". No prefetch and no ingest are sent. |
| 5 | The owner asks to forget | The forget request carries the session id. The turn is ingested with `forget_requested` true. The next turn's prefetch does not send the forget request as `previous_query`. |
| 6 | A background task calls a tool after its turn ended | `memory_keep` is refused with "Only the owner" and nothing is sent, because there is no turn. |
| 7 | The asphodel daemon is down for a turn | The turn runs without memories and is spooled as one key. When the asphodel daemon is back, the next turn's ingest is followed by the spooled turn, and the spool is empty. In the second variant the owner says nothing more, and a minute later the spooled turn is delivered with no turn running. |
| 8 | A compaction, with the `Compacted` hook finished before the next turn | The requests arrive in the order prefetch, ingest, clear, a fresh block fetch, prefetch. |
| 9 | `/new` | The old session is cleared and nothing else is sent. The new session's first turn fetches its own block with the new session id. |
| 10 | The process restarts in the middle of a turn | The resumed turn does not prefetch again. It is ingested once, with the owner's message and the first attempt's recall id. The restart does not fetch a second block, because the first is in the store. |
| 11 | A session starts while the asphodel daemon is down | After three refused connections the breaker stops asking and the turn is spooled. 31 seconds later, with the asphodel daemon back, the next turn fetches the block for that session, and the spooled turn is delivered after that turn's ingest. |
| 12 | The plugin unloads | The scope closes and the plugin logs "asphodel: unloaded". It has no checks. |

- **ASP-102** The fixture's scenarios are the twelve in the table above, with both variants of scenario 7. Each scenario of the prototype's final pass is mapped to a test or to a reason there is none, in the table that 17-testing.md describes.
- **ASP-103** The scenarios run against the fake asphodel daemon. The fake carries over from the prototype because it stands in for something outside chad. The stand-in host does not carry over.

## Out of scope

- **ASP-104** Porting asphodel's plugin for real is follow-up work in asphodel's repository and is not part of chad v1. The file printed here is the acceptance test and not the port.
- **ASP-105** The asphodel daemon is not part of the chad image. It runs as its own container next to chad (see 01-image-and-volume.md), and its volume is not in `chad backup` (see 02-storage.md).
- **ASP-106** The plugin has no setup step, no check for a built-in memory and no import of earlier history.

These notes are for whoever ports the plugin. They are not rules for chad.

- A session that is never reset leaves its `block/` key behind, so the port needs a prune.
- `unix:` daemon addresses are not carried over.
- Hermes shows the plugin's start-up warnings to the user. In chad they are log lines that `chad status` counts.
- The spool is replayed on a one minute timer as well as after a successful ingest, and a session that starts while the asphodel daemon is down gets its block on a later turn. Hermes does neither.

## Gaps

- **ASP-G4** [builder] Scenario 6 needs a tool call with no turn running. clanka keeps a turn open while a background sub-agent runs, so it is not known that the real chad daemon can produce one. TIM-552 item 6 and TIM-539 item 1 came closest.
- **ASP-G5** [builder] Which layer of the suite runs scenario 10. The fixture's scenarios are placed in the layer that runs chad in one process, and a turn cut by a restart is tested in the layer that kills and restarts a child process. TIM-558 items 10 and 49.
- **ASP-G6** [builder] How scenarios 7 and 11 pass the one minute between replays and the breaker's 30 seconds. The prototype used a test clock. chad's scenario layers run on live time, and the plugin's constants are in the fixture file and not in chad's `Timings` service. TIM-558 items 17 and 28.
- **ASP-G7** [builder] How the fake asphodel daemon is attached to the real chad daemon. The fake is an in-memory `HttpClient`, and the daemon's test entry takes one `HttpClient` that also has to reach the fake model server. TIM-558 items 13, 14 and 49.
- **ASP-G8** [builder] Where the fixture file and the fake sit in chad's repository, and how a scenario puts the file into the test volume's repo as `plugins/asphodel.ts`. TIM-558 item 49.
- **ASP-G13** [builder] What `memory_forget` does when the asphodel daemon has forgotten the memories and the write of the mark under `forget/<turn id>` then fails. The source lets that write end the call as a defect, which fails only that call (see 06-plugin-api.md), and no ticket decides it. TIM-559 ruling on ASP-G1 came closest.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| ASP-1 | Map (Agreed at charting), TIM-539 resolution | charting for the acceptance test, Tim for the result | run |  | `rule` | `asphodel` |
| ASP-2 | TIM-558 item 49 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| ASP-3 | TIM-558 item 49 | Architect (Tim has not read) | not run |  | `rule` | `asphodel` |
| ASP-4 | TIM-558 item 49 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| ASP-5 | TIM-539 prototype, TIM-553 item 3 | Tim for the prototype, Architect (Tim has not read) for the package exports | run |  | `rule` | `plugin-api` |
| ASP-6 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-7 | TIM-539 prototype, TIM-548 item 3 | Tim for Config, Architect (Tim has not read) for the file | run |  | `rule` | `settings` |
| ASP-8 | TIM-539 prototype, TIM-548 round 1 facts | Tim for the prototype, Architect (Tim has not read) for the file | run |  | `rule` | `plugin-api` |
| ASP-9 | TIM-539 prototype, TIM-541 item 23, TIM-548 item 5 | Tim for the prototype, Architect (Tim has not read) for the entry and the expansion | run for the bearer token, not run for the expansion |  | `rule` | `settings` |
| ASP-10 | TIM-539 resolution (for the port), TIM-541 | Tim | run |  | `rule` | `plugin-api` |
| ASP-11 | TIM-539 item 2 | Tim | run |  | `rule` | `plugin-api` |
| ASP-12 | TIM-539 item 3, TIM-539 prototype | Tim | run |  | `rule` | `plugin-api` |
| ASP-13 | TIM-539 item 2, TIM-542 item 16 | Tim | not run |  | `rule` | `settings` |
| ASP-14 | TIM-539 prototype (in the archive, no separate yes) | Tim | not run |  | `rule` | `settings` |
| ASP-15 | TIM-541 item 23 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| ASP-16 | TIM-539 resolution (in the prototype, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-17 | TIM-539 item 7, TIM-539 prototype comment | Tim | run |  | `rule` | `plugin-api` |
| ASP-18 | TIM-554 item 2, which removes TIM-546 item 18 | Tim for no redaction, Architect (Tim has not read) for applying it to afterTurn | not run |  | `rule` | `plugin-api` |
| ASP-19 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-20 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-21 | TIM-539 prototype comment (what the daemon's source changed) | Tim | read |  | `fact` | `plugin-api` |
| ASP-22 | TIM-539 prototype comment (what the daemon's source changed) | Tim | read |  | `fact` | `plugin-api` |
| ASP-23 | TIM-539 prototype comment (what the daemon's source changed) | Tim | read |  | `fact` | `plugin-api` |
| ASP-24 | TIM-539 prototype comment (what the daemon's source changed) | Tim | read |  | `fact` | `plugin-api` |
| ASP-25 | TIM-539 prototype comment (what the daemon's source changed), TIM-539 item 2 | Tim | read |  | `fact` | `plugin-api` |
| ASP-26 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-27 | TIM-539 prototype comment (where each part lands) | Tim | run |  | `rule` | `plugin-api` |
| ASP-28 | TIM-539 prototype (in the archive, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| ASP-29 | TIM-539 resolution (for the port), TIM-557 item 28 | Tim for the log lines, Architect (Tim has not read) for the count in `chad status` | run for the log lines, not run for the count |  | `rule` | `plugin-api` |
| ASP-30 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-31 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-32 | TIM-539 prototype, TIM-559 ruling on ASP-G2 | Tim for the replay and its timer, Architect (Tim has not read) for `Plugin.background` | run for the replay, not run for `Plugin.background` | TIM-559 | `rule` | `plugin-api` |
| ASP-33 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-34 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-35 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-36 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-37 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-38 | TIM-539 resolution (in the prototype, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-39 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-40 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-41 | TIM-539 resolution (for the port), TIM-531 item 3, TIM-557 item 30 | Tim for the block, Architect (Tim has not read) for the one message | run for the block, not run for the one message |  | `rule` | `plugin-api` |
| ASP-42 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-43 | TIM-539 item 5 | Tim | run |  | `rule` | `plugin-api` |
| ASP-44 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `apply` |
| ASP-45 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-46 | TIM-539 item 4 and resolution (in the prototype, no separate yes), TIM-543 item 3 | Tim | run |  | `rule` | `plugin-api` |
| ASP-47 | TIM-539 prototype (in the archive, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| ASP-48 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-49 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-50 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-51 | TIM-532 item 9, TIM-539 prototype comment | Tim | run |  | `rule` | `plugin-api` |
| ASP-52 | TIM-530 resolution, TIM-539 prototype | Tim | run |  | `rule` | `plugin-api` |
| ASP-53 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `apply` |
| ASP-54 | TIM-539 resolution (in the prototype, no separate yes), TIM-530 item 5, TIM-557 item 13 | Tim for the hook, Architect (Tim has not read) for the outcome of a `[SILENT]` answer | run for the hook, not run for the outcome |  | `rule` | `plugin-api` |
| ASP-55 | TIM-539 prototype, TIM-559 ruling on ASP-G1 | Tim for the hook, Architect (Tim has not read) for the mark in the store | run for the recall id, not run for the mark in the store | TIM-559 | `rule` | `plugin-api` |
| ASP-56 | TIM-539 resolution (in the prototype, no separate yes), TIM-557 item 12 | Tim for the hook, Architect (Tim has not read) for the reasons | not run |  | `rule` | `plugin-api` |
| ASP-57 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-58 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-59 | TIM-539 resolution (in the prototype, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-60 | TIM-539 item 4 | Tim | run |  | `rule` | `plugin-api` |
| ASP-61 | TIM-530 resolution (handed to TIM-539), TIM-539 prototype | Tim | run |  | `rule` | `plugin-api` |
| ASP-62 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-63 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-64 | TIM-539 prototype (in the archive, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| ASP-65 | TIM-539 item 8 | Tim | run |  | `rule` | `plugin-api` |
| ASP-66 | TIM-539 resolution (for the port), TIM-539 prototype | Tim | run |  | `rule` | `plugin-api` |
| ASP-67 | TIM-539 prototype (in the archive, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| ASP-68 | TIM-539 prototype (in the archive, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| ASP-69 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-70 | TIM-539 resolution (for the port) | Tim | run |  | `rule` | `plugin-api` |
| ASP-71 | TIM-539 prototype (in the archive, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| ASP-72 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-73 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-74 | TIM-539 item 6, TIM-539 prototype (scenario 8a) | Tim | run |  | `rule` | `plugin-api` |
| ASP-75 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-76 | TIM-530 resolution, TIM-539 prototype | Tim | not run |  | `rule` | `plugin-api` |
| ASP-77 | TIM-539 resolution (not settled here), TIM-539 item 8 | Tim | not run |  | `rule` | `plugin-api` |
| ASP-78 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-79 | TIM-539 prototype (in the archive, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| ASP-80 | TIM-539 item 1, TIM-539 prototype, TIM-532 item 5 as changed by TIM-558, TIM-559 ruling on ASP-G3 | Tim for the owner turn, Architect (Tim has not read) for a bot on the owner list | run for the owner turn, not run for a bot on the owner list | TIM-558, TIM-559 | `rule` | `plugin-api` |
| ASP-81 | TIM-539 item 1, TIM-547 item 9 as changed by TIM-552 | Tim | run |  | `rule` | `plugin-api` |
| ASP-82 | TIM-539 item 1 | Tim | read |  | `rule` | `plugin-api` |
| ASP-83 | TIM-539 prototype (in the archive, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| ASP-84 | TIM-539 prototype (in the archive, no separate yes) | Tim | run |  | `rule` | `plugin-api` |
| ASP-85 | TIM-530 resolution (handed to TIM-539), TIM-539 prototype, TIM-559 ruling on ASP-G1 | Tim for the handler, Architect (Tim has not read) for the mark in the store | run for the handler, not run for the mark in the store | TIM-559 | `rule` | `plugin-api` |
| ASP-86 | TIM-539 prototype (in the archive, no separate yes) | Tim | not run |  | `rule` | `plugin-api` |
| ASP-87 | TIM-532 item 9, TIM-539 prototype (scenario 2) | Tim | run |  | `rule` | `plugin-api` |
| ASP-88 | TIM-530 resolution, TIM-539 item 6, TIM-559 round 3 C1 | Tim for the reply path and the turn after a compaction, Architect (Tim has not read) for the first turn after `/new` | not run | TIM-559 | `rule` | `plugin-api` |
| ASP-89 | TIM-530 resolution, TIM-532 item 10, TIM-539 prototype (scenario 8a) | Tim | run |  | `rule` | `plugin-api` |
| ASP-90 | TIM-539 item 6, TIM-543 item 5 | Tim | run |  | `rule` | `plugin-api` |
| ASP-91 | TIM-543 item 1, as posted on TIM-539, TIM-557 item 29 | Tim for the stream, Architect (Tim has not read) for the reconcile | run for the stream, not run for the reconcile | TIM-557 | `rule` | `plugin-api` |
| ASP-92 | TIM-539 resolution (a correction), TIM-543 item 5; answered for Tim by Jarvis, chat 2026-11-15 | Tim; the 40 second bound kept by Jarvis, delegated by Tim on 2026-11-15 (Tim has not read) | run |  | `rule` | `plugin-api` |
| ASP-93 | TIM-539 item 8, TIM-543, TIM-541 item 25 as changed by TIM-553, TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Tim for the hooks on a stop, Architect (Tim has not read) for the 50 second point; confirmed by Jarvis, delegated by Tim on 2026-11-15 | run for the hooks on a stop, not run for the 50 second point | TIM-541, TIM-553, TIM-559 | `rule` | `plugin-api` |
| ASP-94 | TIM-547 items 10 and 11, TIM-552, TIM-559 ruling on ASP-G1 | Architect (Tim has not read) | run for the queue, not run for the forget marks | TIM-559 | `rule` | `apply` |
| ASP-95 | TIM-539 prototype (scenarios 7 and 11) | Tim | run |  | `rule` | `plugin-api` |
| ASP-96 | TIM-539 prototype (scenario 11) | Tim | run |  | `rule` | `plugin-api` |
| ASP-97 | TIM-539 prototype (scenario 11) | Tim | run |  | `rule` | `plugin-api` |
| ASP-98 | TIM-539 prototype (scenario 7b) | Tim | run |  | `rule` | `plugin-api` |
| ASP-99 | TIM-534 item 8, TIM-539 prototype, TIM-557 items 36 and 40 | Tim for the rule, Architect (Tim has not read) for the key and the repeat rule | not run | TIM-557 | `rule` | `plugin-api` |
| ASP-100 | TIM-539 resolution (for the port), TIM-536 item 3, TIM-559 ruling on ASP-G1 | Tim for three kinds of key, Architect (Tim has not read) for `forget/` | run for three kinds of key, not run for `forget/` | TIM-559 | `rule` | `plugin-api` |
| ASP-101 | TIM-539 resolution (for the port), TIM-536 item 3, TIM-559 ruling on ASP-G1 | Tim, Architect (Tim has not read) for `forget/` | not run | TIM-559 | `rule` | `plugin-api` |
| ASP-102 | TIM-558 items 47 and 49 | Architect (Tim has not read) | not run |  | `rule` | `asphodel` |
| ASP-103 | TIM-558 item 46 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| ASP-104 | TIM-539 body and resolution, TIM-558 item 49, map (Out of scope) | Tim | not run |  | `definition` | - |
| ASP-105 | TIM-541 item 23 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| ASP-106 | TIM-539 prototype comment (where each part lands) | Tim | not run |  | `definition` | - |
| ASP-107 | TIM-557 item 13, TIM-539 prototype | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| ASP-108 | TIM-557 item 41 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| ASP-109 | TIM-559 ruling on ASP-G9 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| ASP-110 | TIM-559 ruling on ASP-G12 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| ASP-111 | TIM-559 ruling on ASP-G12 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| ASP-112 | TIM-559 ruling on ASP-G2, TIM-538 as changed by TIM-552 for the exception | Architect (Tim has not read) for the rule, Tim for the exception | not run | TIM-559 | `rule` | `apply` |
| ASP-113 | TIM-559 ruling on ASP-G1 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| ASP-114 | TIM-532 item 5 as changed by TIM-558, TIM-559 ruling on ASP-G3 | Architect (Tim has not read) | not run | TIM-558, TIM-559 | `rule` | `plugin-api` |
| ASP-115 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| ASP-116 | TIM-559 round 3 C1 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| ASP-117 | TIM-559 round 3 C1, TIM-559 ruling on SES-G2 for the two bounds | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
