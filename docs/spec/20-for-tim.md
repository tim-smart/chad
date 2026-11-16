# For Tim

This is the one file to read before you merge the spec and let the build start. It holds the size of the build, the questions that were yours with the answers Jarvis gave for you, what changed after you agreed it, your to-do list and a paragraph on each ticket you have not read. Sections 1, 2 and 4 take about five minutes each, section 5 about ten and section 3 about half an hour.

## The size of the build

The spec holds 2,882 rule ids in 20 parts, 00-overview.md to 19-build-order.md.

| Stage | Slices, with their rule ids | Rule ids | Kind `rule` | Kind `fact` |
| --- | --- | --- | --- | --- |
| 1 | `repo` 16, `harness` 141, `wire` 30, `cli` 137 | 324 | 314 | 10 |
| 2 | `turns` 120, `kills` 36, `failures` 178, `discord-ui` 46, `models` 174 | 554 | 525 | 29 |
| 3 | `plugin-api` 379, `loader` 64, `apply` 349 | 792 | 774 | 18 |
| 4 | `settings` 273, `skills-mcp` 200, `timers-cron` 187 | 660 | 645 | 15 |
| 5 | `backup` 80, `image` 39, `bundled-skills` 114, `asphodel` 5, `live` 11 | 249 | 245 | 4 |
| No slice | 234 definitions and 69 withdrawn rules | 303 | 69 | 0 |
| Total | | 2,882 | 2,572 | 76 |

By kind there are 2,572 rules, 76 facts about a dependency and 234 definitions. 67 of the definitions were rules of 17-testing.md and 19-build-order.md until your fifth ruling of 2026-11-15, which says that a rule about how the suite and the build are run needs no test. The withdrawn rules are SWAP-18, MCP-101, TST-103 and the twenty-one that went with your rulings of 2026-11-15 that chad has no scheduled job, no release list and no budget: TST-115 to TST-118, TST-120, TST-121, TST-123 to TST-132, TST-139, TST-140, TST-142, TST-143 and TST-205. Five definitions were withdrawn with them, TST-114, TST-122, TST-141, TST-195 and ORD-18, and so were TST-206 to TST-208, which the build had added and this table does not count. Your fifth ruling of the same day withdrew thirty-eight more rules and three definitions. They are the bookkeeping checks (TST-20, TST-92, TST-154 to TST-157, TST-159, ASP-109), the skill runs (TST-148 to TST-150, TST-187, SELF-125, SWAP-145), the Compose example (IMG-98 to IMG-100, IMG-135 to IMG-137, CRED-127, CRED-128, TST-184), most of the full disk rules (FAIL-138, FAIL-139, FAIL-142 to FAIL-145, FAIL-172, FAIL-217, FAIL-218, FAIL-220 to FAIL-224, FAIL-280, FAIL-314, TST-167) and the docs' NFS paragraph (IMG-73). The three definitions are TST-157, FAIL-145 and FAIL-224. Jarvis's correction to that ruling, on TIM-560 the same day, withdrew five rules that restate two of those cuts in other parts. SWAP-146 is the pass mark of a skill-run task. SES-136, SES-174, SES-175 and STO-127 are the row closed on redelivery. Your seventh ruling of the same day withdrew TST-119, which had the image tests run the stop at its real length, and your eighth withdrew two definitions, TST-9 and TST-13, with the waiver list. Your ruling of 2026-11-16 on the last four stopped rules withdrew IMG-130 and made CRED-77 and CRED-78 definitions. Nothing without a slice is pending (TST-172).

| "Agreed by" | Rule ids |
| --- | --- |
| You, in person, at charting or in chat | 837 |
| Architect standing in for you, which you have not read | 1,806 |
| Mixed, where one statement is yours and another is Architect's | 236 |
| Nobody, written during assembly (ORD-23 to ORD-25) | 3 |

You agreed fifteen tickets in person: "Plugin API: what a plugin exports and what it can do" (TIM-530), "Applying a plugin change to a live session" (TIM-531), "Sessions and turns" (TIM-532), "What a turn looks like in Discord" (TIM-533), "Recovering from a bad self-edit" (TIM-534), "Model provider and headless login" (TIM-535), "Storage on the data volume" (TIM-536), "Skills and MCP servers: where they live and how chad adds one" (TIM-537), "Runtime and plugin loading mechanism" (TIM-538), "The asphodel plugin written against the plugin API" (TIM-539), "Cron as a bundled plugin" (TIM-540), "The chad CLI: what it covers and how it reaches the running daemon" (TIM-542), "The Session entity run on SingleRunner and SQLite" (TIM-543), "Codex login run for real" (TIM-544) and "The plugin swap run with live sessions" (TIM-552).

You have not read twelve, which section 5 takes one by one: "Docker image and data volume layout" (TIM-541), "Credential tools: stored logins and one-off codes for tools that sign in" (TIM-546), "What an apply does to a plugin's work in flight" (TIM-547), "Plugin settings: the settings file and turning a plugin off" (TIM-548), "The bundled skill that teaches chad to change itself" (TIM-549), "The chad CLI's socket, lock and session marker run for real" (TIM-550), "The chad image built and run" (TIM-553), "Credential tools run on real clanka and a browser sidecar" (TIM-554), "The MCP layer rebuild run with calls in flight" (TIM-555), "What the owner sees when things go wrong" (TIM-557), "How chad is tested once built" (TIM-558) and "Assembling the spec: where it lives and the build order" (TIM-559).

579 rules have "Changed by" filled, and section 3 covers those that state something you agreed in person. TIM-559 is named in that column on 266 rules and TIM-557 on 152. By the first word of the Support cell, 746 rules were run in a prototype, 186 were read from source and 1,950 were not run.

The build used to spend most on one test for each rule id. Your eighth ruling of 2026-11-15 ended that, after your seventh had loosened it with a waiver list. TST-173 now chooses tests by what chad does: a slice has scenarios that run each feature the way the owner, a plugin, the model or the CLI reaches it, and a rule needs a test of its own only if it decides who chad obeys or what chad keeps secret, if breaking it loses or damages what is on the volume, or if it says what happens on a kill, a crash, a race, a lock or a timeout. A bug that review or the owner finds gets a regression test. The rule-id script no longer fails on a rule that no test names (TST-9 is withdrawn), and the waiver list is gone (TST-13). Review is what says a rule is built, so a rule can be missed without the gate failing. That is the cost of the ruling. TST-19 still sets no coverage number, by line or by rule id.

Two rulings are your own, made in chat on 2026-11-15, and they override Architect. The repo `tim-smart/chad` exists and is public. The build is five stage issues that share one branch and one pull request (TST-199, ORD-1 to ORD-3), with no pull request per slice and no cap on rule ids per issue (TST-17, ORD-5).

With one shared pull request, a merge no longer tells the rule-id script which slices are delivered. ORD-9 to ORD-12 answer that with a file under `docs/spec/` that lists the delivered slices and the held rules, and the script reads what is pending from that file alone. Those four rules were written during assembly. Architect agreed them in round 4 of TIM-559, and you have not read them.

Before the spec was published, eight readers each took one slice of stages 1 and 2 with only what a builder gets and listed what they would have to ask. Their 156 questions were fixed in the parts, most of them as pointers, slice moves and gaps for the builder with a recommended answer. The fixes that state something new went to Architect as round 5 of TIM-559, and you have not read them: a list of stopped rules for a rule a builder reports as wrong (ORD-42, ORD-43), waivers for rules that only a live item or a hand check covers (ORD-44), that there is no scheduled workflow and no release list (ORD-46, as your rulings of 2026-11-15 left it), the inputs of `runDaemon` (TST-33, TST-201 to TST-203), oxlint and prettier (TST-204), and what a boot writes when it is refused before it holds the lock (FAIL-322).

The first usable build is the end of stage 2, after the `models` slice (ORD-22). From there an owner can add a Discord connection and an owner with the CLI, log in to Codex and talk to chad in a thread (ORD-23). That build has no plugins, apply, `chad.json`, secrets, skills, MCP servers, timers, cron, backup or `chad setup`, and it runs from the Dockerfile alone (ORD-24). Until `plugin-api` is delivered, a changed model is only sure to reach a session opened after the change (ORD-25). ORD-23 to ORD-25 were written during assembly, and nobody has agreed them.

## The questions that were yours

Twenty questions waited on you when the spec was published: three from TIM-553 and seventeen gaps in the parts. You handed them to Jarvis in chat on 2026-11-15. Each answer below is in the spec now, and the Provenance row of each rule it touches says "Jarvis, delegated by Tim on 2026-11-15". 26 rules carry that mark. They are still counted in the table of section 1 under whoever agreed the rule before. You have not read the answers. An answer you disagree with reopens that point, and most are a change of one or two rules.

