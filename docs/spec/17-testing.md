# Testing

This part says how chad is tested once it is built: which rules need a check that fails when they are broken, and how the scenarios that run the rest are built (TST-173). It covers the six layers of the suite, the seams and fakes that make the daemon testable, the rules every test follows, what gates a pull request, and the checks that need a real Discord bot or a real Codex login. It leans on every other part for the rules under test, and most on 01-image-and-volume.md, 04-discord.md, 05-model-and-login.md, 14-self-edit-skill.md, 16-failures-logs-status.md, 18-asphodel-plugin.md and 19-build-order.md. Nothing in this part has been run, and it does not contain the tests themselves.

Three words are used throughout. A scenario is one test that drives a daemon through one flow, such as a message in and an answer out. The driver is the test code that starts the daemon, sends it events, holds the fakes and reads the results. The harness is the driver together with the fakes and the scripts that every scenario shares.

## Runner and continuous integration

- **TST-1** The test runner is vitest with `@effect/vitest`, for every layer that runs on a machine, which is layers 1 to 5 below. `@effect/vitest` is an `@effect/*` package, so it comes from the vendored snapshot with the others and not from npm (see 01-image-and-volume.md).
- **TST-2** Continuous integration (CI) runs on GitHub Actions.
- **TST-3** There is one vitest project per layer. Each project uses `pool: forks`, and each scenario starts its own daemon.
- **TST-4** The process suite and the image suite are vitest files that start processes and run `docker`. The repository holds no bash check scripts.
- **TST-5** (a) CI runs the Node version that the Dockerfile names. (b) It installs effect from the tarballs under `vendor/` and clanka from npm at the version the lockfile pins, never from pkg.pr.new (see 01-image-and-volume.md).
- **TST-204** The repository uses oxlint and prettier, configured as in `tim-smart/lalph`: an `.oxlintrc.json`, and a `.prettierrc.json` with `semi` set to false. The gate runs `oxlint` and `prettier --check .`. The typecheck is `tsc`. chad takes no patch of the compiler that adds Effect's diagnostics, neither the `effect-language-service patch` step of that repo nor `@effect/tsgo`, so the compiler of the gate is the one the image runs at an apply. The linter and the formatter were inferred from Tim's other TypeScript repos, four of which run oxlint and all of which carry prettier.

## Stages and slices

The build order is in 19-build-order.md. This part uses two of its words, because the rule ids are checked against them. A slice is a named piece of the build, and every rule's row in its Provenance table names the slice in which the rule is built. A stage is a run of slices that is built as one issue.

- **TST-199** The build is five build issues, called stages, that run one after another and share one branch and one pull request. Each stage is a run of slices, in the order of the table below (see 19-build-order.md).
- **TST-200** The first usable build is the end of stage 2, after the `models` slice. From there Tim can run the image on his own server.

| Stage | Slices, in build order |
| --- | --- |
| 1 | `repo`, `harness`, `wire`, `cli` |
| 2 | `turns`, `kills`, `failures`, `discord-ui`, `models` |
| 3 | `plugin-api`, `loader`, `apply` |
| 4 | `settings`, `skills-mcp`, `timers-cron` |
| 5 | `backup`, `image`, `bundled-skills`, `asphodel`, `live` |

## Rule ids and pending rules

Every rule in the spec carries an id such as `SES-12`. Tests are chosen by what chad does and not by rule id (TST-173), and a test names the ids of the rules it covers. A script in CI reads the spec's ids and the ids the tests name. It fails on a test that names an id the spec does not have and on a `skip`, `todo` or `only`, and it keeps an index from each rule to its tests. It does not fail on a rule that no test names. Review is what says a rule is built: the reviewer of a slice reads the slice's rules from the script's list mode against the code, so a rule can be missed without the gate failing.

Each rule also has a kind, which its Provenance row gives. A `rule` is chad's own behaviour, which a test can break. A `fact` is what a dependency does, such as clanka, effect, dfx, Discord, Node, Docker or SQLite, and a rule rests on it. A `definition` is a term, a reason or an overview sentence with nothing to test. A rule about how the suite and the build are run is a `definition` too.

- **TST-6** Every rule in the spec has a stable id. Ids are assigned in the spec and are never renumbered or reused.
- **TST-7** A test names the rule ids it covers in its title, where it covers any.
- **TST-8** The rule-id script finds the rule ids that tests name in the output of `vitest list --json` over all projects. It does not search the test source for ids, because a search of the source would count skipped tests and files that belong to no project. A test counts as a rule's test only when the pull request gate runs it.
- **TST-9** Withdrawn.
- **TST-10** The rule-id script fails when a test names an id the spec does not have.
- **TST-11** The rule-id script fails on any `skip`, `todo` or `only`. How it finds them is the builder's, because the output of `vitest list --json` may leave a skipped test out, and TST-8 limits only how rule ids are found.
- **TST-12** The rule-id script writes an index from each rule to its tests and CI keeps it as an artifact.
- **TST-13** Withdrawn.
- **TST-14** A rule is pending while its slice is not delivered. Pending is derived from the Slice column of the rule index and from the delivered file, which lists the slices that are delivered (see 19-build-order.md). No list of pending rules is kept by hand. The only entries written by hand are the held rules of that file, each a rule of a delivered slice that rests on a later slice. The build is done when no rule is pending.
- **TST-15** Neither local command (TST-133 and TST-136) runs the rule-id script's comparison of the spec's ids with the tests' ids. The comparison gates only in CI, because it needs every project and so needs Docker. The script does not refuse to run outside CI, so a builder can run the comparison by hand. Its `show` mode (TST-194) runs anywhere.
- **TST-16** A rule that was agreed with Architect standing in for Tim is tested like any other rule. If Tim reopens one, its id finds its tests.
- **TST-17** Each stage issue says in words that it asks for tests, chosen as TST-173 says, and names its slices. The rules a stage builds are the rules tagged with those slices, and no limit is set on how many rule ids a stage holds. The builders' briefs tell them not to create tests unless explicitly asked, so an issue that does not ask gets none.
- **TST-18** The reviewer of a stage checks that no rule tagged with the stage's slices is pending without a recorded reason. The recorded reason is the rule's entry in the list of held rules (see 19-build-order.md).
- **TST-19** There is no coverage number and no coverage gate, by line or by rule id.
- **TST-20** Withdrawn.
- **TST-170** The spec lives in chad's repository under `docs/spec/`, so the rule-id script reads the spec's rule ids in CI from the repository itself.
- **TST-171** A script builds one index of every rule from the Provenance tables of the parts. Each row holds the rule's id, its part, who agreed it, its support, the tickets that changed it, its kind and its slice, and this rule index is what the rule-id script reads. The index is generated in CI and is not committed, so that two changes never conflict on it. The Provenance tables are the only source of rule ids. A rule's text may be a bullet or a table row, and a gap id such as `TST-G1` has no Provenance row and is not a rule.
- **TST-172** A rule whose slice is `-` is never pending. Only a definition and a withdrawn rule have that slice.
- **TST-173** Tests are chosen by what chad does and not by rule id. A slice has scenarios that run each of its features the way the owner, a plugin, the model or the CLI reaches it, and one scenario passes through many rules. A rule needs a test that fails when the rule is broken only if it is one of three kinds: (a) it decides who chad obeys or what chad keeps secret, (b) breaking it loses or damages what is on the volume, (c) it says what happens on a kill, a crash, a race, a lock or a timeout. A bug that review or the owner finds gets a regression test with its fix. No other rule needs a test, and no number of tests is set.
- **TST-174** Each stage issue states how TST-173 chooses tests in its own text, because an agent may read only its own issue. The `AGENTS.md` at the root of chad's repository says that tests name rule ids and how to look a rule up (see 19-build-order.md for the rest of that file).
- **TST-175** A change to a rule also changes the tests that name the rule's id, or pends them with the reason, in the same change.
- **TST-176** A stage is done when its slices are implemented, reviewed and in the delivered file, and every rule of those slices is built, held or stopped. Tim merges the one pull request after stage 5.
- **TST-190** A test may name one statement of a rule by a letter after the rule's id, such as `SES-12a`, and the rule-id script accepts that form for a letter the rule's text marks. Nothing requires a test for each letter.
- **TST-191** A rule that holds several statements has them marked (a), (b) and so on in its text when one of them is held, in the same change. The letters are the only way a rule is split, and the letters that exist stay. A rule is withdrawn only when it goes away, never to replace it with new ids.
- **TST-192** A fact takes the slice of the first rule that rests on it. A fact needs no test.
- **TST-193** The slice `-` is set only while the spec is assembled. Moving a rule to `-` afterwards is a change to the rule.
- **TST-194** The rule-id script has a `show <id>` mode that prints one rule, so that a builder can read a rule without loading the whole spec.

Node's `NODE_V8_COVERAGE` collects coverage across child processes. It has not been run over this layout.

## The six layers

The layers are named for what is real in each. The table gives the overview and the rules after it give what each layer must hold.

| Layer | Name | What is real | What the test supplies | On the pull request gate |
| --- | --- | --- | --- | --- |
| 1 | Types | `tsc` over the package and over fixture plugins, and the built declaration files | Fixture plugins, among them files that must not compile | Yes |
| 2 | Unit | Pure code under `it.effect` with the test clock | Inputs and expected values | Yes |
| 3 | Daemon scenarios | The daemon in one process on live time, built from its own composition root. clanka's `Agent` and executor, `SingleRunner` over a SQLite file, the plugin loader, the socket and the CLI, and local MCP server processes are all real. | The chat platform, the network and the durations | Yes |
| 4 | Process scenarios | The same daemon as a child process that the driver kills or stops at a chosen event and restarts on the same volume | The same three, with the chat state and the model script held in the driver | Yes |
| 5 | Image | The built image on a real Docker engine, with the real `chad serve` | The local platform and the fake model server, in a second container | Yes on amd64 |
| 6 | Live | A real Discord gateway or a real Codex login | Tim's own bot and Tim's login | No |

- **TST-21** Layer 1 runs `tsc` over the package and over fixture plugins.
- **TST-22** Layer 1 holds six files that must fail to compile, one for each deliberate mistake in the table below. Each file asserts the error code and the service the error names, so that a file that fails on a typo does not pass.

| Deliberate mistake | Caught by |
| --- | --- |
| A hook that still needs the plugin's own service | `Plugin.make`, which names the missing service |
| A toolkit with no handlers | `Plugin.make`, which names the missing service |
| A tool dependency that nobody provides | `Plugin.make`, which names the missing service |
| `Layer.provide` applied after `Plugin.make` | `Plugin.make`, which names the missing service |
| A handler that returns the wrong type | The handler's own type |
| A hook that returns the wrong type | The hook's own type |

In the plugin API prototype the first four failed with `Type 'Own' is not assignable to type 'Services'` (see 06-plugin-api.md).

