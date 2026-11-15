# chad plugin swap prototype (TIM-552), with the MCP layer rebuild (TIM-555)

This archive holds two prototypes on one host. The plugin swap from TIM-552 comes first, unchanged. The MCP layer rebuild from "The MCP layer rebuild run with calls in flight" (TIM-555) is the second half of this file, from "The MCP layer rebuild" down.

# The plugin swap (TIM-552)

Throwaway. It answers one question: does the swap path from "What an apply does to a plugin's work in flight" (TIM-547) hold when it runs with live sessions?

It does. 122 checks pass, and the run turned up four things TIM-547 did not settle. They are at the bottom, with what the prototype now does about each.

## What is real and what is not

Real: clanka 0.27.0 (`Agent.makeWith`, its executor, its sub-agents), effect cluster's `SingleRunner` over one SQLite file, the `Session` and `Timer` entities from "The Session entity run on SingleRunner and SQLite" (TIM-543), and plugins that are bundled with esbuild and run with `vm.compileFunction` as in "Runtime and plugin loading mechanism" (TIM-538).

Not real: the model. It is scripted. A user message carries `PLAN:{"steps":[...]}`, and the model emits one `execute` call per step and then answers with what the scripts printed. Discord is `ChatTest`. There is no git and no type-check, a snapshot is a copy of `work/`.

## Files

- `chad/plugins.ts` is the subject: versions, the wrapper round every plugin tool handler, the gate, the drain, the close deadline, the hook queue, the one daemon queue, and what a graceful stop does to a swap.
- `chad/host.ts` is the TIM-543 host with real clanka in it. A session rebuilds its Agent at the start of a turn when a swap has happened since.
- `chad/Plugin.ts` is a stub of the plugin API.
- `seed/` holds the plugin templates the scenarios write into `work/plugins`.
- `scenarios.ts` runs one scenario in one process. `run.ts` starts them, sends SIGTERM at chosen events, restarts on the same files and checks the event log.
- `out/results.txt` is the last full run. `out/<scenario>.jsonl` is the event log of each run.
- `chad/mcp.ts` and `mcp-server.mjs` belong to the MCP half below.

## Run it

```
npm install
node run.ts            # every scenario of both halves, about 2 minutes
node run.ts gate hooks # only those
```

Node 24 or later. `deadlines` uses the real 30 and 10 second constants. `stubborn` shortens them.

## What each scenario shows

| scenario | claim |
| --- | --- |
| route | One turn, one Agent, four calls. Each is answered by the instance current when the call is made: after `chad plugin reload`, after a timezone change, after an apply that changed one setting. |
| changed | After an apply that changed the code the call fails with the agreed message and the turn carries on. Same for a removed tool and for safe mode. A turn in another session loses the tool too. A timer of a plugin that safe mode turned off is held. |
| gate | A call in flight finishes on the old instance. A call that arrives during the swap is held 2.98 s and answered by the new instance. A call from an Agent built on another bundle fails 18 ms after the gate closed. |
| deadlines | Drain 30.0 s, then the tool call and the hook (own timeout 120 s) are interrupted. Close abandoned at 10.0 s. Activation 40.0 s after the gate closed. A turn that started during the swap waited 39.8 s. A timer that fired during it was held. |
| hooks | The running hook finishes on the old version. The two queued `afterTurn` hooks run on the new one. The queued `Compacted` hook is dropped and logged. A removed plugin's queued hook is dropped. The old version's `Plugin.background` fiber is interrupted at the close. |
| reload-fail | A timezone reload where one plugin fails to build: the other swaps, that one keeps its old instance, exit 1, and status says "running with the previous timezone". With an owner removed it is unloaded instead. |
| stop-before-commit | SIGTERM before the commit. `live` does not move and the next boot loads the old version. |
| stop-drain, stop-apply | SIGTERM during the drain. The swap is abandoned, the new instance is closed unused, the old one runs its queued hook and closes in the ordinary stop, and the next boot loads what `live` points at. |
| stop-close | SIGTERM while the old scope is closing. The queued hook is dropped with a log line and the next boot loads the new version. |
| subagent, bg-open | A sub-agent's and a background sub-agent's calls are routed after a reload and refused after a code change. |
| shape, shape-raw, shape-result | One bundle, other settings. See below. |
| stubborn | A handler that cannot be interrupted. See below. |
| hole, hole-any | Why the rule is by bundle hash. With `PROTO_ROUTE_ANY=1` a handler written for a string is handed a number. |