The three from TIM-553. In each, the answer that had been provisional stands.

- The deadline of a stop (IMG-82, IMG-83, IMG-139, with SES-115, REC-148, MCP-97, FAIL-243 and ASP-93). A timer that starts in the SIGTERM handler exits the process at 60 seconds with code 1 and writes `stop.cut`. TIM-541 item 25 says chad exits within 60 seconds, and nothing enforced it: in the run a turn that ignored interruption kept the daemon alive until Docker's kill at 90 seconds. The timer is the only thing that makes the 60 seconds true.
- What `CHAD_DATA` is for (IMG-29, IMG-140, with STO-188, REC-149, CLI-204 and TST-189). In the image the volume is at `/data`, and `CHAD_DATA` is for running chad outside the image and for the process scenarios. It does not move `HOME`, the caches, the npm prefix or PATH. Making it move the whole volume in the image means deriving those four at start, which nothing ran, and the image has one volume path.
- Why `CHAD_SOCKET` exists (IMG-30, IMG-63, CLI-9). It stays, for a data path so deep that the socket path passes the platform's limit, 107 bytes on Linux and 103 on macOS. That reason ran. The reason you agreed in TIM-542 item 2, a filesystem that cannot hold a socket, did not hold in the run. You agreed the variable itself, so it was kept over dropping it.

The gaps, in part order. Each gap is gone from its part.

| Gap | Question | Answer | Why |
| --- | --- | --- | --- |
| IMG-G1, CLI-G18, TST-G7 | Pointers to the three questions above | Closed with them | |
| DIS-G21, CRED-G1 | Whether "no redaction" also removes the masking of the status message and of chad's own outputs | Yes. chad masks nothing (CRED-12, DIS-34) | Your ruling on TIM-554 was that nothing is redacted. A mask on stored values of 8 characters or more misses any value a script transforms, so it reads as a protection it does not give. The `chad secret` commands and the `credentials` skill never print a stored value (CRED-8). The cost is the one of FAIL-9: script source and output are in the status message and in stdout, wherever the container's logs are shipped. |
| MOD-G1 | `session_id`, which you agreed in TIM-544, or `session-id` | `session-id` (MOD-32) | It is the spelling read from the Codex CLI, and the one that ran. |
| API-G10, ASP-G10 | The wait before a session's next turn after a compaction is at most 40 seconds, and you agreed the rule with 10 seconds in front of you | 40 seconds stands (API-61, ASP-92) | It is reached only when a plugin's hooks hang, and it measured 272 ms with hooks that return. Getting to 10 seconds means cutting the 30 second `afterTurn` budget, which is what the asphodel ingest runs in. |
| MCP-G9 | Which MCP servers that need an OAuth login you want on day one | None | v1 names no server. The login is built and tested against the fake, and you add servers once chad runs. |
| SELF-G12 | Whether the bundled skills are also shown under `/data/repo/examples/` | No, plugins only | It is how TIM-549 read your "built in", and it needs no new rule. Adding the skills later changes the link's target to a directory that holds both. |
| SELF-G13 | What ends the trial of the `repo/examples` link | Nothing in v1. The link stays (SELF-20) | No test and no release waits on it. Whether the agent finds the link unprompted can only be seen once chad is in use, so it is yours to judge then. |
| CRED-G17 | Which sites you want chad signed in to on day one | None | The `credentials` skill ships its two recipes, for agent-browser and Playwright MCP, against the test form (CRED-83). A recipe for a real site is something you or chad add later. |
| FAIL-G23 | Whether to raise the four follow-ups outside chad as issues on Effect-TS/effect and Effectful-Tech/clanka | Only the first, effect's WebSocket decoder (FAIL-186). The other three are left alone | This one is your own ruling, made in chat on 2026-11-15 after you saw the list. The fix is "Fix effect's OpenAI WebSocket client dropping error frames and resets_at" (TIM-566). v1 waits for none of the four. |
| FAIL-G24 | Whether the thirteen changes that TIM-557 made to what you agreed in person stand | All thirteen stood. Twelve are left, because your ruling on a full disk took out the second free space notice | They are listed in 16-failures-logs-status.md. The two with the most weight are the end of a model call after 15 minutes of silence (FAIL-84), since a silent call otherwise costs about 117 minutes, and `chad logs` (FAIL-38), since the log is the only record of a failed turn. The one to know about is FAIL-9, as above. |
| TST-G25 | Whether chad lints with oxlint and formats with prettier as `tim-smart/lalph` does, and whether it takes that repo's `effect-language-service patch` step or its `tsgo` type-check | oxlint and prettier, and neither of the other two (TST-204) | TypeScript 7, which the image pins, already is the native compiler, so `tsgo` adds nothing. A compiler patched for Effect's diagnostics in the gate is not the compiler the image runs at an apply, and nothing was run with the patch on the vendored effect snapshot. Four of your repos carry Effect's diagnostics in one form or another, so this is the answer you are most likely to overrule. |
| ORD-G2 | One merge of the whole build after stage 5, or a merge after each stage | One merge (ORD-3) | It is your own ruling. A merge after each stage needs a new pull request each time, which breaks the one shared pull request of your plan workflow and makes each stage's start depend on what you merged. Two of the three gains are had without it: you can review on the same pull request at the end of each stage, and the branch is usable from the end of stage 2. The third was that scheduled jobs fire only from `main`, and chad now has none (ORD-46). |

One gap is still yours, because it is a measurement on your node and not a decision:

1. **IMG-G16** (01-image-and-volume.md). Which filesystem sits under the local-path directory on your k3s node. `stat -f -c %T /var/local-path-provisioner` answers it. Nothing in the build checks it any more, since you ruled on 2026-11-16 that chad has no Kubernetes tests, so your first deployment on that node is the check. Nothing in the build waits for it.

## What changed after you agreed it

Each bullet gives the rules, what you agreed, what the spec says now and, in brackets, the ticket that changed it. "As OV-46" points at the bullet for the same change.

### 00-overview.md

- OV-37. TIM-532 item 15: an image up to 10 MB goes to the model. Now only on a message that starts a turn. On a steering message it is saved as a file, with its path in the text. [TIM-559]
- OV-8, OV-36. Charting, TIM-542: a change takes effect only through a CLI command. Now one exception: clanka itself shows a session any `AGENTS.md`, `.agents/skills` and `.kiro/skills` around its working directory with no apply, a draft in `repo/work/` included. A check and an apply refuse those names. [TIM-559]
- OV-5. Charting: a local dev adapter built on `ChatTest`. Now `ChatTest` runs outside the daemon and the image carries only the adapter's client. [TIM-558]
- OV-11. TIM-542 item 23: no `logs` command. Now `chad logs` exists. [TIM-557]
- OV-24. TIM-532 item 5: the owner check. Now chad first drops a message it posted itself. [TIM-558]
- OV-26. TIM-531 item 3, TIM-532 item 9: the update message at the start of a turn. Now it also says what chad posted in the thread since the last answered turn. [TIM-557]
- OV-27. TIM-531: a turn running during an apply keeps the old tool handlers. Now a wrapper routes each plugin tool call to the current version or refuses it. [TIM-547]
- OV-29. TIM-532 item 11: history is stored as clanka appends it. Now also reconciled with the Agent's history at the end of every turn. [TIM-557]
- OV-41. Your TIM-554 ruling: no redaction. Now stated: the agent's script source and output go to stdout, and so wherever the container's logs go. [TIM-557]
- OV-43. TIM-533 item 5: the failed-turn message. Now a reply with the ping on in a server thread, with the turn id and `chad logs --turn <id>`. [TIM-557]
- OV-44. TIM-533 item 12: notices use subtext. Now a notice outside a turn is a normal message, with the owner's mention in a server thread. [TIM-557]
- OV-46. TIM-533 item 5: no turn timeout of chad's own. Now a turn ends at the third timeout in a row on one model call, 15 minutes of silence. [TIM-557]
- OV-34. As MOD-98. [TIM-559]

### 01-image-and-volume.md