- **TST-23** Layer 1 checks that the `chad` package exports exactly its four modules, which are `.`, `./Plugin`, `./Session` and `./Turns` (see 01-image-and-volume.md).
- **TST-24** Layer 1 runs the doc comment check of TST-88.
- **TST-177** Once the `plugin-api` slice is delivered, layer 1 type-checks the signature code blocks of the spec against the `chad` package.
- **TST-25** Layer 2 tests pure code under `it.effect` with the test clock. It holds at least the following: the `${NAME}` expander against clanka's, cron next-run times with timezones and daylight saving changes, `chad.json` and `mcp.json` validation, the splitting of an answer into Discord messages, the status message's text, TOTP against the RFC vectors, secret names, log rotation, and each message template against the spec's wording.
- **TST-26** Layer 3 runs the real daemon in one process, which is the test's own (TST-203), on live time, built from its own composition root, with the chat platform, the network and the durations supplied by the test. Sessions, turns, hooks, the plugin swap, the MCP rebuild, timers, cron, credentials and the CLI are tested here.
- **TST-27** Layer 4 runs the same daemon as a child process that the driver kills or stops at a chosen event and restarts on the same volume. A resumed turn, the give-up, the boot counter and safe mode, the lock, the stop, backup and restore, migrations and an unusable database are tested here.
- **TST-28** In layer 4 the chat state and the model script live in the driver, because the process being killed cannot hold them.
- **TST-29** Layer 5 runs the built image on a real Docker engine, with the real `chad serve`.
- **TST-30** Layer 6 holds the checks that need a Discord bot or a Codex login. None of it gates a pull request.

## How the daemon is made testable

The product carries no test code. Three seams make that possible. The daemon is started by one function that takes its outside world as inputs. The model is replaced at the network, so that everything chad does around a model call still runs. Every duration sits in one service, so that a test can shorten all of them together.

- **TST-31** One function, `runDaemon(inputs)`, owns the parts of the daemon that belong to the process: signals, the 60 second exit timer, exit codes and `CHAD_SESSION=daemon` (see 01-image-and-volume.md and 10-cli.md).
- **TST-32** `chad serve` and the test entry file are a few lines each, and both call `runDaemon`. Layers 3 and 4 start the daemon from the test entry file and layer 5 starts it with `chad serve`.
- **TST-33** The inputs of `runDaemon` are the four in the table below, together with the connections of TST-201 until the `cli` slice is delivered and the plugins of TST-202 from the `plugin-api` slice on. It has no other input (TST-203).

| Input | What it is | What `chad serve` passes | What the test entry passes |
| --- | --- | --- | --- |
| The chat layer | A function from one connection, which is its name, its kind, its token and its owner ids as 02-storage.md stores them, to the Layer that provides that connection's chat platform. The daemon calls it once for each connection it holds, and again when a connection is swapped while it runs (see 10-cli.md). | The product's own function. It gives the Discord adapter on the real gateway for the kind `discord` and the adapter client of TST-49 for the kind `local`. | For the kind `local` in layer 3, a Layer backed by the `ChatTest` the driver holds, in the same process and with no socket between them. For the kind `local` in layer 4, and in a layer 3 scenario that tests the client itself, the product's adapter client, with the local platform held by the driver. For the kind `discord`, the product's Discord adapter over the scripted socket of the wire slice. |
| An `HttpClient` | effect's HTTP client service, which every model and login request goes through | The real client | A client that sends the two Codex hosts to the fake model server |
| A WebSocket constructor | effect's `Socket.WebSocketConstructor` service, which clanka's Codex WebSocket transport needs | The real constructor | A constructor that connects to the fake model server |
| The durations | The values of the `Timings` service, as one complete set | The defaults, which are the spec's values | The defaults multiplied by one scale factor (TST-73) |

- **TST-201** Until the `cli` slice is delivered, `runDaemon` takes a fifth input, the connections. It is a list in which each entry holds what a stored connection holds, which is its name, its kind, its token unless the kind is `local`, and its owner ids (see 02-storage.md). The daemon takes its connections and its owner allowlist from this list and reads no stored connection. `chad serve` passes an empty list, so the image boots with no chat platform, and the allowlist scenario of TST-164 passes its own. The `cli` slice removes the input. From then on the daemon reads its connections from storage only, and a scenario adds its connection and its owners with the `chad connection` and `chad owner` commands, as an owner does.
- **TST-202** From the `plugin-api` slice on, `runDaemon` takes one more input, the plugins. It is a list in which each entry is a plugin's name and a value made with `Plugin.make` (see 06-plugin-api.md). The daemon treats a plugin handed in this way as it treats a bundled plugin, and builds it through the same scope, the same deadline and the same swap code as a plugin from the repo (see 07-plugin-loading.md). The test entry passes its fixture plugins in this input, which is how the plugin API is tested before anything loads from the repo. The input stays when the `loader` slice arrives.
- **TST-203** `runDaemon` takes nothing else. The data path, the model setting, the log level and every other variable of the environment table in 01-image-and-volume.md are read from the process environment, in the test entry as in `chad serve`. A scenario sets the model with `CHAD_MODEL`, `CHAD_OPENAI_API_URL` and `CHAD_OPENAI_API_KEY` (see 05-model-and-login.md), and there is no input for the model, because one would move the seam of TST-34. In layer 3 the daemon runs inside the test's own process. So the driver sets those variables in its own environment before it starts the daemon, the scenarios of one file run one after another, and the driver removes `CHAD_SESSION` from the environment of every `chad` command it starts, which the CLI would otherwise refuse as the agent's (see 10-cli.md). The daemon reads these variables when `runDaemon` starts, never at module load, so two daemons started one after another in one process can have different data paths. The prototype wiring in 10-cli.md reads `CHAD_DATA` in a module-level constant, which daemon code must not copy.
- **TST-209** The client has one entry too, the function `runCli(inputs)`, which the bundled bin calls with the real values. Its inputs are the words of the command line after `chad`, an `HttpClient`, which every request the CLI makes by itself goes through, and the durations as one complete set of `Timings`. It has no other input, and it reads the environment from the process when it starts, as `runDaemon` does. It returns the exit code and never exits the process, and it owns the signals of a client command (see 10-cli.md). A scenario starts the real bin as a child process, with `CHAD_DATA` set and no `CHAD_SESSION`, as the owner's shell does. For a command that reaches the network or that needs a shortened duration it calls `runCli` from `dist` in the test's own process instead.
- **TST-34** The model seam is the network and not the model layer. With the model layer swapped, `chad model`, `/model`, the trial request, the token check and the whole login flow would sit outside what layer 3 runs.
- **TST-35** One fake model server serves layers 3, 4 and 5. It is an HTTP server that the test starts.
- **TST-36** The fake model server is scripted by call index, and a script can hold a response until the test releases it.
- **TST-37** The fake model server speaks the `openai-compat` endpoint and the Codex device-code, token and model endpoints, over HTTP and over WebSocket.
- **TST-38** The test entry rewrites the two Codex hosts to the fake model server. clanka hardcodes the Codex URL and the auth URL, and both go through effect's `HttpClient` service, which is what makes the rewrite possible.
- **TST-39** Scenarios run on `openai-compat` by default. The named subset in the table below runs on the Codex side of the fake.

| Scenario on the fake's Codex side | Why it is in the subset |
| --- | --- |
| The login flow | It is part of the Codex login and request path |
| The order of the token check | It is part of the Codex login and request path |
| The `session-id` header and one client per session | It is part of the Codex login and request path |
| The hidden retry parts | It is part of the Codex login and request path |
| A login in the middle of a turn | It is part of the Codex login and request path |
| A usage limit, as 16-failures-logs-status.md specifies it | It is part of the Codex login and request path |
| A kill and a resumed turn | It differs by transport or by provider |
| An Agent rebuild that keeps the session's model layer | It differs by transport or by provider |
| The socket idling out and reconnecting | It differs by transport or by provider |
| Stop during a streaming response | It differs by transport or by provider |
| One sub-agent | It differs by transport or by provider |
| Compaction | Codex rejects `max_output_tokens`, so the summarizer runs with no output cap there |

- **TST-40** The fake's Codex side refuses what Codex is known to refuse, which is `max_output_tokens`, an expired token and a model that is not accepted. A fake that accepted everything would pass requests the real service rejects.
- **TST-41** The frames of the fake's Codex side come from a recording kept in the repository, with tokens and the account id stripped.
- **TST-42** Each live Codex run records again and compares the shapes of the two recordings, which means event types and keys and not values. A difference fails that live item.
- **TST-43** If the archive of the Codex login prototype does not hold the server's frames, the first recording is made on Tim's login, in the `models` slice, when the fake's Codex side is written.
- **TST-44** The image layer stays on `openai-compat`. The shipped binary cannot be pointed at a fake Codex host, and chad gets no test certificate authority and no host entries to make that possible.
- **TST-45** A kill point is made by holding something outside the core, which is a model response, a fixture plugin's hook or an MCP server. The daemon gets no pause points.
- **TST-213** Withdrawn.
- **TST-46** Layers 3 and 4 import the built package from `dist`, not chad's source through vite. A plugin's imports are answered by the host's `require`, so source loaded through vite could give a plugin a second copy of `chad/Plugin`.
- **TST-47** One layer 3 scenario asserts that the running daemon holds one copy of `chad` and one copy of `effect`.

The extracted archive of the Codex login prototype holds turn logs and token counts. No server event name appears in any of its logs, so TST-43 applies as far as the archive shows. The fake's Codex side can drift from the real service because it is written from a recording, and TST-42 is what catches the drift.

## The local adapter and the local platform

effect/chat's `ChatTest` is a whole chat held in memory. It can deliver a message, a mention, a direct message, a button click, a slash command and a modal submit, and a test reads what was posted through `messages(thread)` and `calls`. It can fail the next call with `failNext` and refuse files with `refuseFiles`. It simulates no gateway, no resume, no replay and no rate limits.

`ChatTest` keeps its threads in memory and fails an operation on a thread it does not know with `NotFound`. If it ran inside the daemon, every thread would be gone after a restart, a resumed turn would post into `NotFound`, and neither layer 4 nor layer 5 could check the chat side of a restart. So `ChatTest` runs outside the daemon, in a process the tests call the local platform, and the daemon holds only a client.