## Comparing two rendered declarations

Byte for byte, per tool, on the text clanka's `ToolkitRenderer` puts in the system prompt. The current version's text is compared with the text the turn's Agent was built with, not the outgoing version with the incoming one.

The bundle hash is checked first, so the declarations are only compared when the code is the same. What can still differ then is whatever the plugin read while it was built: a setting, a secret, the timezone, the owners. Any difference in the text is a real difference in what the model was told, so there is nothing for normalising to forgive. The renderer is deterministic: four instances of one bundle rendered the same text in `route`.

## What the run found, and what the prototype does about it

1. The declaration hides some schema changes. clanka renders the decoded TypeScript type, so `Schema.Trim`, `Schema.String` and a string with a minimum length all render `string`. A plugin that builds a schema from a setting keeps its hash and its declaration. `shape-raw` shows what gets through: `"  bob  "` stored under a schema that trims and under a minimum length of 10. So the wrapper carries a routed call across the two schemas. It encodes the parameters with the Agent's schema and decodes them with the current version's, and takes the result back the other way. In `shape` the handler then gets `"bob"`, and the short value fails as a parameter error before the handler runs. In `shape-result` a result the Agent's schema no longer accepts fails with a message that says the call ran.
2. Interrupting is a request. In `stubborn` a handler in an uninterruptible region ran 4.5 s past the deadline, inside a version whose scope had closed. chad waits up to 1 second for an interrupted call or hook to stop, and that second comes out of the close deadline. Then the caller is told which happened: "was interrupted by an apply, it may have partly run", or "did not stop when an apply interrupted it and may still be running".
3. A call held at the gate when a graceful stop abandons the swap goes through the routing rule again against the version that is now current. In `stop-drain` that was the old version, and the turn ended normally during the stop. When the old version has closed, the call waits until the stop cuts its turn (`stop-close`).
4. clanka keeps a turn open while a background sub-agent runs, even after the model has answered. So a background sub-agent's call is a running turn's call. It also means the owner's next message is steered into that turn and runs on the old Agent (`bg-open`), so "the new version is in your next turn" is further away than it sounds. With a sub-agent running the message adds "which cannot start while this turn has a sub-agent running".

Not from the swap path, but seen: a graceful stop spent 15 s in the entity layers when a turn was running, and between 2 and 9 s closing `SingleRunner` when none was.

## Not run

The `McpServers` layer rebuild was not run in TIM-552. It is run below.

# The MCP layer rebuild (TIM-555)

Throwaway. The question: do the seven MCP rules in the follow-up comment on "Skills and MCP servers: where they live and how chad adds one" (TIM-537) hold when the `McpServers` layer is rebuilt under live sessions?

Four hold as written. Rule 6 contradicts itself, rule 3's 60 seconds is shorter than a rebuild can take, and rule 4 names an error clanka does not have. The rules were amended with Architect standing in for Tim, and the amended rules were then run too. 169 MCP checks pass over 22 scenario runs, next to the 122 plugin checks, 291 in all.

## What is real and what is not

Real: everything real in the plugin half, plus clanka's own `McpServers.layer`, the MCP SDK client inside it (1.32.2), and MCP servers that are separate processes. Three kinds of server ran: stdio servers that exit when their stdin closes, stdio servers that ignore that and SIGTERM, and one streamable HTTP server.

Not real: the model is still scripted. The MCP servers are one test server (`mcp-server.mjs`) under different names, not `npx -y` packages. The secret store is an object in memory. There is no OAuth server, so no login.

## Files