- IMG-50. TIM-538 item 4: a plugin can import what the image ships. Now only `chad`, `effect` and Node's built-in modules are promised. [TIM-541, TIM-559]
- IMG-81, IMG-89 to IMG-92, IMG-132. TIM-534 item 7: three unclean boots start safe mode. Now the count also clears when the SIGTERM handler runs, and a boot that chad refuses to start does not count. [TIM-541, TIM-550, TIM-553, TIM-559]
- IMG-40, IMG-124. TIM-536 item 13: a new image's first boot copies the database. Now to `db/chad.db.before-migration`, and a boot that finds `state/migrating` keeps the earlier copy. [TIM-541, TIM-559]
- IMG-39, IMG-66, IMG-88. TIM-536 items 5, 8 and 14: chad stays up without sessions on any unusable database. Now an older chad that finds a newer `state/version` exits 1 and names the copy. [TIM-541, TIM-557, TIM-559]
- IMG-41. TIM-536 item 7: what `chad backup` holds. Now it skips `cache/`, `logs/` and the copy taken before a migration. [TIM-541]
- IMG-32. TIM-536 items 2 and 12: the volume layout. Now also `cache/`, `logs/`, the copy before a migration, `secrets/mcp-oauth.json`, `run/local.sock` and five files under `state/`. [TIM-541, TIM-557, TIM-558, TIM-559]
- IMG-6. TIM-535: no Claude Code and no SDK in the image. Now the SDK's JavaScript stays, because clanka imports it. [TIM-541]
- IMG-42. TIM-534 item 10: the owner can mount other directories. Now at `/mnt/<name>`. [TIM-541]
- IMG-44. TIM-538 item 8: `repo/node_modules` is a symlink into the image. Now remade at every boot, with anything else at that path moved aside. [TIM-553]
- IMG-49. TIM-538 items 4 and 6: `tsc` finds chad through `repo/node_modules`. Now through a self-link and an `exports` field of `.`, `./Plugin`, `./Session` and `./Turns`. [TIM-541, TIM-553]
- IMG-17, IMG-28. TIM-542 item 29: `CHAD_SESSION` marks a session's processes. Now `chad serve` sets `CHAD_SESSION=daemon` on itself, and a session's processes get `TZ`. [TIM-550, TIM-541, TIM-553]
- IMG-30. TIM-542 item 2: the reason for `CHAD_SOCKET`. Answered for you, section 2. [TIM-553, TIM-559]
- IMG-62. TIM-542 item 3: a held lock with a silent socket means starting or frozen. Now a booting daemon listens before it opens the database, so silence means frozen. [TIM-550, TIM-559]
- IMG-75. TIM-542 items 20 and 27: `chad health` exits 0 with the lock held and a ping answered. Now the lock is tested first, with exit 4 when it is free even if a daemon answers. [TIM-553, TIM-550]
- IMG-64. TIM-543: the cluster ran at 300 shards. Now `shardsPerGroup: 1`, the count in a database row, and a refusal to start on another count. [TIM-553]
- IMG-38. As OV-11. [TIM-557]
- IMG-118. As OV-41. [TIM-557]
- IMG-112. As OV-5. [TIM-558]

### 02-storage.md

- STO-179 to STO-181, STO-99. TIM-536 item 8: `chad restore` works only on an empty volume. Now empty means no file under `secrets/` and no row in `sessions`, so a volume `chad serve` has booted on takes a restore. [TIM-559]
- STO-103, STO-182. TIM-536 item 8: a restore into an older image is refused at boot. Now `chad restore` refuses a newer chad's tar before it writes. [TIM-559]
- STO-44, STO-158, STO-159. As IMG-40, and the copy is also skipped when the database cannot be opened. [TIM-559]
- STO-85, STO-176, STO-177. TIM-536 item 7: `chad backup` writes a tar to a path or stdout. Now no path is a usage error. [TIM-559]
- STO-62. TIM-532 item 11: a fingerprint of the tools, skills and MCP config. Now a hash of the rendered system prompt without the plugin chunks. [TIM-559]
- STO-19, STO-146. TIM-537 item 13: MCP OAuth tokens go in the secret store. Now in `secrets/mcp-oauth.json`, which `chad secret` and `${NAME}` never read. [TIM-559]
- STO-1. As IMG-32, plus two more model overrides. [TIM-541, TIM-549, TIM-557, TIM-558, TIM-559]
- STO-48, STO-117, STO-120. As IMG-39, and a boot refused the lock or the shard count check is not unclean. [TIM-541, TIM-550, TIM-553, TIM-557, TIM-559]
- STO-34. TIM-536: what the database holds. Now also the shard count row [TIM-553], `notices` and `session_updates` [TIM-557] and `steers` [TIM-559].
- STO-70. TIM-536 item 11: the `turns` row. Now also the failure reason, its detail and the model. [TIM-557]
- STO-65, STO-123. As OV-29. [TIM-557]
- STO-50. As IMG-64. [TIM-553]
- STO-27. TIM-542 item 3: the SQLite lock on `state/daemon.lock`. Now opened with `journal_mode=MEMORY` and referenced until exit. [TIM-550, TIM-553]
- STO-12. TIM-542 item 14: `secrets/secrets.json` holds the named secrets. Now each has a kind and a note. [TIM-546]
- STO-60, STO-61. TIM-542 item 12: `chad plugin purge` refuses a plugin still in the applied repo. Now also a repo plugin that is off [TIM-548] and a bundled plugin that is on, and a bundled plugin that is off can be purged [TIM-559].

### 03-sessions-and-turns.md

- SES-84, SES-97. As STO-62. [TIM-559, TIM-549]
- SES-154, SES-155. As OV-37. The file goes under `inbox/`. [TIM-559]
- SES-101, SES-161. TIM-532 item 13, TIM-543 decision 3: a resumed turn gets the restart note in place of the prompt. Now the prompt and then the note, when the kill came before the prompt was stored. [TIM-559]
- SES-15, SES-49. TIM-540 item 13, TIM-530: a tool calls `Turns.start` for its own thread without waiting. Now `Turns.queue` does that, and such a `Turns.start` fails at once. [TIM-559]
- SES-53. TIM-540 item 14: the core puts the `mention` at the start of a plugin turn's answer. Now not when the id is off the allowlist. [TIM-559]
- SES-147, SES-148. TIM-532 item 1: a mention in a plain server channel opens a thread. Now a mentioned chat command with no session answers in the channel. [TIM-559]
- SES-166, SES-167, SES-183. TIM-532 item 1, TIM-540 item 1: three places a session lives. Now a fourth, a session of kind `channel` in a plain server channel. [TIM-559]
- SES-142 to SES-144, SES-181, SES-182, SES-184. TIM-539 item 6: only queued `Compacted` hooks hold a session's next turn. Now the first turn after `/new` also waits for the queued `Reset` hooks, up to 10 seconds, or 30 and then 10 when `/new` stopped a turn. [TIM-559]
- SES-25 to SES-27. As IMG-64. [TIM-553]
- SES-29. As IMG-39, and `/status` still answers. [TIM-557]
- SES-32, SES-127. TIM-532 item 3: the handler refuses an event only when the save fails. Now on a full volume it answers in the thread and accepts the event. [TIM-557]
- SES-128. TIM-532 item 3: a refused event is replayed after a restart. Now dfx reconnects in the same process. [TIM-557]
- SES-36. TIM-532 item 6: `/new` and `/stop` as chat commands. Now also `/secret NAME`, `/secret NAME totp` and `/secret`. [TIM-546]
- SES-52. TIM-532 item 4: an owner message during a turn steers it. Now it first ends a waiting `chad secret request` in that thread. [TIM-546]
- SES-54. TIM-531 item 1: a running turn keeps the old handlers. Now a turn that starts during a swap waits for the activation, 40 seconds at most. [TIM-547]
- SES-88. As STO-70, with the usage columns and the key column `request_key`. [TIM-557, TIM-559]
- SES-106. TIM-532 item 13, TIM-533 item 12: a give-up message that said "restart". Now the turn ends as `Failed` with `GaveUp` and the message says "crash". [TIM-557]
- SES-115. TIM-539 item 8: a graceful stop runs the queued hooks inside their budgets. Now only until 50 seconds after SIGTERM. Answered for you, section 2. [TIM-541, TIM-553, TIM-559]
- SES-122 to SES-124. As OV-24. [TIM-558]
- SES-125. TIM-530, TIM-540 item 8: `Turns.start` and the timer handler get a turn's end as the request's reply. Now from the session in the same process. [TIM-557]
- SES-129. TIM-543: the three gateway checks became their own ticket. Now the `wire` slice tests them, and the hand checks run the mention on a real gateway. [TIM-558]
- SES-130. As OV-26. [TIM-557]
- SES-131, SES-132. TIM-530, TIM-540 item 15: `Failed` with a free reason, and `[SILENT]` not posted. Now a closed set of reasons, and a `[SILENT]` answer or one that could not be posted ends as `Answered`. [TIM-557]
- SES-133. As OV-46, and a turn also ends at a usage limit. [TIM-557]
- SES-134, SES-135. TIM-543 decision 1: a compaction belongs to the turn whose stream carried `HistoryReplaced`. Now also to the turn at whose end the reconcile found it. [TIM-557]
- Not a change: SES-86, no masking, is your own ruling on TIM-554.