- **TST-48** The local dev adapter is a connection kind, added with `chad connection add local` (see 10-cli.md for the `connection` commands).
- **TST-178** The synopsis of `chad connection add local` and the way an owner is named on the local platform are in 10-cli.md.
- **TST-49** The adapter inside the daemon is a client. It forwards the adapter's operations over effect RPC to a platform that listens at `run/local.sock`, and it retries while nothing is listening there.
- **TST-50** The path `run/local.sock` is fixed. No option or environment variable moves it.
- **TST-51** The local platform is `ChatTest` plus that RPC server. It lives in the repository's test support and in a short developer script that lets a person type into it.
- **TST-52** The local platform is not in the image. The image carries only the adapter client, which does nothing until a `local` connection is added.
- **TST-53** chad ships no interactive chat client.
- **TST-54** The local platform delivers again an event the daemon did not acknowledge, as `DiscordChat.layerDispatchHook` does for Discord.
- **TST-55** `ChatTest` takes its limits and capabilities from the Discord adapter's own descriptor, not from numbers typed again in the tests. At `ChatTest`'s default limit of 4000 characters the five-message split would be tested against the wrong number, because Discord's limit is 2000.
- **TST-56** In layers 3 and 4 the driver holds `ChatTest` directly, so `failNext`, `refuseFiles` and `calls` need no test verbs in the product.
- **TST-57** Scenarios reach the chat fake and the model fake through one interface with two implementations. One is in-process, for layers 3 and 4. The other goes over a test-only RPC group that lives in test support next to the adapter operations, for layer 5. A few layer 3 scenarios then run against the image unchanged.
- **TST-58** In layer 5 the local platform and the fake model server run in a second container. It uses the same image, the default uid and the same named volume, with one bundled file from the repository mounted read-only.
- **TST-59** If the second container does not work, the fallback is the local platform on the host over a bind mount, started as the container's uid. The product does not change in either arrangement.
- **TST-210** The image layer knows that the daemon is up from the `boot.ready` line on the container's standard output, in `harness` and in every later slice, because that line is there before the engine's first health check. From `cli` on, the scenario of TST-58 also asserts that the engine reports the daemon's container healthy, after `chad health` has passed inside it. Docker runs the image's health check by itself. podman leaves it to a systemd timer, which a machine may lack, so where the engine is podman the test tells it to run the check.
- **TST-211** In layer 5 the daemon's container and the second container are on one network of the engine that is internal, so neither reaches a host outside it, and no port is published. The daemon's container is given the volume, the network and the three model variables of TST-203, with the second container's name as the host of the URL, and nothing else. The second container starts once the daemon is up, because the daemon makes `run/`. The test on the host reaches the test-only RPC group through the engine's `exec` in the second container, which joins the command's standard streams to `run/local.sock`. The scenario keeps what the two containers wrote, the daemon's log and the database in its directory under the run id (TST-80), and the gate's `image` job uploads those directories when it fails (TST-81).

The second container needs no uid matching, no `sudo` and no socket across a bind mount, and it behaves the same on Docker and podman. It holds the fake model server because a daemon in a container otherwise has to reach the host, and the way to do that differs by engine. Neither arrangement has been run.

## The Discord wire slice

Running the daemon on `ChatTest` leaves out what only Discord's side of effect/chat does. The wire slice puts that back for a small set of scenarios without a real Discord. It has not been run by anyone for chad. Its scenarios with kills need the process driver of layer 4, which the `kills` slice delivers, so they are written then. The dfx modules that effect's own gateway test imports are all in the published dfx 1.1.1 package, and what chad has to rewrite is effect's test helper of 169 lines and its fixtures.

- **TST-60** (a) A Discord wire slice runs in layers 3 (b) and 4. (a) It runs the real `DiscordChat.layerDispatchHook` and a real dfx shard over a scripted `DiscordWS` and a fake Discord REST server. (b) It has about a dozen scenarios, some of them with kills.
- **TST-61** The wire slice covers what only Discord's side does: (a) normalizing (`isSelf`, `isBot`, webhook ids and mentions), (b) the shard state row surviving a restart, (c) a resume against a fresh identify with the catch-up, (d) the replay through `layerDispatchHook`, and (e) `startThread` as get-or-create on Discord's REST (see 03-sessions-and-turns.md and 04-discord.md).
- **TST-62** The handler rules run in layer 3 on any platform, because `ChatTest.deliver` calls the same handler. They are the owner and mention check, the thread opened before the save, and what the handler does when the save fails. On a full disk it answers in the thread and accepts the event, and it refuses the event only when that reply cannot be posted either (see 16-failures-logs-status.md).
- **TST-63** The `wire` slice comes straight after the `harness` slice, inside stage 1 (see 19-build-order.md), so that the answer is known before the Discord rules of the later slices are built.
- **TST-64** If a real dfx shard cannot be driven over a scripted socket with published modules only, the `wire` slice ends with a record of what blocked it. Every rule tagged `wire`, in any part, whose only test would run over the scripted socket then rests on the hand checks of TST-144, the subjects of TST-61 among them. No new decision is needed. The handler rules of TST-62 are not affected.
- **TST-196** The wire slice is where the log events `chat.connected`, `chat.disconnected` and `chat.refused` get their tests (see 04-discord.md). The three depend on what dfx exposes, which is not known until the wire slice runs.
- **TST-198** One wire scenario removes a connection and adds another bot under the same name while no daemon runs, so that the new bot starts with the old bot's stored resume state (see 10-cli.md). The scripted gateway answers the resume with an invalid session, as Discord does, and the scenario asserts that dfx identifies again.

## The owner check

The allowlist of owners is chad's one security rule, so each way in gets a test from someone who is not an owner.

- **TST-65** The allowlist gets a negative test for every inbound kind from a non-owner in layer 3. The kinds are a direct message, a mention, a Stop click, an Enter click, a modal submit and each slash command.
- **TST-66** The allowlist gets one negative test in the wire slice.
- **TST-67** chad drops a message that is `isSelf` before the owner check. Without that order, chad's own id on the owner list would make every answer in a thread start a turn (see 04-discord.md). On `ChatTest` the scenario delivers a hand-made event whose author is marked `isSelf` and whose id is on the owner list. How Discord's side sets the mark is what the wire slice covers (TST-61).
- **TST-68** Apart from the `isSelf` drop, the allowlist is by id and nothing else. An id on the list is an owner whether or not it is a bot, there is no flag for bots, and `chad owner add` says nothing special about one. A webhook is an owner only if its id was added.
- **TST-69** The docs say in one sentence, where they describe owners, that a webhook id on the list makes everyone who holds the webhook URL an owner. The docs are the user documentation that 00-overview.md defines. This is the same sentence as the rule in 03-sessions-and-turns.md, so one test that finds it carries both ids.

`ChatTest`'s own helpers mark every message they make as not `isSelf`, and its `deliver` takes an event as it is given. That was read in effect's source and was not run.

## Time and the Timings service

`SingleRunner` over SQLite has never been run under effect's test clock, and effect's own cluster tests on SQL storage run on live time. So layers 3 and 4 run on live time and shorten chad's durations.

- **TST-70** Every duration the spec names lives in one `Timings` service, with the spec's values as its defaults. `Timings` holds one value for each row of the first durations table below, with these exceptions. The 40 second row of the swap has no value, because it is the sum of the drain and the close. The stop's queued hooks row is held as the point 50 seconds from SIGTERM, and the last two rows of the stop are one value, the point 60 seconds from SIGTERM. The status row is two values, 24 hours and 7 days. The prune's time of day is held as an hour and a minute, and not as a length.
- **TST-71** A unit test checks each default of `Timings` against the durations table below. The test detects a change, and the table says what the value should be. The 40 seconds of a swap is checked as the sum of its two values.
- **TST-72** The shipped binary has no setting, flag or environment variable that changes a `Timings` value.
- **TST-73** Tests shorten the `Timings` values by one scale factor, so the orderings between them hold. The 30 second drain stays longer than the 10 second close, and the 15, 35 and 10 seconds of a stop stay inside its 60. The two points of a stop that are measured from SIGTERM are multiplied like every length. The prune's time of day is not a length, so the factor leaves it alone, and a scenario that tests the prune passes a time of day of its own.
- **TST-212** A scenario may give the session idle time or the message retention a length of its own, apart from the factor. At the factor they are 90 seconds and 72 minutes, which no test can wait for, and no ordering with another length rests on either.
- **TST-74** clanka's own timeouts stay at their real length in every layer. They are the 30 second MCP connect and the 4 seconds per stdio server.
- **TST-75** Layers 3 and 4 run on live time with shortened durations.

Layers 3 and 4 test the stop's order and its limits on shortened durations (TST-73, TST-75), and that is the stop's only cover. The daemon in the image runs `Timings` at its defaults (TST-72), so no image test stops a daemon that has requests in flight or hooks queued. The 35 seconds for queued hooks is then never run at its real length, which Tim accepted in chat on 2026-11-15.

The first table holds the durations chad sets, which are the ones `Timings` holds. Each value is the one the named rule states, and the tickets behind it are in that rule's row of its own part's Provenance table.

| Duration | Value | Stated in |
| --- | --- | --- |
| Plugin swap, drain of calls and hooks in flight | 30 seconds | 08-apply-and-swap.md (SWAP-45), 06-plugin-api.md (API-47) |
| Plugin swap, wait for an interrupted call or hook to stop | Up to 1 second, taken out of the close deadline | 08-apply-and-swap.md (SWAP-46, SWAP-48) |
| Plugin swap, close of the old versions' scopes | 10 seconds | 08-apply-and-swap.md (SWAP-47) |
| Plugin swap, longest wait of a turn that starts during it | 40 seconds, the sum of the drain and the close | 08-apply-and-swap.md (SWAP-89), 03-sessions-and-turns.md (SES-54) |
| Hook budget, prompt chunk | 2 seconds | 06-plugin-api.md (API-42) |
| Hook budget, `beforeTurn` | 5 seconds | 06-plugin-api.md (API-42) |
| Hook budget, `afterTurn` | 30 seconds | 06-plugin-api.md (API-42) |
| Hook budget, `onSession` | 10 seconds | 06-plugin-api.md (API-42) |
| One plugin's Layer build | 30 seconds | 07-plugin-loading.md (LOAD-14), 09-repo-and-recovery.md (REC-40) |
| Stop, wait for requests in flight | 15 seconds, which is cluster's `entityTerminationTimeout` | 01-image-and-volume.md (IMG-83), 03-sessions-and-turns.md (SES-110) |
| Stop, queued hooks | Until 50 seconds from SIGTERM, which is 35 seconds after the requests' 15 | 01-image-and-volume.md (IMG-83) |
| Stop, close of plugin scopes and then the MCP layer | Until 60 seconds from SIGTERM, which is the last 10 seconds | 01-image-and-volume.md (IMG-83) |
| Stop, forced exit with code 1 | 60 seconds from SIGTERM | 01-image-and-volume.md (IMG-82) |
| MCP rebuild, drain of calls in flight | 30 seconds | 12-skills-and-mcp.md (MCP-70) |
| MCP rebuild, wait for each interrupted call to stop | 1 second | 12-skills-and-mcp.md (MCP-130) |
| MCP rebuild, pause between interrupting calls and closing the old layer | 250 milliseconds | 12-skills-and-mcp.md (MCP-72) |
| MCP call held during a rebuild or before the first layer connects, backstop | 120 seconds | 12-skills-and-mcp.md (MCP-78, MCP-91) |
| Model login timeout | 15 minutes | 05-model-and-login.md (MOD-44) |
| Model trial request, deadline with no retry | 60 seconds | 05-model-and-login.md (MOD-88) |
| MCP login, life of a pending login | 10 minutes | 12-skills-and-mcp.md (MCP-61) |
| `chad secret request` wait | 5 minutes | 15-credentials.md (CRED-56) |
| TOTP, time left in the window under which `code` and `run` wait for the next one | 5 seconds | 15-credentials.md (CRED-36) |
| Session passivation after idle | 30 minutes | 03-sessions-and-turns.md (SES-92) |
| Cluster's `entityMessagePollInterval` | 1 second | 03-sessions-and-turns.md (SES-24), 02-storage.md (STO-36) |
| `MessageRetention` for the `Session` entity | One day | 03-sessions-and-turns.md (SES-21) |
| Catch-up after a fresh identify, how far back a session counts as active | 7 days | 03-sessions-and-turns.md (SES-37) |
| Status message, least time between two edits | 2 seconds | 04-discord.md (DIS-21) |
| `chad health`, time the daemon has to answer the ping | 2 seconds | 01-image-and-volume.md (IMG-74), 10-cli.md (CLI-127) |
| CLI, time the daemon has to answer before the CLI says "starting or frozen" | 2 seconds | 10-cli.md (CLI-15) |
| Daemon lock, busy timeout | 3 seconds | 10-cli.md (CLI-26) |
| Boot counter, time after the boot finished loading at which it clears | 60 seconds | 01-image-and-volume.md (IMG-90), 09-repo-and-recovery.md (REC-68) |
| Free space check, interval after the check at boot | 1 hour | 02-storage.md (STO-114), 01-image-and-volume.md (IMG-67) |
| Prune, time of day | 04:00 in the owner's timezone | 02-storage.md (STO-104) |
| Prune, age of a reset session's history | 30 days | 02-storage.md (STO-105) |
| Notice, time after a key's last notice in which the key is not announced again | 24 hours | 16-failures-logs-status.md (FAIL-152) |
| Status, the "Recent" block's window for failed turns and its longer window for tokens | 24 hours and 7 days | 16-failures-logs-status.md (FAIL-114) |