- `chad/mcp.ts` is the subject. It holds the one wrapper round clanka's `McpServers` that every Agent is handed, and the one rebuild path: gate, drain, interrupt, close, connect. `PROTO_MCP_RULES=written` runs the rules as TIM-537 has them. Without it the amended rules run.
- `mcp-server.mjs` is the test server. Each start reads `$MCP_CTL/<name>.json`, which says what label to answer with, which tools to list, the type of one parameter, how long to take to connect, and whether to ignore stdin closing and SIGTERM. It writes what it sees to the same event log.
- `chad/host.ts` gives each session's Agent the wrapper, and rebuilds the Agent at the start of a turn when a layer has become current since.
- `chad/plugins.ts` has one new hook: an apply closes the MCP gate in the same synchronous step as the plugin gates.
- `out/full-run-all-at-once.txt` is a full run with all 40 scenarios started at once. 14 timing checks failed under that load, plugin ones among them. `run.ts` now runs 8 at a time.

## Run it

```
node run.ts mcp                 # the 22 MCP runs, about 2 minutes
node run.ts mcp-cap mcp-route   # only those
```

`mcp-deadlines`, `mcp-cap` and `mcp-amended-held` use the real 30 second drain and clanka's real 30 second connect timeout.

## What each scenario shows

Rules as written (`PROTO_MCP_RULES=written`):

| Scenario | What it shows |
| --- | --- |
| mcp-route | Rules 1 and 7. One turn on one Agent makes four calls, and four server processes answer them: before and after `chad mcp restart`, a change to a secret `mcp.json` names, and an apply that adds a server. A secret `mcp.json` does not name rebuilds nothing. The added server is callable from the next turn. |
| mcp-gate | Rules 2 and 3. A call in flight finishes on the old layer. A call that arrives at the closed gate is held and the new layer answers it. |
| mcp-deadlines | Rule 2 with the real 30 s drain. The call still in flight is interrupted with the agreed message, the server sees the cancellation, and the old server is gone before the new one starts. |
| mcp-cap | Rules 3, 4 and 6 with the real 60 s. The rebuild took 62 s, so the held call failed 2 s before the layer was ready, and the turn that had waited started without MCP. |
| mcp-start-none, -fail, -route | Three readings of rule 6's "starts without MCP", with a 3 s cap. |
| mcp-start-nowait | Not in the rules: the turn does not wait at all. |
| mcp-sub-none, -route | A sub-agent that a running turn spawns while no layer is current. |
| mcp-removed | Rule 4. A removed server, a dropped tool, a parameter that changed type and a server that no longer connects. |
| mcp-both | Rule 5. One apply changes a plugin setting and `mcp.json`. The gates close 1 ms apart and the plugin activates 5 s before the MCP server connects. |
| mcp-stop-drain, mcp-stop-between | SIGTERM during the drain, and after the old layer closed. Each has a second phase, the next boot. |
| mcp-stubborn, mcp-stubborn-pause | A call the server will not stop, on four servers at once, without and with a 250 ms pause before the close. |

Rules as amended:

| Scenario | What it shows |
| --- | --- |
| mcp-amended-held | The real times and a 62 s rebuild. Held calls wait for the rebuild to end. A turn that starts during it starts at once. |
| mcp-amended-backstop | The backstop, shortened to 3 s. The call fails "not sent", the rebuild carries on, and the same call made again is held again. |
| mcp-amended-removed, mcp-amended-route | The new wording, and the hint on `searchTools`. |
| mcp-amended-both | A turn that starts during a slow MCP rebuild and uses only a plugin tool ends in 0.1 s. |
| mcp-amended-boot | A turn at boot, before any layer has connected, with the backstop shortened to 3 s. |

## What clanka fixes

Seen in the runs, and the reason for most of what follows.

- An Agent reads the MCP prompt section and declarations once, when it is built.
- `handlers()` is called once per spawn, synchronously: once for a turn and once for each sub-agent. The keys it returns are the only `mcp.*` names that turn's scripts have.
- A server that failed to connect has no handlers at all.
- An interrupted call returns at once. The SDK drops the request and sends the server a cancellation.
- Closing the layer closes the servers one after another. A stdio server gets its stdin closed, SIGTERM 2 s later and SIGKILL 2 s after that.

## What the run found