### 04-discord.md

- DIS-77. TIM-533 item 12: every notice is subtext. Now "I couldn't open a thread on that message" is a normal message. DIS-109 keeps the part's other notices as subtext. [TIM-557]
- DIS-104, DIS-62, DIS-71. TIM-533 items 10 and 12: the give-up message and "Login timed out" are subtext. Now normal messages with a subtext line that carries the turn's id. [TIM-557]
- DIS-73, DIS-108. TIM-544 item 5: on a logged-out chad a turn with no owner present fails at once. Now it waits on a login already pending and ends as `LoginFailed` if that fails. [TIM-557, TIM-559]
- DIS-91, DIS-112, DIS-113. TIM-533 items 1 and 11: the status message is posted as soon as a turn starts. Now a plugin-started turn posts nothing while it waits on a login. [TIM-559]
- DIS-63. As OV-37. [TIM-559]
- DIS-102. As SES-53. [TIM-559]
- DIS-100. TIM-533 item 6: an answer starts as a reply to the owner's message. Now as a plain post when that message is gone. [TIM-559]
- DIS-5. TIM-532 item 6, TIM-542 item 22: five chat commands and no other. Now also `/secret`, with the list kept in 10-cli.md (CLI-138). [TIM-546]
- DIS-28. TIM-533 item 2: "Model error, retrying (2)". Now "Model error (RateLimitError), retrying (3 of 20)". [TIM-557]
- DIS-38. TIM-533 item 8: one Stop button, no other buttons or selects. Now two buttons, Stop and Enter, and one modal. [TIM-546]
- DIS-60. As OV-43, with a reason text per kind of failure. [TIM-557]
- DIS-61. As OV-46. [TIM-557]
- DIS-74. As OV-44. [TIM-557]
- DIS-78. TIM-534 items 8 and 15: a failing hook is told once. Now every notice outside a turn has a key, is sent when its condition begins and not again inside 24 hours. [TIM-557]
- DIS-80. As OV-24, and any id on the allowlist is an owner, bot or not. [TIM-558]
- DIS-30. TIM-533 item 2: "Read your message: ..." is added when clanka's `steer` completes. Now when chad sees the steering messages in the stored history. [TIM-559]
- DIS-34. Not a change: your own TIM-554 ruling. See DIS-G21.
- DIS-19, DIS-54, DIS-92, DIS-96, DIS-98, DIS-101, DIS-103. Not a change: detail only.
- DIS-72. Not a change for a turn an owner's message started. [TIM-559]
- DIS-114. New: you agreed nothing about that case. [TIM-559]
- DIS-88. New, from TIM-559 alone.

### 05-model-and-login.md

- MOD-6. As IMG-6. [TIM-541]
- MOD-25, MOD-93 to MOD-95. TIM-535: `CHAD_MODEL` is checked at startup. Now every model chad will run is checked, overrides included, after Discord connects. [TIM-557, TIM-559]
- MOD-32. TIM-544 item 1: the header `session_id`. Now `session-id`, through TIM-544 itself. Open as MOD-G1.
- MOD-98. TIM-531 item 7, TIM-544 item 1: the session id goes out as `prompt_cache_key` and as a header. Now neither is sent on `openai-compat`. [TIM-559]
- MOD-45, MOD-49, MOD-75, MOD-76. TIM-533 items 10 and 12, TIM-535: a login that times out gets a subtext notice. Now the failed-turn message of a turn that ends as `LoginFailed`. [TIM-557]
- MOD-52, MOD-54, MOD-104 to MOD-106, MOD-115, MOD-116. As DIS-73. [TIM-557, TIM-559]
- MOD-42. TIM-535: a turn in another thread gets "Waiting for the login in <thread link>". Now only a turn an owner message started. [TIM-559]
- MOD-53. TIM-535: the logged-out notice. Now it gains "Scheduled runs are skipped until then." and follows the keyed rule of DIS-78. [TIM-557]
- MOD-59, MOD-101, MOD-108. TIM-542 item 6: the CLI has no deadline of its own, and a killed CLI cancels its call. Now `chad login` with no daemon has 15 minutes, and a login the daemon started outlives the CLI. [TIM-559]
- MOD-63. TIM-542 item 30: the daemon also refuses an owner call that carries a session id. Now only the CLI refuses. [TIM-550]
- MOD-46. TIM-544: chad looks for `CodexAuthError` to tell "Login timed out" from a crash. Now it tells any failed login from a crash. [TIM-557]
- MOD-78. TIM-540 items 10 and 19: three failed runs in a row pause a job. Now a run that ends as `LoggedOut`, `LoginFailed` or `UsageLimit` does not count. [TIM-557]

### 06-plugin-api.md

- API-2, API-102, API-103. TIM-530: `Plugin` is a plain Layer type. Now a branded Layer that only `Plugin.make` returns. [TIM-559]
- API-79, API-114, API-115. As SES-15. The failure is a defect whose message names `Turns.queue`. [TIM-559]
- API-10, API-104. As IMG-50, and a release can remove another package. [TIM-541, TIM-559]
- API-83. As DIS-73. [TIM-557, TIM-559]
- API-76. As SES-53, and the failed-turn message starts with the mention too. [TIM-557, TIM-559]
- API-116, API-118, API-119. As SES-166. [TIM-559]
- API-61. TIM-539 item 6: the wait for queued `Compacted` hooks, with 10 seconds in front of you. Now 40 seconds, since the queued `afterTurn` runs first.
- API-36. As OV-27, so a running turn cannot call the tools of a plugin whose code an apply changed. [TIM-547]
- API-47. TIM-530: a plugin can pass its own hook `timeout`. Now any hook still running 30 seconds into a swap is interrupted. [TIM-547]
- API-44. TIM-534 item 8: the owner is told once after 3 failures in a row of a hook. Now a keyed notice. [TIM-557, TIM-559]
- API-26. TIM-530: the plugin's ConfigProvider is installed for the load. Now also for its tool handlers, hooks and background fibers. [TIM-548]
- API-49. As OV-26. [TIM-557]
- API-64, API-65. TIM-530: hooks run from a queue, with no rule for a reload. Now the queue belongs to the plugin's name: hooks queued at a swap run on the new version, and those of a plugin removed or turned off are dropped. [TIM-547]
- API-78, API-54, API-77. TIM-540 items 15 and 19, TIM-539 item 4: `Failed.reason` with `ThreadGone` and the rest open. Now seven tags, `GaveUp` among them, and `[SILENT]` ends as `Answered`. [TIM-557]
- API-18. TIM-530, TIM-540: a plugin reaches only a thread chad already knows. Now it can start a turn in any thread that exists on the platform. [TIM-559]
- API-60. As SES-134. [TIM-557]
- API-88, API-100. As SES-125. [TIM-557]
- API-95. TIM-530, TIM-538, TIM-539, TIM-540: the API. Now the four declaration files as printed. [TIM-547, TIM-548, TIM-549, TIM-553, TIM-557, TIM-558, TIM-559]
- API-126, API-127. As SES-142, and the doc comment of `Plugin.onSession` promises it. [TIM-559]
- API-80, API-131, API-132. TIM-538 item 9: `Turns.start` from a version not yet active waits for the activation. Now every function of `Turns` does, and a `Turns` call that the Layer build waits on fails the load. [TIM-559]
- API-55, API-134. TIM-530: `TurnEnded.steers` holds the messages the owner sent while the turn was running. Now only those chad recorded as having steered it, so one still waiting at a `/stop` or a `/new` is left out. [TIM-559]
- API-61. No ticket you have not read changed it. Open as API-G10.
- API-23, API-92. Not a change: later tickets add cases, and what you agreed for a removed plugin stands.
- API-120. Not a change: new with the `LoginFailed` and `UsageLimit` reasons.
- API-128 to API-133 other than API-131 and API-132. New, and they restate nothing you agreed. [TIM-559]
- API-135. New: you did not rule on a `Turns.start` whose request cannot be saved. [TIM-559]
- API-82. Not a change: TIM-549 set it and TIM-559 confirmed it.

### 07-plugin-loading.md