The rules behind the stop rows are in 01-image-and-volume.md.

The second table holds durations the spec names that chad does not set. They belong to a library, to Discord, to the provider or to the container configuration, and they stay at their real length in the tests. Where an image test waits on a setting of the container and not of chad, such as the health check's interval, it may pass a shorter one to the engine.

| Duration | Value | Owner | Stated in |
| --- | --- | --- | --- |
| MCP `connectTimeout` | 30 seconds | clanka | 12-skills-and-mcp.md (MCP-75) |
| Close of a stdio MCP server that ignores its stdin closing and SIGTERM | 4 seconds each, one after another | clanka | 12-skills-and-mcp.md (MCP-74) |
| `Agent.TurnTimeout` | 5 minutes by default | clanka | 16-failures-logs-status.md (FAIL-79) |
| Silence of one model call after which chad ends the turn | 15 minutes, which is three turn timeouts in a row on that call | clanka for the timeout, chad for the count of three | 16-failures-logs-status.md (FAIL-84) |
| `run` moving a command to the background | 2 minutes | clanka | 15-credentials.md (CRED-88) |
| `bash` timeout in the `chad secret request` recipe | `timeoutMs: 330000`, and `scriptTimeout` unset or 330 seconds or more | The `credentials` skill's recipe | 15-credentials.md (CRED-62) |
| Codex WebSocket idle close | 60 seconds | effect's `OpenAiClient` | 05-model-and-login.md, 16-failures-logs-status.md (FAIL-96) |
| Device code life | 15 minutes after it is issued | The provider | 05-model-and-login.md (MOD-44) |
| RPC client ping | 5 seconds | effect RPC's default | 10-cli.md (CLI-19) |
| SQLite connection busy timeout | 5 seconds | `@effect/sql-sqlite-node` | 02-storage.md (STO-33) |
| Interaction deadline for a click or a modal | 3 seconds, of which the handler gets 2 | Discord and effect/chat | 04-discord.md (DIS-17), 03-sessions-and-turns.md (SES-74) |
| Least time between two writes | 1.5 seconds | The Discord adapter | 04-discord.md (DIS-13) |
| Handler time under `layerDispatchHook` before the shard reconnects | About 41 seconds | effect/chat and Discord | 03-sessions-and-turns.md |
| Reconnect delay after a refused event | 1 second, doubling up to 2 minutes | dfx | 03-sessions-and-turns.md (SES-128) |
| TOTP window | 30 seconds unless the URI says otherwise | The stored URI | 15-credentials.md (CRED-21) |
| `HEALTHCHECK` | `--interval=30s --timeout=5s --retries=3 --start-period=60s --start-interval=2s` | The Dockerfile | 01-image-and-volume.md (IMG-79) |
| Kubernetes liveness probe | Every 30 seconds, 5 second timeout, 3 failures | The example manifests | 01-image-and-volume.md (IMG-76) |
| Kubernetes startup probe | Every 2 seconds, 30 failures | The example manifests | 01-image-and-volume.md (IMG-77) |
| Stop grace period | 90 seconds | The Kubernetes example | 01-image-and-volume.md (IMG-87) |
| Docker's default stop timeout | 10 seconds | Docker | 01-image-and-volume.md (IMG-91) |

## Suite rules

These rules come from traps the prototypes hit. Forty scenarios started at once failed 14 timing checks, and 8 at a time passed. One check passed only because 300 shards made a close slow. One failure's log was overwritten and its cause was lost. The daemon lock was lost to a garbage collection only in the third full pass.

- **TST-76** A scenario waits on events and asserts their order. An assertion of the form "within N milliseconds" is allowed only in a test that is named as a timing test.
- **TST-77** The number of scenario files run at once is the runner's core count, set in one place. Files that are sensitive to timing are marked serial.
- **TST-78** All suites run at 1 shard, which is what chad uses. The shard here is cluster's `shardsPerGroup`. The shard count of the Discord gateway is dfx's own and is a different number (see 02-storage.md).
- **TST-79** All suites run with `TZ=Pacific/Auckland`. The daemon sets no `TZ` of its own, and timezone bugs hide in UTC.
- **TST-80** Every scenario writes its event log, the daemon's log and the database to its own directory under a run id. Nothing is overwritten.
- **TST-81** CI uploads the directory of a failed scenario, database included.
- **TST-82** No failed test is retried automatically, anywhere.
- **TST-83** There is no quarantine list. A flaky test is fixed or deleted.
- **TST-84** Scenarios assert on the chat transcript, CLI output, `chad db query` and named log events. They never assert on internals or on message text, and they refer to a message by its name in the `Messages` module of TST-90.
- **TST-85** A scenario that depends on an order states the order in the test. The check that a removed plugin's queued hook is dropped and logged holds the first hook open until the plugin is removed (see 08-apply-and-swap.md).
- **TST-86** Each scenario's volume sits under a short path, because a runner's temporary path is long and a unix socket path holds at most 107 bytes on Linux and 103 bytes on macOS.
- **TST-87** The driver kills its process group at the end of a scenario, and fails the scenario if a daemon or an MCP child process outlives it.
- **TST-189** The driver of the process scenarios points the daemon at a temporary directory with `CHAD_DATA`, and sets `HOME`, the npm prefix and the cache directory to paths inside that directory. `CHAD_DATA` moves none of the three, so without this a `bash` command in a scripted turn would write into the developer's home (see 01-image-and-volume.md for the variables).

## Checks on skills, messages and closed lists

A closed list is a list of names that lives in one module. chad has three. The spec prints the log event names and the `Failed.reason` tags (see 16-failures-logs-status.md and 03-sessions-and-turns.md). The message names are the builder's, and only the `Messages` module holds their list. The checks below stop a list from growing names that nothing produces.

- **TST-88** The doc comment check is a short script on the TypeScript compiler API over the built declaration files of the four public modules. It fails on any exported member or interface property with no doc comment. No lint dependency is added for it (see 06-plugin-api.md).
- **TST-89** The CI checks on a bundled skill, which 14-self-edit-skill.md lists, run on every bundled skill, so on `credentials` and `diagnose` too.
- **TST-169** CI runs each recipe of the `diagnose` skill against a freshly migrated database. The recipes are the `chad logs --turn`, `chad status` and `chad db query` commands the skill teaches, and the queries read the `turns` table (see 16-failures-logs-status.md).
- **TST-90** One `Messages` module holds what chad posts in chat, CLI errors, and the messages the model reads as tool results. It does not try to hold every string a user can see.
- **TST-91** The check that every chad message a skill quotes appears in chad's source matches each quoted message against the templates of the `Messages` module.
- **TST-92** Withdrawn.
- **TST-93** Every log event name on the closed list is emitted somewhere in layers 3 to 5. The check takes the list from the one module that holds it (see 16-failures-logs-status.md) and reads the emitted names from the saved log directories of TST-80. Layer 5 is included because some events happen only there, such as a stop cut by the deadline, the filesystem warning and a path moved aside at boot. Each event name is also a rule with its own id in 16-failures-logs-status.md.
- **TST-94** Every `Messages` name is expected by at least one scenario. The test helper records the names, because scenarios refer to messages by name.
- **TST-95** Every `Failed.reason` tag appears in a `turns` row in some scenario.
- **TST-96** A name on one of the three closed lists that no scenario produces has no test. The product gets no counter for these checks.
- **TST-97** One check stores a canary value as a secret, runs every `chad` command and every recipe in the `credentials` skill, and looks for the value in every output and in the log. It tests the rule that chad's commands and the recipes never print a stored value (see 15-credentials.md).
- **TST-98** The suite holds no test that a value a script printed is masked or absent from chad's outputs.

## Where each check named by another part runs

Other parts name checks that "CI" makes. Each one has a layer.

| Check | Named in | Layer |
| --- | --- | --- |
| `node_modules` holds one copy of `effect` | 01-image-and-volume.md (IMG-56), 07-plugin-loading.md (LOAD-19), 00-overview.md (OV-18) | 5, and the layer 3 scenario of TST-47 |
| `clanka/ClaudeAgent` imports and the Claude Code binary's package is not in `node_modules` | 01-image-and-volume.md (IMG-7) | 5 |
| Every bundled plugin builds from its defaults alone | 11-settings.md (SET-48), 09-repo-and-recovery.md (REC-52), 13-timers-and-cron.md (CRON-58) | 5, as a boot in safe mode |
| chad's copy of the `${NAME}` expander gives the same results as clanka's `McpConfig.load` | 11-settings.md (SET-31) | 2 |
| Every exported member of the plugin API has a doc comment | 06-plugin-api.md (API-12), 14-self-edit-skill.md (SELF-17, SELF-116) | 1 |
| The checks on the bundled skills, with the examples path and effect's `AGENTS.md` and `ai-docs` paths | 14-self-edit-skill.md (SELF-109 to SELF-116), 01-image-and-volume.md (IMG-12), 12-skills-and-mcp.md (MCP-19), 11-settings.md (SET-56) | 5 |
| The lock survives forced garbage collections | 10-cli.md (CLI-27) | 4 |
| The removed plugin's queued hook, with the first hook held open | 08-apply-and-swap.md (SWAP-115) | 3 |
| The seven credential runs that were asked for and not made | 15-credentials.md (CRED-104) | 3 for six of them. The container one is part of the one run on Tim's k3s node (TST-111) |