1. Rule 6 contradicts itself. A turn with no handler keys has no `mcp` name in its scripts, so its call throws `mcp is not defined` and chad's wrapper is never reached. The agreed message cannot be delivered to a turn that "starts without MCP".
2. Rule 6 undoes the reason for rule 5. A turn that started during a 5 s rebuild and used only a plugin tool waited the 5 s, and would wait up to 60.
3. Rule 3's 60 s is shorter than a rebuild. With default timeouts and one server that never answers the rebuild took 62.1 s: 30.0 s drain, 0.07 s close, 32.0 s connect. The last 2 s is the SDK killing the server that timed out. The held call failed "not sent" 30 s after its own server had connected.
4. The close of the old layer has no deadline. It took 4 s for each stdio server that ignores stdin closing and SIGTERM, one after another: 8.0 s for two. A graceful stop pays the same.
5. Rule 4's "keeps clanka's own error" has nothing to keep for a server that failed to connect. chad has to word it from `status`. And a tool that is gone after `chad mcp restart` cannot be called "removed by an apply".
6. In a running turn, `searchTools` lists a server the rebuild added, and calling it throws `Cannot read properties of undefined` in the script. A sub-agent that turn spawns afterwards can call it.
7. A sub-agent spawned between the old layer's close and the new layer cannot wait, because clanka takes its keys synchronously. With no keys it has no MCP for its whole life.
8. A call that "does not stop when it is interrupted" never came up on chad's side. All 8 interrupted calls returned within 5 ms. The server is another matter: 3 of the 4 finished the work anyway.
9. The HTTP server was never told to cancel. The close that follows the interrupt aborts the cancellation before it is sent. With a 250 ms pause it arrived. clanka also never deletes the HTTP session.
10. A graceful stop that abandons a rebuild behaves like the plugin swap. During the drain the held call was routed again to the old layer and answered. After the close it waited for the stop to cut its turn, which resumed on the next boot against the `mcp.json` the apply had committed. Abandoning during the connect took 2.0 s, the time to kill the half-started server.
11. A turn cut by a graceful stop while its MCP call was in flight sends that call to the server a second time when it resumes.

## The amended rules

Agreed with Architect, and run except where "Not run" says otherwise.

- Rule 2. The interrupted message becomes "mcp.<server>.<tool> was interrupted by an MCP restart. It may have run in part or in full." chad waits 250 ms between interrupting calls and closing the old layer.
- Rule 3. A held call waits until the rebuild ends, with a backstop of 120 s. At the backstop it fails with "MCP servers are restarting. This call was not sent." and the rebuild carries on. The same call made again is held again. When the rebuild ends with the call's server not connected, the call gets rule 4's message.
- Rule 4. A server gone from `mcp.json`: `mcp.<server>.<tool>: MCP server "<name>" was removed from mcp.json.` A tool its server no longer lists, whatever caused the rebuild: `mcp.<server>.<tool>: "<name>" no longer lists this tool.` A server still configured and not connected: `mcp.<server>.<tool>: MCP server "<name>" is not connected: <first line of the status error>`. Needing login: `MCP server "<name>" needs login.`
- Rule 6. A turn or sub-agent that starts during a rebuild takes the keys and prompt of the last layer that finished connecting, and is a running turn from then on. It does not wait. At boot there is no such layer: the turn waits for the first one with the same 120 s backstop, then starts without MCP, and its prompt says "MCP servers were still starting when this turn began. They are available from your next turn."
- Rule 7. When `searchTools` runs in a turn that holds no key for a tool the current layer has, chad adds a line to the result: "mcp.<server>.<tool>, … are callable from your next turn."
- Boot is a rebuild. The gate is closed from the start and the servers connect in the background.
- The plugin message "did not stop when an apply interrupted it and may still be running" does not carry over to MCP.

## Not run

- A real model. Every call came from a script.
- `chad mcp login`, and so the "needs login" message. There was no OAuth server.
- The 120 s backstop at its real length, for a held call or at boot. Both ran at 3 s.
- A real `npx -y` server, and whether one exits when its stdin closes.
- A secret used in an HTTP header.
- The `searchTools` hint grouped by server for a long list.
- The stop inside a container. The MCP close adds 4 s per stubborn stdio server to the graceful stop, which "The chad image built and run" (TIM-553) measures against a 90 second grace period.