- LOAD-89. TIM-538 item 10: a boot loads what `live` points at. Now the head of `applied` wins when the two differ. [TIM-559]
- LOAD-35, LOAD-83. TIM-538 item 6: an apply exports the tree to `repo/versions/<tree>/`. Now under a temporary name, renamed when complete. [TIM-559]
- LOAD-74, LOAD-88, LOAD-90. TIM-538 items 2, 3 and 10: every plugin is bundled by esbuild and compared by bundle hash. Now repo plugins only. A bundled plugin is imported with the daemon. [TIM-559]
- LOAD-56. TIM-538 item 9: a swap builds, closes the old scope and activates. Now with a gate, a 30 second drain and a 10 second close in between. [TIM-547]
- LOAD-22, LOAD-23. TIM-538 items 5 and 2: an import the image does not ship and top-level await fail the type-check. Now chad rewrites both errors to say the fix. [TIM-549]
- LOAD-21. TIM-530: no list of importable modules. Now exactly `chad`, `chad/Plugin`, `chad/Session` and `chad/Turns`. [TIM-553]
- LOAD-50. TIM-542 item 10: an apply reloads a plugin when its code or settings changed. Now settings are compared before `${NAME}` is expanded, so a new secret value does not reload it. [TIM-548]
- LOAD-52. TIM-542 item 12: deleting a plugin's file and applying unloads it. Now `"enabled": false` unloads it the same way. [TIM-548]
- LOAD-51. TIM-542 items 10 and 17: a reload keeps the old instance if the build fails. Now a plugin whose build fails after an owner was removed is unloaded. [TIM-547]
- LOAD-63. TIM-534 item 6: bundled plugins stay on in safe mode. Now one that the applied `chad.json` turns off stays off. [TIM-548]
- LOAD-64. As SES-115, with the queued hooks of a plugin caught mid-swap dropped. [TIM-541, TIM-547, TIM-553]
- LOAD-62. TIM-534 item 5: a notice names the plugins skipped at a boot. Now under the keyed rule of DIS-78, with a fixed wording. [TIM-557]
- LOAD-92, LOAD-93. TIM-542 item 11: `chad plugin new` takes only lower-case letters, digits and hyphens. Now every plugin in the repo is held to that. [TIM-559]
- LOAD-59. As API-80. [TIM-559]

### 08-apply-and-swap.md

- SWAP-11, SWAP-29, SWAP-129 to SWAP-131. As STO-62, compared at every rebuild in a live session too. [TIM-559]
- SWAP-18, SWAP-132, SWAP-133. TIM-531 item 4: a fallback update message if chad's own completion notice proved awkward to build. Now withdrawn, and the builder raises a spec change instead. [TIM-559]
- SWAP-134 to SWAP-137. TIM-531 item 4: chad announces the completion of a task that outlives a rebuild. Now in clanka's `<task ...>` form. [TIM-559]
- SWAP-125 to SWAP-127. TIM-531 items 1 and 6: an apply bumps the generation. Now also a revert, a swap and a rebuild of the MCP layer. [TIM-559]
- SWAP-141, SWAP-142, SWAP-97. TIM-542 item 19: `chad status` shows each plugin and why it was skipped. Now also a line for a plugin that kept its old version. [TIM-559]
- SWAP-143, SWAP-144. TIM-542 items 10 and 14: `chad plugin reload` and a secret change rebuild running plugins. Now also a plugin a boot skipped, and never one that is off. [TIM-559]
- SWAP-100, SWAP-152. TIM-542 item 25: `chad safe off` never refuses. Now, while `CHAD_SAFE_MODE=1` is set, `chad safe off` and `/safe off` change nothing. [TIM-559]
- SWAP-150. As SES-142. [TIM-559]
- SWAP-151. As API-80. [TIM-559]
- SWAP-59 to SWAP-61, SWAP-67, SWAP-69, SWAP-71 to SWAP-77, SWAP-140. As OV-27, in every session with a running turn. [TIM-547, TIM-548, TIM-559]
- SWAP-87, SWAP-89. As SES-54. [TIM-547]
- SWAP-26 to SWAP-28. TIM-531 items 2 and 3: when the prompt is rendered again. Now also at a persona change and a safe mode flip, with a core block, the persona and a safe mode line. [TIM-549]
- SWAP-117. As OV-26. [TIM-557]
- SWAP-43 to SWAP-45, SWAP-47. As LOAD-56. [TIM-547]
- SWAP-82. As API-47. [TIM-547]
- SWAP-86. TIM-530: no rule about a plugin's memory between hooks. Now nothing in memory is sure to survive from a tool call or `beforeTurn` to `afterTurn`. [TIM-547]
- SWAP-79 to SWAP-81, SWAP-83 to SWAP-85. As API-64, and an `afterTurn` that spans a swap goes to the current version. [TIM-547]
- SWAP-91. TIM-540 item 18: a timer whose plugin is not loaded is held. Now also one that fires while its plugin is mid-swap, until the activation. [TIM-547]
- SWAP-96, SWAP-98, SWAP-99. TIM-542 item 14: a plugin that fails to load with a new secret keeps its old instance. Now for every reload that is not an apply. The next boot skips it if it still fails. [TIM-547]
- SWAP-78. TIM-542 item 28: what a successful apply prints. Now also the sessions with a running turn it affects, how long it waited and any call it interrupted. [TIM-547]
- SWAP-55, SWAP-56, SWAP-101 to SWAP-106. TIM-542 item 6: from its commit on an apply finishes. Now a graceful stop can abandon the swap, and the next boot loads the new version. [TIM-547, TIM-550]
- SWAP-58. TIM-542 item 25: an apply in safe mode loads nothing. Now the `enabled` flag of a bundled plugin takes effect at once. [TIM-548]
- SWAP-50. TIM-530, TIM-538 item 9: `Turns.start` returns the turn's outcome. Now a background fiber of the old version loses that outcome at a swap. [TIM-547]
- SWAP-115. TIM-552, which you agreed: the check that a removed plugin's queued hook is dropped failed once when rerun. [TIM-553]
- SWAP-121, SWAP-138, SWAP-139. Not yours in person: TIM-557 item 39 said a failed command posts nothing in the thread. Now a reload that exits 1 after some plugins swapped posts its line. [TIM-559]

### 09-repo-and-recovery.md

- REC-121. As LOAD-89. [TIM-559]
- REC-120. TIM-542 item 6: from its commit on an apply finishes. Now one stopped by a full volume after its commit exits 1, and the commit loads at the next start. [TIM-559]
- REC-123, REC-124. As SWAP-143. [TIM-559]
- REC-142. TIM-534 item 9: a revert is a new commit. Now a revert to the tree already applied exits 0 with no commit. [TIM-559]
- REC-48. TIM-534 item 5: no file in the volume can stop a boot. Now no file in the repo, since `state/version` and the shard count row can. [TIM-541, TIM-553]
- REC-101. TIM-534 item 15: a notice outside a turn goes to the most recently active DM session. Now measured by the owner's latest message only. [TIM-559]
- REC-128. As SWAP-100. [TIM-559]
- Carried from the tickets' own "Changed by" comments: REC-5, REC-6, REC-58, REC-64, REC-85, REC-90 [TIM-549], REC-52, REC-53, REC-63 [TIM-548], REC-35, REC-59 [TIM-547], REC-34, REC-37, REC-96 [TIM-550], REC-67 to REC-70, REC-77 [TIM-541 and later], REC-92 [TIM-558], REC-44, REC-65, REC-74, REC-105, REC-108 to REC-111 [TIM-557].
- REC-152. As OV-8. Its "Changed by" cell is empty.

### 10-cli.md

- CLI-30, CLI-31, CLI-156, CLI-157. TIM-542 item 24: with no daemon the CLI writes only files outside the repo. Now `chad plugin new` and `chad skill new` write into `repo/work/` themselves. [TIM-559]
- CLI-73, CLI-75, CLI-163, CLI-164. TIM-542 item 8: `chad check` does all an apply does up to the commit. Now a tool description that still starts with "Replace me" passes a check with a printed line and fails an apply. [TIM-549, TIM-559]
- CLI-110. As MOD-59: killing the CLI leaves the daemon's login running. [TIM-559]
- CLI-180. As MOD-59: `chad login` with no daemon ends after 15 minutes. [TIM-559]
- CLI-38, CLI-160. TIM-537, TIM-542: `chad mcp login` goes through the daemon's one queue. Now only for the rebuild after the login. [TIM-559]
- CLI-66. As REC-120. [TIM-559]
- CLI-171. As SWAP-143. [TIM-559]
- CLI-135. As STO-179. [TIM-559]
- CLI-49, CLI-51, CLI-161. TIM-542 item 27: exit codes 0 to 4. Now also 130 for a command ended by a signal, and 125 to 127 for `chad secret run`. [TIM-546, TIM-559]
- CLI-9. As IMG-30. [TIM-553, TIM-559]
- CLI-21. TIM-542 item 5: the first message on the socket carries the chad version. Now a header on every request. [TIM-550]
- CLI-44. TIM-542 item 6: from its commit on an apply finishes. Now in a region the client cannot interrupt. [TIM-550]
- CLI-59. As MOD-63, because `env -u CHAD_SESSION` got past the daemon's refusal. [TIM-550]
- CLI-31, CLI-46, CLI-58, CLI-137, CLI-146, CLI-147. As OV-11. It works with no daemon and is open to the agent. [TIM-557]
- CLI-72. As SWAP-58. [TIM-548]
- CLI-82, CLI-169. As SWAP-100, with exit 1. [TIM-559]
- CLI-90, CLI-173. As STO-60. [TIM-548, TIM-559]
- CLI-97, CLI-101. TIM-542 item 14: `chad secret list` prints names and there is no `get`. Now `list` adds kind, note and date, and `chad secret run -- printenv` prints a value. [TIM-546]
- CLI-138. As SES-36. [TIM-546]
- CLI-116, CLI-151. TIM-542 item 17: Discord is the one kind of connection. Now also `chad connection add local`. [TIM-558]