- **TST-99** Each check that another part assigns to CI runs in the layer the table above gives.

## Where each thing that was never run goes

The prototypes left a list of things that were decided and never run. Each is placed in a layer here. A rule may still need tests in other layers.

- **TST-100** Layer 2 tests cron expressions, which no prototype ran. Only one-shot times and fixed intervals were run.
- **TST-179** The layer 2 tests of cron next-run times pin real dates in `Pacific/Auckland`, with a time inside the hour that a daylight saving change skips and a time inside the hour that it repeats (see 13-timers-and-cron.md for the expected times). The dates are real ones because the source of effect's `Cron` warns that `next` near a gap is not guaranteed to be the nearest match.
- **TST-180** One layer 2 test checks that the reset time of a usage limit, which chad holds in milliseconds, is divided down to seconds in the Discord timestamp chad posts, because a Discord timestamp takes seconds (see 16-failures-logs-status.md).
- **TST-101** Layer 3 tests the following, none of which a prototype ran: context-overflow compaction with a scripted context-length error, several sessions at once, the bundled plugins, plugin scopes closing before the MCP layer, the Enter modal on `ChatTest`, and `chad mcp login` with the "needs login" message against the MCP SDK's example OAuth server run locally.
- **TST-102** Layer 3 tests six of the seven credential runs that were asked for and not made: retiring a forgotten button on a click, the name limit at `request` and `/secret`, a save failing after the modal's reply, `${NAME}` in `mcp.json` naming a TOTP secret failing the apply, a dotenv value with a newline or with both `'` and ` #`, and where an MCP server's working directory is (see 15-credentials.md).
- **TST-103** Withdrawn.
- **TST-181** One test runs the predicate that tells clanka's turn timeout from another error against real clanka and a model that stays silent, so that a change to clanka's wording fails CI and cannot remove the silence bound unnoticed (see 16-failures-logs-status.md). Whether that test shortens clanka's turn timeout is part of TST-G2.
- **TST-104** Layer 4 tests the following, none of which a prototype ran: a backup and restore round trip, a migration from each released schema, the copy made before a migration, a newer `state/version`, a corrupt database, an unknown migration, a kill while a turn waits on the hooks of a compacted turn, a kill straight after a message steered a turn, a kill of the daemon during a CLI call, a daemon stopped with SIGSTOP, the shard guard and its place before the migrations, the queued hooks in a stop, and the lock under forced garbage collections.
- **TST-105** The lock check starts the daemon with Node's `--expose-gc`, forces a collection every 200 milliseconds, and then requires that a second daemon on the same volume is refused.
- **TST-106** A migration fixture is a `chad backup` tar of a seeded volume, saved at each release. The seed holds sessions with history, a pending timer and a held timer, plugin rows and shard state.
- **TST-107** The migration test restores a fixture into the new image, runs a turn in an old session and fires the timer.
- **TST-108** A test makes a daemon lose its lock by replacing `state/daemon.lock` under the running daemon. The daemon keeps the lock's handle for its whole life, so nothing else loses it.
- **TST-182** A layer 4 scenario redelivers a stored `message` request that no longer decodes, which is what a new image with a changed effect/chat encoding produces. It asserts that the request ends as `Failed` with `Internal` and a message in the thread, that the boot is not blocked, and that the request is not tried again (see 03-sessions-and-turns.md). What cluster does with a stored message it cannot decode has not been checked.
- **TST-183** A layer 4 scenario kills the daemon on each side of the commit that stores a steering message in the history and records it as read. After a kill before the commit the redelivered message steers the turn again, after a kill after the commit it does not, and the stored history holds the message once in both cases. The rule that a message is in the stored history exactly once (SES-47 in 03-sessions-and-turns.md) counts as proven only when this scenario passes.
- **TST-109** Layer 5 tests everything the image prototype ran, and the following, none of which a prototype ran: Docker marking a daemon that lost its lock unhealthy, one copy of effect, no Claude Code binary, a boot in safe mode with every bundled plugin on its defaults, and the bundled skill checks.
- **TST-184** Withdrawn.
- **TST-110** The Kubernetes checks are a script that runs against a cluster. They are the probes, `fsGroup` on a local-path volume, the backup CronJob and the browser sidecar's wiring in chad's pod (see 01-image-and-volume.md).
- **TST-111** The Kubernetes checks run once on Tim's k3s node, as an item on the live list, because the filesystem on that node was never checked.
- **TST-166** One named test checks that the text the model reads from a script's output is byte-identical at every value of `CHAD_LOG_LEVEL`. The values are `all`, `trace`, `debug`, `info`, `warn`, `error`, `fatal` and `none`. It tests the rule that the level filters chad's own sinks and never what a script sees (see 16-failures-logs-status.md).
- **TST-167** Withdrawn.

The image prototype's check script had these sections, which are what "everything the image prototype ran" means in TST-109: bin, repo, tini, volume, path, session, boot, stop, health, fs, data, socket, mcp-stop and shards, plus a separate lock check under garbage collection.

The only full disk error that any prototype met came from a page cap on the database, in a run of cluster by itself. On a filesystem that is really full the write-ahead log cannot grow, the renames under `state/` fail, the log file fails, and an apply's commit and export fail part way. None of that has run.

## The pull request gate

- **TST-112** The pull request gate is layers 1 to 4 plus the image layer on amd64. The target for layers 1 to 4, which is `pnpm test`, is one minute on the gate's runner.
- **TST-113** Nothing on the gate reads a secret, so a pull request from a fork runs the whole gate.
- **TST-114** Withdrawn.

The minute is a target. Nothing fails when it is missed.

## No scheduled workflow, release list or budget

chad has no scheduled workflow, no release list and no budget, and `gate.yml` is the only workflow.

- **TST-115** Withdrawn.
- **TST-116** Withdrawn.
- **TST-117** Withdrawn.
- **TST-118** Withdrawn.
- **TST-119** Withdrawn.
- **TST-120** Withdrawn.
- **TST-121** Withdrawn.
- **TST-122** Withdrawn.
- **TST-123** Withdrawn.
- **TST-124** Withdrawn.
- **TST-125** Withdrawn.
- **TST-185** A newer effect snapshot replaces the pinned one only when the harness slice's scenario of a message in and a scripted answer out passes on it (see 00-overview.md for the pins).
- **TST-195** Withdrawn.

The image prototype measured `chad health` at 117 ms, the socket listening 0.8 seconds after start and the image at 697 MB unpacked. Nobody has measured the daemon's memory.

- **TST-126** Withdrawn.
- **TST-127** Withdrawn.
- **TST-128** Withdrawn.
- **TST-129** Withdrawn.
- **TST-130** Withdrawn.
- **TST-131** Withdrawn.
- **TST-132** Withdrawn.

## Running the suite locally

- **TST-133** One command runs layers 1 to 4 on a developer's machine.
- **TST-134** That command first checks for git and the other tools the scenarios call, and names what is missing.
- **TST-135** That command fails at once when Node's major version differs from the one the Dockerfile names. The Dockerfile is the source of the toolchain version.
- **TST-136** A second command runs the image layer on Docker or podman.
- **TST-137** On podman the check that needs Docker is reported as not run. It is the unhealthy mark.
- **TST-138** The nix flake for the repository lives in chad's repository.

## The live layer

The live layer has two lists, the hand checks and the Codex list. Tim runs each once, in the `live` slice of stage 5, and nothing is run before a release. No job talks to a real Discord, and no job reads a secret.

- **TST-139** Withdrawn.
- **TST-140** Withdrawn.
- **TST-186** The intents chad identifies with come from the same constant that `chad connection add discord` builds its invite URL from (see 10-cli.md for the command, which also names each privileged intent, because an invite URL cannot grant one).
- **TST-141** Withdrawn.
- **TST-142** Withdrawn.
- **TST-143** Withdrawn.
- **TST-205** Withdrawn.
- **TST-206** Withdrawn.
- **TST-207** Withdrawn.
- **TST-208** Withdrawn.

### The hand checks

- **TST-144** A person who is an owner does five things by hand once, at the end of the build. Three are a direct message, a click on Stop, and the Enter modal completed. The fourth is a mention of chad in a server channel, which opens a thread, followed by a message in that thread that does not mention chad. The fifth is `chad setup` on a real bot. A bot cannot send another bot a direct message, and nothing can click a button through Discord's API. Both statements are from memory and were not checked. The fourth and the fifth are what confirm DIS-3, DIS-4, SES-8, DIS-89 and CLI-122 on a real Discord, which no job talks to.

### The Codex list

- **TST-145** The Codex list runs by hand on Tim's login, on a scratch volume that holds the login, once, at the end of the build. Tim's part is approving one device code per run, and a script does the rest. No Codex token is kept in CI secrets, because a refresh token stored there goes stale when it rotates.
- **TST-146** Each item on the Codex list has a mechanical pass mark where one exists. An example is cached tokens above zero on a session's second turn after 60 seconds idle.
- **TST-147** After the two captures of TST-168, the Codex list holds at least the four items in the table below, which are the ones left to run on the built daemon, and the recording comparison of TST-42.
- **TST-168** The Codex list starts with two captures. The first is a real usage-limit frame. The second is what a new connection gets while the limit is in force.

| Item | Why it needs a real login |
| --- | --- |
| A turn that resumes after a login in the middle of it | It needs a second login, and the prototype had one |
| One client per session carrying the `session-id` header | The prototype sent the header from a process with one session |
| The summarizer on a Codex login | No prototype run was long enough to compact |
| A token refresh | The token is valid for about ten days, and `logout` stood in for an expiry |

Nobody has captured a real usage-limit frame, so it is not known whether the real service sends an `error.message` with it, and effect's decoder drops an error frame that has none (see 16-failures-logs-status.md). The second capture exists because the Codex socket idles out after 60 seconds, so most chat turns open a new connection, and a refused handshake loses its status and body.

### The results of the two lists

- **TST-148** Withdrawn.
- **TST-149** Withdrawn.
- **TST-150** Withdrawn.
- **TST-187** Withdrawn.
- **TST-151** The results of the hand checks and of the Codex list are recorded in the stage 5 hand-off comment.

## What carries over from the prototypes

Every prototype was plain `node` scripts, bash, `tsc` and podman or Docker, with no test runner, and every daemon in them was a stand-in. Their code lives in the archives attached to the tickets, which TST-197 puts on a branch of chad's repository.

- **TST-152** Nothing that stood in for chad carries over into the suite. Fakes of things outside chad do carry over, which are the fake asphodel daemon, the MCP servers and the local login site.
- **TST-153** The spec carries rules and no list of the prototypes' checks. The rule ids are the inventory of coverage.
- **TST-154** Withdrawn.
- **TST-155** Withdrawn.
- **TST-156** Withdrawn.
- **TST-157** Withdrawn.
- **TST-197** The prototype archives are kept on a branch of chad's repository named `prototypes`, which is never merged. Each stage issue names the archives that ran the rules of its slices.

