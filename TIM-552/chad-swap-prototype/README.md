# chad plugin swap prototype (TIM-552)

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

## Run it

```
npm install
node run.ts            # every scenario, about 50 seconds
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

The `McpServers` layer rebuild from the MCP rules on "Skills and MCP servers: where they live and how chad adds one" (TIM-537). It needs clanka's MCP layer and a live server.