### 11-settings.md

- SET-14. As API-26, so a `Config` read at call time never reads the daemon's process env. [TIM-548]
- SET-44, SET-45, SET-86. As LOAD-63. An unreadable `chad.json` turns every bundled plugin on. [TIM-548, TIM-559]
- SET-44. TIM-540 item 18: cron stays on in safe mode. Now off there when `chad.json` turned it off. [TIM-548]
- SET-48. TIM-540: no rule about cron's settings. Now every bundled plugin must build from its defaults alone. [TIM-548, TIM-558]
- SET-7. TIM-542 item 32: `chad serve` creates the repo with a first commit. Now with `chad.json` in it. [TIM-548]
- SET-83. TIM-542 item 10: `chad plugin reload <name>` rebuilds one plugin. Now it refuses one that is off. [TIM-559]
- SET-40, SET-95, SET-96. As STO-60. [TIM-548, TIM-559]
- SET-33. TIM-542 item 14: no reserved secret name. Now `chad secret set` refuses `CHAD_DOLLAR`. [TIM-548]
- SET-24, SET-78. TIM-542 item 14: no refusal that depends on the config. Now `chad secret set NAME --totp` is refused while an entry of `chad.json` names NAME. [TIM-546, TIM-559]
- SET-79, SET-80. TIM-542 item 14: `set` and `rm` reload the plugins whose settings name the secret. Now not one that is off, and also one a boot skipped. [TIM-559]
- SET-47. As SWAP-58, on an apply and on a revert. [TIM-548]
- SET-43, SET-66. TIM-542 item 28: what a successful apply prints. Now also each plugin's settings, a warning about keys not read, and the held timers that will fire. [TIM-548]
- SET-41, SET-70, SET-85, SET-94. TIM-542 item 19: what `chad status` shows. Now also the settings, an "off" line and a line for a deleted plugin, each with its held timers. [TIM-548, TIM-559]
- SET-54. TIM-534 item 4, TIM-542 item 11: what an apply checks. Now also a repo plugin with a bundled plugin's name. [TIM-548]
- SET-60. As LOAD-62. [TIM-557]
- SET-77. TIM-542 item 19: what `chad status` shows. Now also a "Problems" block. [TIM-557]

### 12-skills-and-mcp.md

- MCP-60, MCP-124, MCP-125. TIM-537 item 10: chad consumes the pasted URL by matching its `state`, in the thread. Now it consumes every owner message that is only a callback URL, in any thread, and says so when no login is waiting. [TIM-559]
- MCP-47, MCP-49. TIM-537 item 9: a fallback to `McpServers.layerTransports` if the clanka change stalls. Now none, since clanka 0.28.0 shipped `McpServers.layer(config, authProvider?)`. [TIM-559]
- MCP-52, MCP-116, MCP-117, MCP-136, MCP-137. As STO-19. A login for a new URL replaces the whole entry. [TIM-559]
- MCP-63, MCP-123. TIM-537 item 11: a finished login rebuilds the MCP layer. Now only when the server is still in the applied `mcp.json` at the same URL. [TIM-559]
- MCP-42, MCP-122, MCP-123. As CLI-38. [TIM-559]
- MCP-109, MCP-110. TIM-537 item 5: `mcp.json` is in clanka's format. Now a relative `cwd` fails check and apply, and an entry with none gets the daemon's `HOME`. [TIM-559]
- MCP-121. TIM-542 items 13 and 29: an unset `CHAD_SESSION` means a terminal. Now `chad mcp login` is refused when the marker is unset and there is no terminal. [TIM-559]
- MCP-56. TIM-537 item 13, TIM-534 item 15: one notice when a token refresh fails. Now the keyed notice `mcp-needs-login:<server>`, under the rule of DIS-78. [TIM-557]
- MCP-65. TIM-531 item 6: one `McpServers` instance handed to every rebuilt Agent. Now a wrapper that routes each call to the current layer. The owner sees no difference. [TIM-549, TIM-555]
- MCP-134, MCP-135. As OV-8. [TIM-559]

### 13-timers-and-cron.md

- CRON-47. As DIS-73 and MOD-52. [TIM-557, TIM-559]
- CRON-52, CRON-126, CRON-127. TIM-540 item 2: a one-shot job is deleted once it has run. Now kept, paused, when its run ended as `LoggedOut`, `LoginFailed` or `UsageLimit`. [TIM-559]
- CRON-11, CRON-66, CRON-93. As SES-15, and `cronRun` uses `Turns.queue`. [TIM-559]
- CRON-57, CRON-78, CRON-79, CRON-128, CRON-131, CRON-137, CRON-138. TIM-540 items 9 and 17: cron reconciles on load by whether a timer exists, and a one-shot with no timer has run. Now the reconcile never deletes a job. A one-shot with no timer and a past due time is left alone. [TIM-559]
- CRON-108. As SES-53. [TIM-559]
- CRON-114, CRON-115. TIM-540 item 2: a job's timezone defaults to the owner's. Now a defaulted job follows later changes of the owner's timezone. [TIM-559]
- CRON-77, CRON-89. As MOD-78, and `GaveUp` pauses a job at once. [TIM-557]
- CRON-83, CRON-84. As SES-125. [TIM-557]
- CRON-35, CRON-105, CRON-106. As STO-60. [TIM-548, TIM-559]
- CRON-82. As LOAD-63. [TIM-548]
- CRON-36, CRON-85. As SET-41. [TIM-548, TIM-557, TIM-559]
- CRON-46. TIM-534 item 15, TIM-540 item 19: a notice when a job's thread is gone. Now a normal message with the owner's mention, with no key, posted every time. [TIM-557]
- CRON-45. As API-78. [TIM-557]
- CRON-74. TIM-540 item 10: three failures in a row pause the job with a line in its thread. Now the line names the last failure's reason. [TIM-557]
- CRON-86. TIM-540 item 15: a `[SILENT]` answer is not posted. Now the turn ends as `Answered { text: "[SILENT]" }`. [TIM-557]
- CRON-87. TIM-533 item 5: a failed turn posts a message in its thread. Now a plugin-started turn that ends as `LoggedOut`, `LoginFailed` or `UsageLimit` posts nothing there. [TIM-557, TIM-559]
- CRON-88. TIM-535: no rule for a usage limit. Now a plugin-started turn ends at the first usage limit error as `UsageLimit`, with one notice. [TIM-557]
- CRON-10. TIM-530 item 5: `Turns.start`. Now its doc comment must say that the prompt states what started the turn and that nobody is there to answer. [TIM-549, TIM-559]
- CRON-28. TIM-543 decision 3: chad gives up after two starts that ended in a kill. Now such a run ends as `Failed` with `GaveUp`. [TIM-557]
- CRON-96 to CRON-104, CRON-129, CRON-130. Not changes: they pin down what you left open.
- CRON-134. New: the `timer.held` event. [TIM-559]
- CRON-57, CRON-78, CRON-79, CRON-130. Rewritten when round 3 settled CRON-G21: CRON-126 governs. [TIM-559]
- CRON-135, CRON-136. New, owned by 06-plugin-api.md. [TIM-559]
- CRON-42, CRON-43, CRON-46, CRON-47, CRON-83, CRON-87, CRON-88, CRON-107, CRON-108. Moved to the `plugin-api` slice by your ruling of 2026-11-15.

### 14-self-edit-skill.md

