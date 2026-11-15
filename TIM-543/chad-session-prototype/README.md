# chad session prototype (TIM-543)

Throwaway. It answers one question: does the session design from "Sessions and turns" (TIM-532) hold when it is run?

- `chad/host.ts` is a stand-in for chad: a `Session` entity and a `Timer` entity on `SingleRunner` over a SQLite file, clanka through `openai-compat`, `ChatTest` in place of Discord, and stub plugins.
- `scenarios.ts` is one child process per run. `run.ts` starts those, kills them at chosen events, restarts them on the same SQLite file and checks the event log.
- `out/results.txt` is the check list from the last run. `out/<id>.jsonl` is each scenario's event log. `full-run.txt` is the unedited output of the one full run, which has one failure: the `compact-real-short` check was worded too strongly. It was reworded and that scenario rerun five times (`out/compact-real-short.run*.jsonl`, tallied in `out/compact-real-short.runs.txt`).

After Tim agreed the recommendations, two that had not been run were run: `term-then-kill` (a graceful stop does not spend the resume, behind `PROTO_GRACEFUL_FREE=1`) and `idle-cost-poll1s` / `idle-cost-poll10s` (what the storage poll costs an idle process). `followup-run.txt` is that run, with four older kill and stop scenarios rerun beside them. `out/results.txt` has all 90 checks.

## Run

Needs Node 26 (it runs the TypeScript directly) and, for the scenarios marked "real brain", `CLANKA_OPENAI_API_URL` and `CLANKA_OPENAI_API_KEY`.

```
npm install
node run.ts                 # everything, about 5 minutes
node run.ts kill-twice idle # only those
```

effect comes from pkg.pr.new at `0b51fb1`, the head of the `effect-chat` branch. clanka is 0.27.0.

## What is fake

The scripted brain (`PROTO_BRAIN=fake`) reads its behaviour from the prompt text: `sleep:<ms>`, `compact`, `[SILENT]`. The plugins are stubs that log what their hooks receive. There is no Discord.