The archives on that branch, with what the final pass of each held.

| Archive | What its final pass held |
| --- | --- |
| Storage on the data volume | Throwaway scripts on `node:sqlite`, its backup and a second reader |
| Runtime and plugin loading | A twelve-case walkthrough, a soak of 300 and 900 applies, a boot of the applied commit and a race reproduction |
| The asphodel plugin | 30 checks in 12 scenarios |
| The Session entity on `SingleRunner` and SQLite | 96 checks in 36 scenarios at 1 shard |
| Codex login | Claim tables and one log per run |
| Plugin settings | One throwaway script on `Config` reads |
| The CLI's socket, lock and session marker | Runs named by letter |
| The plugin swap with live sessions | 122 checks |
| The image built and run | 128 checks |
| Credential tools | 179 checks |
| The MCP layer rebuild | 169 checks |

## The asphodel fixture

The asphodel plugin is the acceptance test for the plugin API, and the spec prints it in 18-asphodel-plugin.md. Porting the real plugin belongs to asphodel's repository. chad's repository carries the printed plugin as a fixture, which is what turns the acceptance test into a test.

- **TST-158** The asphodel plugin is a test fixture in chad's repository, together with the fake asphodel daemon from the asphodel plugin prototype. The fixture starts from what the spec prints in 18-asphodel-plugin.md. The fixture file is the source, and nothing keeps the printed copy in step.
- **TST-159** Withdrawn.
- **TST-160** The fixture is type-checked against the built declaration files, in layer 1.
- **TST-188** The type-check of TST-160 and the image layer's type-check take their compiler options from the one source that `chad check` uses (see 07-plugin-loading.md). The image test sets no `types: []` of its own.
- **TST-161** The fixture runs through the real daemon in layer 3 with the twelve scenarios in the table below.
- **TST-162** The fixture is not in the image, and nothing from asphodel's repository enters chad's CI.
- **TST-163** Plugin authors get no test helper in v1, and the `chad` package gets no fifth export. The agent tests a plugin with `chad check` and a call in its next turn (see 14-self-edit-skill.md), and the bundled plugins are tested in chad's own suite.

| Number | Scenario |
| --- | --- |
| 1 | The plugin loads |
| 2 | Two owner turns in a direct message |
| 3 | A message steers the turn |
| 4 | A cron turn |
| 5 | The owner asks to forget |
| 6 | A background task calls a tool after its turn ended |
| 7 | The asphodel daemon is down for a turn and the turn is spooled, in two variants. In the second the owner says nothing more and the plugin's own fiber replays the spool. |
| 8 | A compaction, with the `Compacted` hook finished before the next turn |
| 9 | `/new` |
| 10 | The process restarts in the middle of a turn |
| 11 | A session starts while the asphodel daemon is down |
| 12 | The plugin unloads |

The archive ran scenario 8 a second time with the next turn starting before the hooks had run. chad never does that (see 03-sessions-and-turns.md), so that variant has no counterpart.

## The harness slice

- **TST-164** The harness slice delivers `runDaemon`, the driver, the fake model server's `openai-compat` side, the local platform and its adapter, the logger core and the event-name type, the cluster shard-count row and its guard, and the real Dockerfile with `chad serve` and the `HEALTHCHECK` line that names `chad health`. It has two scenarios. The first is a message in and a scripted answer out, on `openai-compat` with the model set through the environment (TST-203). The second is the owner allowlist and the own-message drop, with the connection and its owner ids passed to `runDaemon` (TST-201). They come this early so that both hold before anything that can run `bash` answers a real gateway. In this slice the image layer builds the image, boots it on an empty volume and checks what can be seen without a turn. A turn inside the image needs a `local` connection and an owner on the volume, which the `cli` slice delivers (TST-58). The Dockerfile names `chad health` in its `HEALTHCHECK` from this slice on (see 01-image-and-volume.md). The command itself arrives in the `cli` slice, with the lock, the socket and the ping it rests on (see 10-cli.md and 19-build-order.md). Until then the container reports unhealthy, and the image layer does not wait for a healthy container (TST-G24). The rule-id script arrives one slice earlier, with the repository, and the wire slice attempt comes straight after the harness (see 19-build-order.md).

## What Tim has to do

- **TST-165** The suite depends on the actions in the list below, which only Tim can take.

For the gate:

- Set branch protection with the gate's jobs as required checks. Without it the gate stops nothing.

At the end of the build:

- Approve one device code per run for the Codex list.
- Do the hand checks, on his own bot and his own server. They need a person who is an owner.

Once:

- Make the first Codex recording, if TST-43 needs it.
- Run the Kubernetes checks on his k3s node.
- Read the change to the charting line on the local dev adapter. He agreed that line himself, and it now means that `ChatTest` runs outside the daemon and the image carries only the client.
- Read that for this build tests are chosen by what chad does and not by rule id, and that only three kinds of rule need a test of their own (TST-173). The Coding squad's instructions, which are his, say to write only the bare minimum of tests.

## Gaps

- **TST-G1** [builder] The inputs of `runDaemon` are in TST-33, TST-201, TST-202 and TST-203. What is left to the builder is the TypeScript names and types of the input fields, what `runDaemon` returns, the names of the `Timings` values, the size of the scale factor, and whether a scenario may set one length apart from the factor. Also left are how the daemon in layer 3 keeps its signal handlers and its exit from acting on the test runner, what a SIGTERM does before the `kills` slice delivers the stop, what the test's `HttpClient` does with a request to a host that is not a fake, and whether `chad serve` hands the bundled plugins in through the plugins input. Recommended: `runDaemon` returns the exit code and the two entry files exit the process with it, the forced exit of the stop's timer being the one exit it makes itself. It removes its signal handlers and puts the environment back when it ends. Until `kills` a SIGTERM or SIGINT closes the daemon's scope and the exit code is 0. The test's client fails any request to a host that is not a fake, a scenario may set one length when no ordering it tests rests on that length, and `chad serve` passes the bundled plugins through the plugins input, so that the input has one meaning. TIM-558 items 13 and 17, TIM-559 cold read.
- **TST-G2** [builder] No ticket says whether a duration that chad does not set belongs in `Timings`. The decision says "every duration the spec names" and names only clanka's two timeouts as staying real, and the split in the two durations tables follows who owns each value. The silence bound is the case that needs the answer, because it is three of clanka's turn timeouts in a row, which is 15 minutes at real length, so its test shortens that timeout. TIM-558 items 17 and 29, TIM-557 items 17 and 18.
- **TST-G4** [builder] The items of the live Codex list beyond the two captures and the four named are not written, and neither is the pass mark of each. How the two captures are made is not said either, given that both need a login that is at its usage limit. TIM-558 "Not settled here" and item 38, TIM-557 item 22.
- **TST-G5** [builder] The usage-limit frame that the fake's Codex side serves before the first capture exists is not given. The fake's frames come from a recording, no recording of a usage limit exists, and a frame with an `error.message` and a frame without one end the turn differently. TIM-558 items 15 and 16, TIM-557 items 20 and 22.
- **TST-G9** [builder] The list of adapter operations and the RPC schema between the adapter client and the local platform are not given. Whether the adapter has an operation that fetches the bytes of an inbound attachment is part of this (see 03-sessions-and-turns.md). TIM-558 items 20 and 21.
- **TST-G10** [builder] How a script for the fake model server is written, how a hold is released, and the shape of the one interface to the fakes are not given. Whether the call index counts a request the daemon makes for itself, such as the model check at start, is not given either. Recommended: the fake tells that check apart by its fixed prompt (see 05-model-and-login.md) and does not count it. TIM-558 items 14 and 24.
- **TST-G11** [builder] The scenarios of the wire slice are not listed. The decision says "about a dozen" and names what they cover. How the wire slice points the Discord adapter's REST calls at the fake REST server is not given either. TIM-558 item 26.
- **TST-G15** [builder] The layer of the test of TST-166 and the layer of the recipe check of TST-169 are not named. TIM-557 items 6 and 43.
- **TST-G16** [builder] These things were recorded as not run and no decision places any of them in a layer by name. Each falls under TST-173 like any other rule. From TIM-558 and the tickets before it they are the lock and the volume on filesystems other than ext4, tmpfs, NFS and sshfs; a real `npx -y` MCP server; the setup wizard; a hook that ignores interruption, a secret change during a swap, and the next boot with a setting value that still fails; a secret in an MCP HTTP header and the hint for a long server list; a background task that outlives an Agent rebuild; on Codex, the `session-id` header without `prompt_cache_key`, turns with no owner present failing without a call until a login succeeds, background sub-agents, efforts above `medium` on the three smaller models and anything longer than five minutes; and for credentials a real site, a derived image with a browser, `chad backup` with browser state and `--note ""`. From TIM-557 they are the plugin name, the Info cap and the ids on a copied log line together, with the lines of sub-agents, MCP calls and a background task; the history reconcile, a lost `HistoryReplaced` and the window with real SQLite; the update message, also after passivation; the retry count per agent and the silence bound; what a real Codex backend reports as usage; the notice table and its 24 hour rule; `/status` with no database; `state/notice-thread`; the cron counting rules; and `chad logs`. TIM-558 items 51 to 55, TIM-557 "How well each is supported".
- **TST-G17** [builder] Three details of the rule-id script are not given. They are what a test that names a bare id does once the rule carries letters (TST-190), what `show <id>` prints for a rule that points at a table or a code block (TST-194), and how an id is told from text in a test title that only looks like one, such as `UTF-8` (TST-10). Recommended: a bare id names the rule and no letter, and does not fail. `show` prints the rule's text, its file and line, its section heading and its Provenance row, and a flag prints the whole section. A word in a title counts as an id only when its prefix is one of the spec's prefixes. TIM-559 cold read, repo reader.
- **TST-G20** [builder] Where the script of IMG-119 gets the tarballs of a newer effect commit is not said, and neither is what enforces TST-185. Recommended: the script takes a commit, downloads the snapshot's packages for that commit from pkg.pr.new, rewrites `vendor/` and the manifest, runs the first harness scenario, and puts the old set back when the scenario fails. TIM-559 cold read, harness reader.
- **TST-G22** [builder] Who makes the first Codex recording of TST-43, with which script and over which flows, is not said, and neither is whether the `models` slice waits for it. A builder has no Codex login and may not use one outside the live lists. Recommended: the builder writes the fake's Codex side from the source of clanka and effect, and commits a recorder script that covers the flows of TST-39 and the refusals of TST-40. Tim runs it once (TST-165) and the builder replaces the hand-written frames with the recording. The slice does not wait for that. TST-41 and TST-43 need no test of their own, because the recording comparison of TST-42 is what catches a difference. TIM-559 cold read, models reader.
- **TST-G23** [builder] The inputs of a `runCli` are not given. With no daemon the CLI makes its own network calls and reads its own durations, and 10-cli.md recommends one function `runCli(inputs)` that the bin calls with the real values. Recommended: its inputs are an `HttpClient` and the values of `Timings`, which a test passes as it passes `runDaemon`'s. A scenario calls it in the test's process from `dist` for the commands that reach the network, and starts the real bin for the rest. TIM-558 item 17, TIM-559 cold read, cli reader.
- **TST-G24** [builder] How the image layer of the `harness` slice knows that the daemon is up. The Dockerfile's `HEALTHCHECK` line arrives in `harness`, and the `chad health` command that it calls arrives in `cli` with the lock, the socket and the ping (see 19-build-order.md and 10-cli.md). Until `cli` the container therefore reports unhealthy, and the layer cannot wait for a healthy container. Recommended: in `harness` the layer waits for the `boot.ready` line on the container's standard output (see 16-failures-logs-status.md), and from `cli` on it waits for a healthy container. TIM-559 cold read, harness reader and cli reader.