- SELF-54, SELF-128. As CLI-73. [TIM-549, TIM-559]
- SELF-93. As SES-15. [TIM-559]
- SELF-130. As IMG-50. [TIM-559]
- SELF-18. As LOAD-21. [TIM-553]
- SELF-88. As OV-27. [TIM-547]
- SELF-99. TIM-538 item 9, TIM-531 item 1: a running turn is never interrupted. Now a tool call still running 30 seconds into a swap is. [TIM-547]
- SELF-97. As SWAP-86. [TIM-547]
- SELF-83. As SWAP-78, and the agent says so in its answer. [TIM-547, TIM-549]
- SELF-37 to SELF-39, SELF-42, SELF-43. As SWAP-26, even with an empty repo. [TIM-549]
- SELF-44. TIM-542 item 32: `chad serve` creates the repo with a first commit. Now with an empty `persona.md` in it. [TIM-549]
- SELF-55 to SELF-58. TIM-534 item 4, TIM-537 item 1: no rule for a malformed skill. Now a check and an apply fail on a `SKILL.md` with no front matter, no `name` or `description`, a name unlike its directory, or a name used twice. [TIM-549]
- SELF-60. TIM-534 items 5 and 15: a boot skips a plugin that fails to build, with a notice. Now also a malformed skill. [TIM-549, TIM-557]
- SELF-63 to SELF-65. As LOAD-22, for a tool name clash too. [TIM-549]
- SELF-67. TIM-534 item 12: every command but the connection and owner commands is open to the agent. Now the skill tells an unattended agent not to apply, revert, purge or change safe mode unless its prompt says to. Nothing enforces it. [TIM-549]
- SELF-71, SELF-72. TIM-534 items 6 and 12: `chad safe on|off` is open to the agent. Now the skill tells it to turn safe mode off only after a fix the owner asked for, and never on unasked. Nothing enforces it. [TIM-549]
- SELF-75, SELF-76. TIM-534 item 10: the agent learns of a mount from the persona. Now it records a mount in `persona.md`. [TIM-549]
- SELF-8, SELF-121. TIM-542 item 19: what `chad status` shows. Now also effect's version and a mark on a repo skill that hides a bundled one. [TIM-549]
- SELF-102. As SET-43 and SET-41. [TIM-548]
- SELF-131 to SELF-133. TIM-537 item 1, TIM-534 item 4: chad passes clanka an explicit list of skills. Now as OV-8, and the skill says never to write an `AGENTS.md` in the repo. [TIM-559]
- SELF-134. As LOAD-92. [TIM-559]
- SELF-89. As STO-60. [TIM-559]
- SELF-78, SELF-79. Not a change: they follow TIM-552 items 7 and 1.
- SELF-19 to SELF-23. Not a change: they follow your own comment on TIM-549.

### 15-credentials.md

- CRED-46. As DIS-38. [TIM-546]
- CRED-59, CRED-73 to CRED-76. As SES-36 and SES-52. [TIM-546]
- CRED-26. TIM-542 item 14: `chad secret list` prints names. Now name, kind, note and date, and still no value. [TIM-546]
- CRED-17, CRED-21, CRED-24. TIM-542 item 14: `chad secret set <NAME>` with a value only. Now also `--totp` and `--note`, and a later `set` keeps the note. [TIM-546, TIM-554]
- CRED-19. As SET-33. [TIM-548]
- CRED-38, CRED-116. As SET-24, and the live `mcp.json` counts too. [TIM-546, TIM-559]
- CRED-111, CRED-112. As SET-79. [TIM-559]
- CRED-39, CRED-44, CRED-73. TIM-542 items 14 and 24: a value comes from stdin or a hidden prompt, and `secret` works with no daemon. Now also from a Discord modal, through `chad secret request` and `/secret NAME`. [TIM-546]
- CRED-14, CRED-28. TIM-542 item 14: no `get`. Now still none, but `chad secret run -- printenv` prints a value. [TIM-546]
- CRED-31, CRED-32, CRED-113 to CRED-115. TIM-542 item 27: exit codes 0 to 4. Now `chad secret run` passes its child's code through and uses 125, 126 and 127 itself. [TIM-546, TIM-559]
- CRED-66. TIM-542 item 27: exit 2 for bad usage. Now also when `chad secret request` is refused because `CHAD_SESSION` is unset or `daemon`. [TIM-546, TIM-559]
- CRED-37, CRED-116. TIM-537 item 7: how `${NAME}` resolves. Now an apply fails when `mcp.json` or `chad.json` names a TOTP secret. [TIM-546, TIM-559]
- CRED-7. TIM-542 item 30: `secret` is open to the agent, meaning `set`, `list` and `rm`. Now `run`, `code` and `request` too. [TIM-546]
- CRED-34. TIM-542 item 14: `set`, `list` and `rm`. Now also `chad secret code`, which prints a code and never the seed. [TIM-546]
- CRED-74. TIM-542 item 22: only `safe`, `model` and `status` have a chat form. Now `/secret` alone posts what `chad secret list` prints. [TIM-546]
- CRED-18. TIM-542 item 14: no rule on a secret's name. Now `[A-Z_][A-Z0-9_]*`, 64 characters at most. [TIM-554]

### 16-failures-logs-status.md

- FAIL-84, FAIL-212. As OV-46. Timeouts that arrive while a login is pending are left out. [TIM-557, TIM-559]
- FAIL-38 to FAIL-42, FAIL-194 to FAIL-202. As OV-11. [TIM-557, TIM-559]
- FAIL-65, FAIL-66. As OV-43. [TIM-557]
- FAIL-80. As DIS-28. [TIM-557]
- FAIL-63. As SES-106. [TIM-557]
- FAIL-156. As OV-44. [TIM-557]
- FAIL-175. As MOD-53. [TIM-557]
- FAIL-74 to FAIL-77. As MOD-78 and CRON-77. [TIM-557]
- FAIL-119, FAIL-125. As OV-29 and OV-26. [TIM-557]
- FAIL-9. As OV-41. [TIM-557]
- FAIL-208. As DIS-104. [TIM-557]
- DIS-77. The part's twelfth change, described under 04-discord.md.
- FAIL-141. As SES-125. [TIM-557]
- FAIL-136, FAIL-137. As SES-32. [TIM-557]
- FAIL-150 to FAIL-152. TIM-535, TIM-534, TIM-536: the "one notice" cases. Now one keyed rule for all, as DIS-78. [TIM-557]
- FAIL-210, FAIL-237. TIM-535: when the logged-out notice is sent. Now also when a plugin-started turn ends as `LoginFailed`, and it clears on a model call that succeeds. [TIM-559]
- FAIL-48. As DIS-73. [TIM-559]
- FAIL-168, FAIL-235. As MOD-25. The notice also clears when `/model` changes the model or a model call succeeds. [TIM-559]
- FAIL-43. As API-78. [TIM-557]
- FAIL-52. As CRON-86. [TIM-557]
- FAIL-31. TIM-530: a plugin's log lines in a tool handler go into the script's output. Now also into chad's log, with the plugin's name. [TIM-557]
- FAIL-72. As CRON-74. [TIM-557]
- FAIL-99, FAIL-100. As STO-70, with the usage totals and the times in integer milliseconds. [TIM-557]
- FAIL-147. As IMG-39. [TIM-541, TIM-557]
- FAIL-162. TIM-534 item 7: chad tells the owner about an automatic safe mode. Now the notice names the last apply and says to fix or revert it. [TIM-557]
- FAIL-163. As API-44. [TIM-557]

### 17-testing.md

- TST-48, TST-49, TST-51, TST-52. As OV-5. [TIM-558]
- TST-67, TST-68. As OV-24 and DIS-80. [TIM-558]
- TST-62. As SES-32. [TIM-557]
- TST-173, TST-174. The Coding squad's instructions, which are yours, say "only write the bare minimum amount of tests". Now tests are chosen by what chad does, and only three kinds of rule need a test of their own, which is your eighth ruling of 2026-11-15. [TIM-559]

### 18-asphodel-plugin.md

- ASP-55, ASP-85, ASP-94, ASP-100, ASP-101, ASP-113. TIM-539: three kinds of key in the plugin's store, with the `memory_forget` mark in memory. Now the mark is a fourth kind of key, `forget/<turn id>`, so a reload cannot lose it. [TIM-559]
- ASP-32, ASP-112. TIM-539 prototype: the spool replay fiber is forked while the Layer builds. Now contributed with `Plugin.background`, so two versions never replay at once. [TIM-559]
- ASP-80, ASP-114. TIM-539 item 1: the owner check refused a bot author for the three memory tools. Now any id on the owner list is the owner, and `is_bot` is still sent. [TIM-558, TIM-559]
- ASP-88, ASP-116, ASP-117. As SES-142. [TIM-559]
- ASP-91. As SES-134. [TIM-557]
- ASP-92. As API-61. Its "Changed by" cell is empty. Open as ASP-G10.
- ASP-93. As SES-115. Answered for you, section 2. [TIM-541, TIM-553, TIM-559]
- ASP-99. As API-44. [TIM-557]
- ASP-81, ASP-112. Not changes: both follow TIM-552, which you agreed.