## Provenance

Every decision from TIM-558 and from TIM-557 was agreed with Architect standing in for Tim, and Tim has not read either. Nothing was run for TIM-558, and none of the rules here that come from TIM-557 was run. The rules that come from the three rounds of TIM-559 were agreed the same way, and none of them was run. The rules marked "Tim, chat 2026-11-15" are Tim's own rulings that the repo is public and that the build is five stages on one branch and one pull request. The rules marked "Tim's ruling that chad has no scheduled job" were withdrawn or reworded during the build, after Tim ruled in chat on 2026-11-15 that chad has no nightly Discord job, no weekly dependency job and no other nightly job, and that `gate.yml` is the only workflow. The rules marked "Tim's ruling that chad has no release list and no budget" were withdrawn or reworded after Tim ruled in chat on the same day that the real-length timings, the soak and the image size budget go too, so that every test runs on the gate apart from the live checks done by hand. The rules marked "Tim's ruling that the image is amd64 only" were reworded the same way, after Tim ruled in chat on the same day that chad is not built for arm64. Six more marks come from a fifth ruling of the same day. The rules marked "Tim's ruling that the suite's own rules need no test" took the kind `definition` and the slice `-`, because they say how the suite and the build are run and no test of them runs chad's own code or a fake that the scenarios rest on. The rules marked "Tim's ruling that the bookkeeping checks go" are the report of functions that no layer ran, the table of prototype scenarios, the comparison of the asphodel fixture with the printed plugin and the test that pinned each `Messages` template to the spec's wording. The rules marked "Tim's ruling that chad has no release ceremony" are the skill runs and what was run before a release. The rules marked "Tim's ruling that chad has no Compose example", "Tim's ruling on a full disk" and "Tim's ruling that the docs have no NFS paragraph" follow the same cuts in the other parts. The rule marked "Tim's ruling that `pnpm test` has a target of one minute" comes from a sixth ruling of the same day, which sets that target for layers 1 to 4, enforces it with no check and has each stage's hand-off comment give the two times (see 19-build-order.md). Two more marks come from a seventh ruling of the same day. The rule marked "Tim's ruling that no image test runs the stop at its real length" is TST-119, which is withdrawn. The rules marked "Tim's ruling that a rule another rule's test runs needs no test of its own" were reworded so that a rule may go on the waiver list against another rule whose test on the gate already runs it. An eighth ruling of the same day replaced that. The rules marked "Tim's ruling that tests are chosen by behaviour" were reworded or withdrawn so that tests are chosen by what chad does, only three kinds of rule need a test of their own, and the waiver list is gone. The rules marked "TIM-559 cold read" were reworded or added by Jarvis after fresh readers each took one build slice and wrote down what they would have to ask, and Tim has not read them. The durations tables repeat values that other parts state, and the tickets behind each value are in the Provenance row of the rule that the table names.

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| TST-1 | TIM-558 item 1; TIM-559 cold read, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-2 | TIM-558 item 1, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-3 | TIM-558 item 1, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-4 | TIM-558 item 1, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-5 | TIM-558 item 1, amended by TIM-559 main session ruling on Q8, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | read |  | `definition` | - |
| TST-6 | TIM-558 item 2, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-7 | TIM-558 item 2, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-8 | TIM-558 item 3, round 1 Q2; TIM-559 cold read, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that chad has no release list and no budget, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-9 | TIM-558 item 3, amended by TIM-559 main session ruling on Q2, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, withdrawn by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-10 | TIM-558 item 3, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-11 | TIM-558 item 3; TIM-559 cold read, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-12 | TIM-558 item 3, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-13 | TIM-558 item 3, amended by TIM-559 round 2 R2; TIM-559 cold read, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that chad has no release list and no budget, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that a rule another rule's test runs needs no test of its own, chat 2026-11-15, withdrawn by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-14 | TIM-558 item 3, amended by TIM-559 main session ruling on Q2 and by Tim, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read). Tim for a slice that is delivered in place of merged | not run |  | `definition` | - |
| TST-15 | TIM-558 item 45, amended by TIM-559 round 2 R10 point 2; TIM-559 cold read, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-16 | TIM-558 item 4, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-17 | TIM-558 item 5, amended by Tim, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read). Tim for the stages and their slices | not run |  | `definition` | - |
| TST-18 | TIM-558 item 5, amended by Tim, chat 2026-11-15 | Tim | not run |  | `definition` | - |
| TST-19 | TIM-558 item 6, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-20 | TIM-558 item 6, withdrawn by Tim's ruling that the bookkeeping checks go, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-21 | TIM-558 item 7, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-22 | TIM-558 item 7, TIM-530 resolution, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Tim for the six mistakes; Architect (Tim has not read) for the assertion | run for the six failing, not run for the assertion |  | `definition` | - |
| TST-23 | TIM-558 item 7, TIM-553 decision 3, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-24 | TIM-558 items 7 and 31, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-25 | TIM-558 item 8, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-26 | TIM-558 item 9; TIM-559 cold read, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-27 | TIM-558 item 10, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-28 | TIM-558 item 10, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-29 | TIM-558 item 11, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-30 | TIM-558 item 12, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-31 | TIM-558 item 13, TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run |  | `rule` | `harness` |
| TST-32 | TIM-558 item 13, round 1 Q4 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-33 | TIM-558 item 13; TIM-559 cold read; TIM-559 round 5 item 4 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-34 | TIM-558 item 14 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-35 | TIM-558 item 14 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-36 | TIM-558 item 14 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-37 | TIM-558 item 14 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| TST-38 | TIM-558 item 14 | Architect (Tim has not read) | read |  | `rule` | `models` |
| TST-39 | TIM-558 item 15 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| TST-40 | TIM-558 item 16 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| TST-41 | TIM-558 item 16 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| TST-42 | TIM-558 item 16 | Architect (Tim has not read) | not run |  | `rule` | `live` |
| TST-43 | TIM-558 item 16, amended by Tim, chat 2026-11-15 | Architect (Tim has not read). Tim for the slice in place of a build issue | not run |  | `rule` | `models` |
| TST-44 | TIM-558 item 16, round 2 R3 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| TST-45 | TIM-558 item 18 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| TST-46 | TIM-558 item 19 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-47 | TIM-558 item 19 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-48 | TIM-558 item 20, map "Agreed at charting" | charting for the adapter; Architect (Tim has not read) for the connection kind | not run | TIM-558 | `rule` | `cli` |
| TST-49 | TIM-558 item 20 | Architect (Tim has not read) | not run | TIM-558 | `rule` | `harness` |
| TST-50 | TIM-558 item 20 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-51 | TIM-558 item 21 | Architect (Tim has not read) | not run | TIM-558 | `rule` | `harness` |
| TST-52 | TIM-558 item 21 and "What this changes in closed tickets", round 1 Q5 | Architect (Tim has not read) | not run | TIM-558 | `rule` | `harness` |
| TST-53 | TIM-558 item 21, map "Out of scope" | charting | not run |  | `rule` | `harness` |
| TST-54 | TIM-558 item 21 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| TST-55 | TIM-558 item 23 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-56 | TIM-558 item 24 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-57 | TIM-558 item 24, round 2 R8 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-58 | TIM-558 item 25 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| TST-59 | TIM-558 item 25 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| TST-60 | TIM-558 item 26 | Architect (Tim has not read) | not run, read for the published dfx modules |  | `rule` | `wire` |
| TST-61 | TIM-558 item 26, TIM-558 change to TIM-532 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| TST-62 | TIM-558 item 26, amended by TIM-557 item 32 | Architect (Tim has not read) | read for the shared handler, not run for the full disk answer | TIM-557 | `rule` | `failures` |
| TST-63 | TIM-558 item 27, amended by Tim, chat 2026-11-15 | Architect (Tim has not read). Tim for the stage in place of a build issue | not run |  | `definition` | - |
| TST-64 | TIM-558 item 27, round 2 R4, amended by Tim, chat 2026-11-15; TIM-559 cold read, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read). Tim for the slice in place of a build issue | not run |  | `definition` | - |
| TST-65 | TIM-558 item 35 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| TST-66 | TIM-558 item 35 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| TST-67 | TIM-558 item 40, comment on TIM-532; TIM-559 cold read | Architect (Tim has not read) | read | TIM-558 | `rule` | `harness` |
| TST-68 | TIM-558 item 40, round 2 R1 | Architect (Tim has not read) | read | TIM-558 | `rule` | `harness` |
| TST-69 | TIM-558 item 40; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-70 | TIM-558 item 17; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-71 | TIM-558 item 17, round 1 Q4; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-72 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-73 | TIM-558 item 17; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-74 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| TST-75 | TIM-558 item 28 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-76 | TIM-558 item 28, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-77 | TIM-558 item 28, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-78 | TIM-558 item 28, TIM-553; TIM-559 cold read, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-79 | TIM-558 item 28, round 1 Q6, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-80 | TIM-558 item 30, TIM-553 "Passed on", amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-81 | TIM-558 item 30, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-82 | TIM-558 item 30, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-83 | TIM-558 item 30, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-84 | TIM-558 item 30, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-85 | TIM-558 item 30, TIM-553 comment on TIM-552, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-86 | TIM-558 item 30, amended by TIM-559 round 2 R5, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-87 | TIM-558 item 30, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-88 | TIM-558 item 31, comment on TIM-549 item 4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| TST-89 | TIM-558 item 32, comment on TIM-549 item 21, TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| TST-90 | TIM-558 item 33, round 1 Q12 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| TST-91 | TIM-558 item 33 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| TST-92 | TIM-558 item 8, round 1 Q12; TIM-559 cold read, withdrawn by Tim's ruling that the bookkeeping checks go, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-93 | TIM-558 item 34, round 2 R7, TIM-557 item 2 and its comment on TIM-558, TIM-559 round 2 R4, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| TST-94 | TIM-558 item 34 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| TST-95 | TIM-558 item 34 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| TST-96 | TIM-558 item 34, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| TST-97 | TIM-558 item 48, comment on TIM-554 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| TST-98 | TIM-558 item 48, TIM-554 (Tim's ruling) | Tim | not run |  | `rule` | `bundled-skills` |
| TST-99 | TIM-558 items 7, 8, 19, 52, 53 and 54, "What this changes in closed tickets"; TIM-541 items 3 and 21, TIM-548 items 6 and 10, TIM-549 items 4 and 21, TIM-553 decision 5, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-100 | TIM-558 item 51, TIM-543, TIM-540 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| TST-101 | TIM-558 item 52 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| TST-102 | TIM-558 item 52, TIM-554 "Not run" | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| TST-103 | TIM-558 item 52, withdrawn by TIM-559 ruling on OV-G1 and main session ruling on Q8 | Architect (Tim has not read) | read |  | `rule` | - |
| TST-104 | TIM-558 item 53 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| TST-105 | TIM-558 item 53, round 1 Q8, TIM-553 decision 5 | Architect (Tim has not read) | not run through vitest, run in the image prototype |  | `rule` | `kills` |
| TST-106 | TIM-558 item 53 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| TST-107 | TIM-558 item 53 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| TST-108 | TIM-558 item 53, round 1 Q8 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| TST-109 | TIM-558 item 54, TIM-557 comment on TIM-558, amended by Tim's ruling that the image is amd64 only, chat 2026-11-15, amended by Tim's ruling that chad has no release list and no budget, chat 2026-11-15, amended by Tim's ruling that chad has no Compose example, chat 2026-11-15, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| TST-110 | TIM-558 item 55, round 1 Q8, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that chad has no Compose example, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `image` |
| TST-111 | TIM-558 item 55 | Architect (Tim has not read) | not run |  | `rule` | `live` |
| TST-112 | TIM-558 item 41, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that `pnpm test` has a target of one minute, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-113 | TIM-558 item 41, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-114 | TIM-558 item 41, withdrawn by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-115 | TIM-558 item 42, round 1 Q14, withdrawn by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-116 | TIM-558 "Not settled here", round 1 Q14, round 2 E, settled by Tim, chat 2026-11-15, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Tim | not run, from memory for the runner being free |  | `rule` | - |
| TST-117 | TIM-558 item 42, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-118 | TIM-558 item 29, round 1 Q6, withdrawn by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-119 | TIM-558 item 29, round 1 Q6, withdrawn by Tim's ruling that no image test runs the stop at its real length, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-120 | TIM-558 item 42, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-121 | TIM-558 item 42, withdrawn by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-122 | TIM-558 item 42, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-123 | TIM-558 item 44, amended by TIM-559 main session ruling on Q8; TIM-559 cold read, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-124 | TIM-558 item 44, round 1 Q17, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-125 | TIM-558 item 44, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-126 | TIM-558 item 43, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-127 | TIM-558 item 43, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-128 | TIM-558 item 43, withdrawn by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-129 | TIM-558 item 43, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-130 | TIM-558 item 43, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-131 | TIM-558 item 43, round 2 R5, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-132 | TIM-558 item 43, withdrawn by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-133 | TIM-558 item 45, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-134 | TIM-558 item 45, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-135 | TIM-558 item 45, round 2 R9, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-136 | TIM-558 item 45, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-137 | TIM-558 item 45, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that chad has no Compose example, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-138 | TIM-558 item 45, amended by TIM-559 main session ruling (the flake lives in the chad repo), amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | read |  | `definition` | - |
| TST-139 | TIM-558 item 36, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-140 | TIM-558 item 36, comments on TIM-532 and TIM-550, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-141 | TIM-558 item 36, round 2 R1, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-142 | TIM-558 item 36, round 2 F, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-143 | TIM-558 item 36, amended by TIM-559 main session ruling on Q9 point 10 and round 2 R6 point 2; TIM-559 cold read, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-144 | TIM-558 item 37, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read) | not run, from memory |  | `rule` | `live` |
| TST-145 | TIM-558 item 38, "What Tim has to do", TIM-559 round 2 R10 point 5, amended by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `live` |
| TST-146 | TIM-558 item 38 | Architect (Tim has not read) | not run |  | `rule` | `live` |
| TST-147 | TIM-558 body and facts comment, TIM-544 "Not run", TIM-558 item 16, TIM-557 comment on TIM-558 | Architect (Tim has not read) | not run |  | `rule` | `live` |
| TST-148 | TIM-558 item 39, round 1 Q8, withdrawn by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-149 | TIM-558 item 39, withdrawn by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-150 | TIM-558 item 39, withdrawn by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-151 | TIM-558 item 39, amended by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `live` |
| TST-152 | TIM-558 item 46 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-153 | TIM-558 item 47 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-154 | TIM-558 item 47, withdrawn by Tim's ruling that the bookkeeping checks go, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-155 | TIM-558 item 47, withdrawn by Tim's ruling that the bookkeeping checks go, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-156 | TIM-558 item 47, amended by Tim, chat 2026-11-15, withdrawn by Tim's ruling that the bookkeeping checks go, chat 2026-11-15 | Architect (Tim has not read). Tim for the stages | not run |  | `rule` | - |
| TST-157 | TIM-558 item 47, round 2 R2, withdrawn by Tim's ruling that the bookkeeping checks go, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-158 | TIM-558 item 49, map "Agreed at charting", amended by Tim's ruling that the bookkeeping checks go, chat 2026-11-15 | charting for the acceptance test; Architect (Tim has not read) for the fixture | not run |  | `rule` | `plugin-api` |
| TST-159 | TIM-558 item 49, amended by TIM-559 ruling on TST-G12 and main session ruling on Q1, withdrawn by Tim's ruling that the bookkeeping checks go, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-160 | TIM-558 item 49 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| TST-161 | TIM-558 item 49, TIM-539 | Architect (Tim has not read) | run on a stand-in host, not run on chad |  | `rule` | `asphodel` |
| TST-162 | TIM-558 item 49 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| TST-163 | TIM-558 item 50, round 1 Q10 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| TST-164 | TIM-558 "Passed on", amended by TIM-559 main session rulings on Q2 and Q9 points 1 to 3, round 2 R6 points 1 and 5; TIM-559 cold read, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-165 | TIM-558 "What Tim has to do", round 2 R10, amended by TIM-559 ruling on OV-G1 and main session rulings on Q4 and Q7, and by Tim, chat 2026-11-15; TIM-559 cold read, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that chad has no release list and no budget, chat 2026-11-15, amended by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read). Tim for the repo being public | not run |  | `definition` | - |
| TST-166 | TIM-557 item 6 and round 2 R3, its comment on TIM-558 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| TST-167 | TIM-557 items 32 to 34 and "How well each is supported", its comment on TIM-558, withdrawn by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-168 | TIM-557 item 22 and round 2 R7, its comment on TIM-558 | Architect (Tim has not read) | not run |  | `rule` | `live` |
| TST-169 | TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| TST-170 | TIM-559 ruling on TST-G12, main session ruling on Q1, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-171 | TIM-559 main session ruling on Q2, round 2 R7 and R10 point 3; TIM-559 cold read, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-172 | TIM-559 main session ruling on Q2, round 2 R2; TIM-559 cold read, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-173 | TIM-559 main session ruling on Q7, round 2 R2, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that a rule another rule's test runs needs no test of its own, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run | TIM-559 | `definition` | - |
| TST-174 | TIM-559 main session ruling on Q7, round 2 R10 point 1, amended by Tim, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read). Tim for the stages | not run | TIM-559 | `definition` | - |
| TST-175 | TIM-559 main session ruling on Q6, amended by Tim, chat 2026-11-15 | Architect (Tim has not read). Tim for the one shared pull request | not run |  | `definition` | - |
| TST-176 | Tim, chat 2026-11-15, in place of TIM-559 main session ruling on Q10, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Tim | not run |  | `definition` | - |
| TST-177 | TIM-559 main session ruling on Q2, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-178 | TIM-559 ruling on TST-G9 and CLI-G19 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-179 | TIM-559 ruling on CRON-G7 | Architect (Tim has not read) | read for the default of effect's `Cron`, not run |  | `rule` | `timers-cron` |
| TST-180 | TIM-559 ruling on FAIL-G4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| TST-181 | TIM-559 ruling on FAIL-G5 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| TST-182 | TIM-559 ruling on SES-G5 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| TST-183 | TIM-559 rulings on SES-G7 and STO-G12, settled by round 2 R3 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| TST-184 | TIM-559 ruling on IMG-G17, withdrawn by Tim's ruling that chad has no Compose example, chat 2026-11-15 | Architect (Tim has not read) | read for Compose's documentation, not run |  | `rule` | - |
| TST-185 | TIM-559 main session ruling on Q8, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-186 | TIM-559 ruling on DIS-G17, round 3 A4; TIM-559 cold read, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| TST-187 | TIM-559 ruling on SWAP-G11, withdrawn by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-188 | TIM-559 ruling on LOAD-G1 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| TST-189 | TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run |  | `definition` | - |
| TST-190 | TIM-559 round 2 R2, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that a rule another rule's test runs needs no test of its own, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-191 | TIM-559 round 2 R2, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-192 | TIM-559 round 2 R2, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-193 | TIM-559 round 2 R2, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-194 | TIM-559 round 2 R10 point 2, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-195 | TIM-559 round 2 R6 point 5; TIM-559 cold read, withdrawn by Tim's ruling that chad has no release list and no budget, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| TST-196 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| TST-197 | TIM-559 round 2 R10 point 6, amended by Tim, chat 2026-11-15 | Architect (Tim has not read). Tim for the stages | not run |  | `definition` | - |
| TST-198 | TIM-559 round 3 L4 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| TST-199 | Tim, chat 2026-11-15 | Tim | not run |  | `definition` | - |
| TST-200 | TIM-559 round 2 R10 point 4, Tim, chat 2026-11-15, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Tim | not run |  | `definition` | - |
| TST-201 | TIM-559 cold read, harness reader, wire reader and cli reader, TIM-559 round 5 item 4, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-202 | TIM-559 cold read, harness reader, TIM-559 round 5 item 4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| TST-203 | TIM-559 cold read, harness reader and cli reader, TIM-559 round 5 item 4 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| TST-204 | TIM-559 cold read, repo reader, TIM-559 round 5 item 5; answered for Tim by Jarvis, chat 2026-11-15, amended by Tim's ruling that the suite's own rules need no test, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run |  | `definition` | - |
| TST-205 | TIM-559 cold read, wire reader, TIM-559 round 5 item 2, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| TST-206 | Build, stage 1, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Builder (Tim has not read) | run |  | `rule` | - |
| TST-207 | Build, stage 1, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Builder (Tim has not read) | not run |  | `rule` | - |
| TST-208 | Build, stage 1, withdrawn by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Builder (Tim has not read) | run |  | `rule` | - |
| TST-209 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| TST-210 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| TST-211 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| TST-212 | Build, stage 2 | Builder (Tim has not read) | run |  | `definition` | - |
| TST-213 | Build, stage 2, withdrawn in the review of `kills`, which found a defect that escapes a handler without a plugin | Builder (Tim has not read) | run |  | `rule` | - |