## Your to-do list

1. Read this file. Section 2 holds the answers Jarvis gave to the questions that were yours, and you overrule any of them by saying so before the stage that builds it. Section 3 covers the two reading items of TST-165, the local dev adapter (OV-5) and how tests are chosen (TST-173).
2. Merge pull request 1 of `tim-smart/chad`, which publishes the spec under `docs/spec/`.
3. Move "Build chad v1 from the spec" (TIM-560) to todo. Its stage issues are TIM-561 to TIM-565.
4. From stage 1 to the end: rule on each rule that a builder stops as wrong or impossible to build (ORD-28, ORD-43). The build is not done while one is stopped.
5. Stage 1, `repo` slice: set branch protection with the gate's jobs as required checks (TST-165, TST-112). Without it the gate stops nothing.
6. Stage 1, `wire` slice: nothing. You ruled in chat on 2026-11-15 that chad has no nightly Discord job, no weekly dependency job and no other scheduled job, so you create no test bots and no scratch server and put no token in the repository's secrets. You do the hand checks on your own bot and your own server (item 9).
7. From the first usable build on, once: the Codex check, one turn on your login on the image you run on your own server (TST-145, TST-147). The stage 2 hand-off gives you the steps. You ruled in chat on 2026-11-15 that the builder makes the first Codex recording through the OpenAI endpoint and key of its own environment (TST-43), so the `models` slice needs nothing from you.
8. Stage 5, `live` slice, once, at the end of the build: do the hand checks on your own bot and your own server: a direct message, a click on Stop, the Enter modal, a mention in a server channel that opens a thread with a message in that thread that does not mention chad, and `chad setup` (TST-144).
9. After stage 5: merge the build pull request (ORD-3). No stage merges it.

## The tickets you have not read

**"Docker image and data volume layout" (TIM-541)**
It fixed the image, the volume tree and the stop: `node:26-trixie-slim` on Node 26 (IMG-1), with uid and gid 1000 (IMG-18). 86 rules come from it, 64 of them in 01-image-and-volume.md. You are most likely to overrule IMG-8, under which the image never carries a browser, and IMG-39, under which an older chad that finds a newer `state/version` exits 1. Its 60 second stop is question 1 of section 2.

**"Credential tools: stored logins and one-off codes for tools that sign in" (TIM-546)**
It gave secrets a kind, with TOTP seeds as one, and added `chad secret run`, `code` and `request`, the `/secret` chat command and the Enter button with its modal. 97 rules come from it, 75 of them in 15-credentials.md. Its masking of stored values is gone through your ruling on TIM-554 (CRED-12). You are most likely to overrule CRED-14, under which chad does not promise a stored value against an agent that goes looking, and CRED-46, the second button and the modal.

**"What an apply does to a plugin's work in flight" (TIM-547)**
An apply closes a gate on every plugin, drains tool calls and hooks under one 30 second deadline and activates the new versions together (SWAP-43, SWAP-45). Nothing was run in this ticket. The run was TIM-552, which you agreed. 67 rules come from it, 46 of them in 08-apply-and-swap.md. You are most likely to overrule SWAP-69, under which a running turn's call fails at once when any part of the tool's plugin bundle changed, and the 30 seconds of SWAP-45, after which a call or hook still running is interrupted.

**"Plugin settings: the settings file and turning a plugin off" (TIM-548)**
`chad.json` holds an `enabled` flag and `settings` for each plugin, with `${NAME}` filled from the secret store. An off plugin's tools are gone from each session's next turn (SET-36), its timers are held and its data is kept (SET-37). 77 rules come from it, 60 of them in 11-settings.md. You are most likely to overrule SET-44, under which a bundled plugin that `chad.json` turns off stays off in safe mode, and SWAP-58, under which that flag takes effect at once on an apply in safe mode.

**"The bundled skill that teaches chad to change itself" (TIM-549)**
It wrote the self-edit skill and what the skill rests on: `persona.md` (SWAP-26), the check of a malformed skill (SELF-55) and error messages that say the fix (LOAD-22). 150 rules come from it, 114 of them in 14-self-edit-skill.md, and 23 are your own, from your comment about `repo/examples`. You are most likely to overrule SELF-67 and SELF-71, which keep an unattended agent from applying, reverting, purging or leaving safe mode by a line in the skill alone, with nothing in the CLI behind it.

**"The chad CLI's socket, lock and session marker run for real" (TIM-550)**
It ran the socket, the lock and `CHAD_SESSION` of TIM-542. A booting daemon listens before it opens the database (IMG-62), and `chad serve` marks itself with `CHAD_SESSION=daemon` (IMG-17). 42 rules come from it, 25 of them in 10-cli.md. You are most likely to overrule CLI-59, under which only the CLI refuses an owner command inside a session, and CLI-21, under which a CLI of another version is refused for everything but `chad status` and `chad health`.

**"The chad image built and run" (TIM-553)**
The image built and ran on amd64 and arm64. It made five changes to the design, among them `shardsPerGroup: 1` (IMG-64), and left the three questions that section 2 now answers. 34 rules come from it, 14 of them in 01-image-and-volume.md. Beside those three answers, you are most likely to overrule IMG-64, under which a daemon that finds another shard count refuses to start.

**"Credential tools run on real clanka and a browser sidecar" (TIM-554)**
Decisions 1 and 2 are your own: the commands and the `credentials` skill never print a stored value, and nothing is redacted. Architect agreed the rest. 33 rules come from it, 23 of them in 15-credentials.md, and 25 are Architect's. You are most likely to overrule the reading of "no redaction" as covering chad's own outputs (CRED-12, DIS-34, asked as CRED-G1 and DIS-G21), and CRED-18, which limits a secret's name to `[A-Z_][A-Z0-9_]*` and 64 characters.

**"The MCP layer rebuild run with calls in flight" (TIM-555)**
It ran a rebuild of the MCP layer under load. Calls made during a rebuild are held at a gate, and a turn that starts during one does not wait and takes the last layer that finished connecting (MCP-89). All 13 of its rules are in 12-skills-and-mcp.md. You are most likely to overrule MCP-92, under which a turn starts with no MCP at all once the 120 second backstop passes, and MCP-86, under which a server that a rebuild added cannot be called until each session's next turn.

**"What the owner sees when things go wrong" (TIM-557)**
It decided failures, the log and `chad status`: seven failure reasons (API-78), `chad logs` (FAIL-38) and notices with a key (FAIL-150). 275 rules come from it, 188 of them in 16-failures-logs-status.md, and all are Architect's. It changes twelve things you agreed in person (FAIL-G24). You are most likely to overrule FAIL-84, which ends a turn after 15 minutes of model silence, and FAIL-156, which makes a notice outside a turn a normal message that mentions you in a server thread.

**"How chad is tested once built" (TIM-558)**
Nothing was built or run for it. The runner is vitest with `@effect/vitest`, CI is GitHub Actions and a `local` connection kind stands in for Discord (TST-48). 218 rules come from it, 165 of them in 17-testing.md. You ruled in chat on 2026-11-15 that its Codex list is cut to one check, the login, which you do by hand on your own server (TST-145, TST-147). You ruled out its scheduled jobs in chat on 2026-11-15, the nightly Discord job of TST-143 among them, and those rules are withdrawn.

**"Assembling the spec: where it lives and the build order" (TIM-559)**
It is the assembly ticket. 692 rules name it first, in every part, most in 16-failures-logs-status.md (93), 02-storage.md (57) and 10-cli.md (56). 468 are rulings on gaps in the parts, 99 are from round 2, 96 from round 3, 19 from rounds 1 and 4 and 9 from the cold read. Round 2 also made each of the 63 rows of the event names table in 16-failures-logs-status.md a rule with its own id, FAIL-244 to FAIL-306. The rounds kept the rule ids, vendored effect under `vendor/` (OV-18) and put `flake.nix` in the chad repo (ORD-38). Of what is left, you are most likely to overrule SES-167, a session of kind `channel` in a plain server channel, and STO-179, which lets `chad restore` write onto a volume that `chad serve` has booted on. This list also named TST-173, one test for each rule id, which your eighth ruling of 2026-11-15 replaced.
