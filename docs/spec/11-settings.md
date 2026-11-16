# Plugin settings

This part covers `chad.json`, the one file in the repo that holds each plugin's settings and its on/off switch. It says how a plugin's `Config` reads from that file, how a `${NAME}` reference to a secret is expanded, what turning a plugin off does, what safe mode reads from the file, what an apply and a boot check in it, and what `chad check`, `chad apply` and `chad status` print about settings. It leans on 06-plugin-api.md for `Config` inside a plugin, 07-plugin-loading.md and 08-apply-and-swap.md for reloads and swaps, 09-repo-and-recovery.md for the repo, boot and safe mode, 10-cli.md for the commands, 13-timers-and-cron.md for held timers, 15-credentials.md for the secret store, 16-failures-logs-status.md for notices and the status blocks, and 17-testing.md for where each check runs.

Terms used below. The repo is the one git repository on the data volume, at `repo/work/`, that holds the files chad can change about itself. The agent edits it there, and an apply is the `chad apply` command that checks those edits, commits them and makes them the running version. The applied `chad.json` is the copy in the last applied commit. A bundled plugin ships in the image, and a repo plugin is a file or directory under `plugins/` in the repo. A plugin's name is its file or directory name. The secret store is `secrets/secrets.json` on the volume, managed with `chad secret`. Safe mode is chad running as the image ships it, with nothing loaded from the repo. A load is one build of a plugin, at an apply, at a boot or at a reload.

## The settings file

Settings sit in the repo so that a settings change is checked, committed and reverted like every other change chad makes to itself.

- **SET-1** The settings file is `chad.json` at the root of the repo. It is plain JSON, like `mcp.json`, and one file holds the settings of every plugin.
- **SET-2** `plugins` is the only top-level key. Its value is an object keyed by plugin name. v1 keeps no core settings in the file.
- **SET-3** A plugin's entry has two keys, `enabled` and `settings`, and both are optional. `enabled` is a boolean. `settings` is the object that plugin's `Config` reads.
- **SET-4** A plugin with no entry, or with an entry that leaves a key out, is on and reads an empty `settings` object.
- **SET-5** A bundled plugin's entry sits under `plugins.<name>` like any other plugin's.
- **SET-6** A missing `chad.json` is the same as an empty one.
- **SET-7** The first commit `chad serve` makes on an empty volume includes `chad.json` with the content `{ "plugins": {} }`.
- **SET-8** A settings change is made by editing `chad.json` in `repo/work/` and running `chad apply`, the same way as `mcp.json`. v1 has no `chad config` command and no `chad plugin enable` or `chad plugin disable` command (see 10-cli.md).
- **SET-9** The file never holds a secret's value. A setting that is a secret names it as `${NAME}`, and the value lives in the secret store or in process env.
- **SET-10** The file does not hold the timezone, the owner ids or the model. The timezone is set with `chad timezone` and stored in `state/timezone`, the owner ids are in `secrets/connections.json`, and the model is described in 05-model-and-login.md.

The shape of the file:

```json
{
  "plugins": {
    "<name>": {
      "enabled": false,
      "settings": { }
    }
  }
}
```

An example with one plugin that takes two settings and one bundled plugin turned off:

```json
{
  "plugins": {
    "asphodel": {
      "settings": {
        "url": "http://asphodel:7720",
        "token": "${ASPHODEL_TOKEN}"
      }
    },
    "cron": { "enabled": false }
  }
}
```

## How a plugin reads its settings

A plugin reads settings with Effect's `Config`, as 06-plugin-api.md describes. A `ConfigProvider` is the object that answers a `Config` read. chad gives each plugin a provider of its own, built from that plugin's `settings` object after `${NAME}` expansion.

- **SET-11** A plugin's provider is `ConfigProvider.fromUnknown` over its `settings` object and nothing else. `Config.String("url")` in the plugin named `<name>` reads `plugins.<name>.settings.url`.
- **SET-12** There is no fallback to process env. A key that is not in the plugin's `settings` is missing, whatever the daemon's environment holds.
- **SET-13** Nested objects and arrays are read as JSON. A JSON number is read by `Config.Int`, a nested value through `Config.nested`, and a JSON array through `Config.schema` with an array schema.
- **SET-14** The provider stays installed for the plugin's tool handlers, hooks and background fibers, not only for the load. A `Config` read at call time sees the settings that version loaded with and never the daemon's process env.
- **SET-15** A read of a missing key with no default fails the plugin's load with an error that names the key. That fails an apply and skips the plugin at a boot.
- **SET-16** `Config.withDefault` gives a setting a default, and a plugin whose settings all have defaults loads with no entry in the file.
- **SET-17** An empty string reads as missing, so a plugin cannot be given "" as a value. This is accepted, and the bundled `self-edit` skill says so (see 14-self-edit-skill.md).
- **SET-18** A plugin reads a secret with `Config.Redacted`. In the file the value is written as `${NAME}`.

The read forms below ran against `ConfigProvider.fromUnknown` over a parsed JSON object on Node 26.8.2 with effect 4.1.4. The key names are examples. A missing key failed with `Expected string at ["bank"]`.

```ts
import { Config, Schema } from "effect"

const url = Config.String("url")                                      // a JSON string
const token = Config.Redacted("token")                                // a secret, written "${NAME}" in chad.json
const port = Config.Int("port")                                       // a JSON number
const verbose = Config.Boolean("verbose").pipe(Config.nested("log"))  // a boolean at settings.log.verbose
const tags = Config.schema(Schema.Array(Schema.String), "tags")       // a JSON array
const greeting = Config.String("greeting").pipe(Config.withDefault("Hello"))
```

## Expanding `${NAME}`

A string in a plugin's settings can name a value that is kept outside the repo. chad replaces the name with the value before the plugin sees it, so the plugin reads an ordinary string or a `Config.Redacted`.

- **SET-19** chad expands `${NAME}` and `${NAME:-default}` in every string of a plugin's settings before it builds that plugin's provider.
- **SET-20** A name resolves in the secret store first and then in process env.
- **SET-21** A value from the secret store is never copied into `process.env`.
- **SET-22** A name found in neither place, with no default, fails that plugin's load with an error that names it. That fails an apply and skips the plugin at a boot.
- **SET-23** The settings of a plugin that is off are not expanded, so a name that resolves nowhere in an off plugin's settings fails nothing.
- **SET-24** Withdrawn.
- **SET-25** Process env as the second source is how a Kubernetes Secret supplies a plugin's token. Any name `chad.json` refers to that the secret store does not have is part of the container's env list (see 01-image-and-volume.md).
- **SET-26** With the daemon running, `chad secret set` and `chad secret rm` reload the plugins whose settings name that secret. A plugin that fails to load with the new value keeps its old instance, the command exits 1 and the secret stays stored (see 10-cli.md and 08-apply-and-swap.md).
- **SET-78** Withdrawn.
- **SET-79** The reload after `chad secret set` or `chad secret rm` leaves out a plugin that is off, because nothing of it is loaded.
- **SET-80** The reload after `chad secret set` or `chad secret rm` also tries a plugin that a boot skipped, when that plugin's settings name the secret (see 09-repo-and-recovery.md).

### The expander

clanka, the agent library, expands the same two forms in `mcp.json`, and its expander is private to its `McpConfig` module, which exports only `load` and its error. chad therefore keeps its own copy for `chad.json`.

- **SET-27** The expander for `chad.json` is chad's copy of clanka's pattern and the code around it, about 20 lines.
- **SET-28** A name matches `[A-Za-z_][A-Za-z0-9_]*`. A default is everything after `:-` up to the next `}`, so a default cannot contain `}`.
- **SET-29** Expansion is one pass with no recursion. Text that an expansion produces is not scanned again.
- **SET-30** When a default is given, a name that resolves nowhere takes the default, and so does a name whose value is the empty string, as in clanka's expander.
- **SET-31** A unit test feeds the same strings through clanka's `McpConfig.load` and through chad's copy and compares the results (see 17-testing.md).
- **SET-32** Neither `chad.json` nor `mcp.json` has an escape for a literal `${`. One name, `CHAD_DOLLAR`, is reserved for writing one. `${CHAD_DOLLAR:-$}{X}` expands to the text `${X}`.
- **SET-33** `chad secret set` refuses the name `CHAD_DOLLAR`.
- **SET-81** An apply neither rejects nor warns about a `${NAME}` whose name the secret store can never hold. The store takes only names that match `[A-Z_][A-Z0-9_]*` and have 64 characters at most (see 15-credentials.md), and the expander accepts lower-case letters and any length. Such a name can still resolve from process env, and SET-22 fails the load when it resolves nowhere.

The code block below shows the pattern and the function chad copies, as they stand in clanka 0.28.0, with the lookup replaced by chad's own.

```ts
import { Data, Effect, Option } from "effect"

const variablePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

class MissingVariable extends Data.TaggedError("MissingVariable")<{
  readonly variable: string
}> {}

// The secret store first, then process env.
declare const lookup: (name: string) => Effect.Effect<Option.Option<string>> // adjusted: TIM-548 item 5

const expand = Effect.fnUntraced(function* (text: string) {
  let result = ""
  let last = 0
  for (const match of text.matchAll(variablePattern)) {
    const [whole, name, fallback] = match
    const value = Option.filter(yield* lookup(name!), (value) =>
      fallback === undefined ? true : value !== "",
    )
    if (Option.isNone(value) && fallback === undefined) {
      return yield* new MissingVariable({ variable: name! })
    }
    result +=
      text.slice(last, match.index) + Option.getOrElse(value, () => fallback!)
    last = match.index + whole.length
  }
  return result + text.slice(last)
})
```

## Turning a plugin off

v1 has no command that turns a plugin off, so the switch is a setting in the file. An off plugin is treated like a deleted one and not like one that failed to build, because a failed build at an apply keeps the last good version running. The log event for a timer that comes due while its plugin is off is `timer.held`, and the table of log events is in 16-failures-logs-status.md.

- **SET-34** `"enabled": false` in a plugin's entry turns that plugin off. This works for a bundled plugin, cron included, and for a repo plugin.
- **SET-35** An off plugin is not loaded, and a running version of it is unloaded in the swap of the apply that turned it off.
- **SET-36** An off plugin's tools are gone from each session's next turn.
- **SET-37** An off plugin's timers are held and its data is kept.
- **SET-38** When an apply turns a plugin off, the plugin's queued hooks are dropped and the log gets a `hook.dropped` event (see 08-apply-and-swap.md).
- **SET-39** A timer that comes due while its plugin is off is held like the timer of any plugin that is not loaded (see 13-timers-and-cron.md).
- **SET-40** `chad plugin purge <name>` refuses a repo plugin that is off, because it is still in the applied repo. It accepts a bundled plugin that is off. A bundled plugin cannot be deleted from the repo, so off is the nearest it gets to deleted.
- **SET-95** `chad plugin purge <name>` refuses a bundled plugin that is on, so a loaded plugin never loses its data and timers underneath it.
- **SET-96** `chad plugin purge <name>` prints what it deleted, with the timers counted, and with the jobs counted when the plugin is cron (see 13-timers-and-cron.md).
- **SET-41** `chad status` lists an off plugin as "off" with its count of held timers.
- **SET-42** Turning a plugin back on fires each overdue held timer once, however many runs were missed.
- **SET-43** The output of the apply that turns a plugin back on says how many held timers will fire.
- **SET-82** A running turn's call to a tool of a plugin that an apply turned off with `"enabled": false` is answered like a call to a tool that an apply removed. The rule and the exact text of the message are in 08-apply-and-swap.md.
- **SET-83** `chad plugin reload <name>` refuses a plugin that is off. It exits 1 and says the plugin is off in `chad.json`, because loading it would run something the applied file says is off.
- **SET-84** The timers held for a plugin that is off are not listed under "Problems" in `chad status`. They show only on the plugin's "off" line, because the owner turned the plugin off on purpose and "Problems" is the list of what is wrong (see 16-failures-logs-status.md).
- **SET-85** The timers held for a plugin that was deleted from the repo are not listed under "Problems" either. `chad status` still lists that plugin with its count of held timers and the command `chad plugin purge <name>`, because a deleted plugin has no "off" line to sit on.

## Safe mode and bundled plugins

Safe mode loads nothing from the repo and keeps bundled plugins on (see 09-repo-and-recovery.md). If it ignored the file altogether it would bring back a cron the owner stopped on purpose and fire its overdue jobs, and a bundled plugin left off cannot block a recovery. So safe mode reads one thing from the file.

- **SET-44** Safe mode reads `"enabled": false` on bundled plugins from the applied `chad.json` and reads nothing else from that file.
- **SET-45** If the applied `chad.json` cannot be read or cannot be parsed, every bundled plugin is on.
- **SET-86** In safe mode an `enabled` value that is not a boolean turns on that one bundled plugin only, so one bad entry does not bring back a cron the owner stopped.
- **SET-46** In safe mode a bundled plugin runs on its defaults. Its `settings` in the file are not read.
- **SET-47** An apply or a revert in safe mode that flips `enabled` for a bundled plugin takes effect at once, in both directions. The rest of that apply or revert loads when safe mode goes off (see 10-cli.md).
- **SET-48** Every bundled plugin builds from its defaults alone, with no entry in the file. The image's CI checks that for each bundled plugin, cron included, as a boot in safe mode (see 17-testing.md).

## What an apply checks in the file

`chad check` does everything an apply does up to the commit and throws the result away, so each rule here holds for both commands. A failed apply changes nothing.

- **SET-49** An apply fails when `chad.json` is not JSON.
- **SET-50** An apply fails when the file has a top-level key other than `plugins`.
- **SET-51** An apply fails when a plugin's entry has a key other than `enabled` and `settings`.
- **SET-52** An apply fails when an `enabled` value is not a boolean.
- **SET-87** An apply fails when the value of `plugins` is not a JSON object.
- **SET-88** An apply fails when a plugin's entry is not a JSON object.
- **SET-89** An apply fails when a `settings` value is not a JSON object.
- **SET-53** An apply fails when an entry under `plugins` names no plugin, bundled or in the repo.
- **SET-54** An apply refuses a repo plugin that has a bundled plugin's name. `chad plugin new` refuses such a name as well (see 10-cli.md).
- **SET-55** A warning about a key that was not read while loading never fails an apply (see the settings listing below).
- **SET-56** The `chad.json` examples in every bundled skill decode with the apply's own code, and the image's CI checks that (see 14-self-edit-skill.md and 17-testing.md).
- **SET-76** The apply's validation of `chad.json` is tested as pure code in the unit layer (see 17-testing.md).

## What a boot does with the file

A boot checks less than an apply. A new image can drop or rename a bundled plugin, and the owner's other settings have to survive that. No file in the volume can stop a boot. A notice is a message chad sends the owner outside a turn. Its route, its wording and the rule that keeps a condition from being announced again at every boot are in 16-failures-logs-status.md. So is the table of log events, which has `settings.unparsable` for a file that could not be parsed at a boot, `settings.ignored` for entries that a boot ignored, and `plugin.skipped` for a plugin that a boot skipped.

- **SET-57** At a boot, a `chad.json` that cannot be parsed counts as empty, so every plugin is on its defaults. The owner gets a notice that carries the parse error and says so.
- **SET-58** At a boot, an unknown top-level or per-plugin key is ignored, and the rest of the file is used. The owner gets a notice that lists what was ignored in the file.
- **SET-59** At a boot, an entry that names no plugin is ignored, and the rest of the file is used. The entry is listed in the same notice as an ignored key.
- **SET-90** At a boot, a `plugins` value that is not a JSON object is ignored. Only the `plugins` key is ignored, and SET-58 still decides every other key in the file. Every plugin then gets what a plugin with no entry gets (SET-4). The key is listed in the notice of SET-58, whose notice key is `settings-ignored` (see 16-failures-logs-status.md), and is logged as `settings.ignored`. The file parsed, so the notice of SET-57 is not sent.
- **SET-91** At a boot, a plugin's entry that is not a JSON object is ignored for that plugin, and the rest of the file is used. The plugin gets what a plugin with no entry gets (SET-4). The entry is listed in the notice of SET-58.
- **SET-92** At a boot, a `settings` value that is not a JSON object is ignored for that plugin, and the rest of the file is used. It is listed in the notice of SET-58.
- **SET-97** At a boot outside safe mode, a plugin's entry whose `enabled` value is not a boolean is ignored as a whole, with its `settings` key, in the same way as the entry of SET-91. The plugin gets what a plugin with no entry gets (SET-4), and the rest of the file is used. The entry is listed in the notice of SET-58. SET-86 covers the same entry in safe mode.
- **SET-60** At a boot, a plugin whose settings fail its load, through a missing key or a name that resolves nowhere, is skipped. The other plugins load, and one notice lists every plugin skipped at that boot, each with the first line of its error (see 16-failures-logs-status.md).
- **SET-61** When a new image ships a bundled plugin whose name a repo plugin already uses, the bundled one loads and the repo one is skipped. The notice says the two share one key-value table and that renaming the repo plugin does not move its data.
- **SET-77** While the applied `chad.json` cannot be parsed, `chad status` lists it under "Problems" (see 16-failures-logs-status.md).

## When a settings change reloads a plugin

An apply leaves a plugin running when neither its code nor its settings changed (see 07-plugin-loading.md).

- **SET-62** A plugin's settings changed when its entry in `chad.json` differs from its entry in the applied `chad.json`. The comparison is made before `${NAME}` is expanded, so a changed secret value is not a settings change.
- **SET-63** An apply reloads a plugin when its code or its settings changed.
- **SET-64** Withdrawn.

## The settings listing

The CLI cannot list a plugin's settings without loading it, because a plugin declares them only by reading them. chad's provider therefore records what each plugin asks for, and three commands print it. This is how the agent and the owner find out which settings a plugin takes and whether a key in the file is misspelt.

- **SET-65** chad's provider records every key a plugin asks for.
- **SET-66** `chad check` and `chad apply` print, per plugin, the keys it read while loading.
- **SET-67** A key that took its default is marked "(default)".
- **SET-68** `chad check` and `chad apply` warn about any key in the plugin's `settings` that was not read while loading. The key is reported at full path depth, so a nested key is named by its whole path.
- **SET-69** The warning says "not read while loading", because a key that only a handler reads is not known at load.
- **SET-70** `chad status` shows the same listing for the plugins that are loaded, plus the keys read at call time since the load.
- **SET-94** `chad status --json` carries the settings listing as a list per loaded plugin. Each item holds the key's path, its source, and whether the key was read at load or at call time.
- **SET-71** The listing shows key names and where each value came from, which is one of the file, a default, a `${NAME}` from the secret store, a `${NAME}` from process env, or the inline default of a `${NAME:-default}`.
- **SET-93** For a string that mixes literal text with one or more names, the listing shows each name with its own source.
- **SET-72** The listing never shows a value.
- **SET-73** `chad status` is the one place a bundled plugin's settings can be seen, and the bundled `self-edit` skill points the agent there.
- **SET-74** The file `chad plugin new` writes carries a comment block that lists the plugin's settings. The block is a convention. The starter has one setting with a default.
- **SET-75** The bundled `self-edit` skill teaches the file's shape, the empty string rule, `CHAD_DOLLAR`, the effect of `"enabled": false` on timers and data, and where a bundled plugin's settings can be seen (see 14-self-edit-skill.md).

The comment block and the read it describes, from the starter file:

```ts
// Settings (under plugins.<name>.settings in chad.json):
//   greeting   string   default "Hello"

const greeting = yield* Config.String("greeting").pipe(Config.withDefault("Hello"))
```

## Gaps

- **SET-G1** [builder] The exact text of the settings listing in `chad check`, `chad apply` and `chad status`, including the line that says how many held timers will fire. TIM-548 lists it as not settled.
- **SET-G4** [builder] The wording of the apply errors for the file, and of the boot notice for a repo plugin that has a bundled plugin's name. TIM-548 items 11 and 12 decide what they say and not their text, and TIM-557 item 40 words the other boot notices.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| SET-1 | TIM-548 item 1 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-2 | TIM-548 item 1 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-3 | TIM-548 items 1 and 7 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-4 | TIM-548 item 1; prototype TIM-552 (`settingsOf`) | Architect (Tim has not read) | run |  | `rule` | `settings` |
| SET-5 | TIM-548 item 2 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-6 | TIM-548 item 1 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-7 | TIM-548 item 1, amending TIM-542 item 32 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| SET-8 | TIM-542 items 15 and 23 | Tim | not run |  | `rule` | `settings` |
| SET-9 | TIM-542 item 15, TIM-534 item 14 | Tim | not run |  | `definition` | - |
| SET-10 | TIM-542 item 16, TIM-548 item 1 | Tim | not run |  | `definition` | - |
| SET-11 | TIM-548 item 3; TIM-530 (Config with a provider scoped to the plugin) | Architect (Tim has not read) | run |  | `rule` | `settings` |
| SET-12 | TIM-548 item 3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-13 | TIM-548 item 3 | Architect (Tim has not read) | run |  | `fact` | `settings` |
| SET-14 | TIM-548 item 3, amending TIM-530 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| SET-15 | TIM-530 (Config), TIM-534 item 5, TIM-548 item 5 | Tim | run |  | `rule` | `settings` |
| SET-16 | TIM-548 round 1 facts; TIM-549 item 17 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| SET-17 | TIM-548 item 4 | Architect (Tim has not read) | run |  | `fact` | `settings` |
| SET-18 | TIM-530 (Config), TIM-542 item 15 | Tim | run |  | `rule` | `settings` |
| SET-19 | TIM-548 item 5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-20 | TIM-548 item 5, TIM-537 item 7 | Tim for the order in `mcp.json`; Architect (Tim has not read) for `chad.json` | not run |  | `rule` | `settings` |
| SET-21 | TIM-537 item 7 | Tim | not run |  | `rule` | `settings` |
| SET-22 | TIM-548 item 5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-23 | TIM-548 item 5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-24 | TIM-546 item 8, withdrawn by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run | TIM-546 | `rule` | - |
| SET-25 | TIM-548 (passed to TIM-541), TIM-541 item 18, amended by Tim's ruling that chad has no Compose example, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| SET-26 | TIM-542 item 14 | Tim | not run |  | `rule` | `settings` |
| SET-27 | TIM-548 item 6 | Architect (Tim has not read) | read |  | `rule` | `settings` |
| SET-28 | TIM-548 item 6 and round 2 item 1 | Architect (Tim has not read) | read |  | `rule` | `settings` |
| SET-29 | TIM-548 round 2 item 1 | Architect (Tim has not read) | read |  | `rule` | `settings` |
| SET-30 | TIM-548 item 6 and round 1 item 3; clanka `src/McpConfig.ts` read at `88a1e05` (0.27.0) and compared with 0.28.0, where the pattern and `expand` are the same | Architect (Tim has not read) | read |  | `rule` | `settings` |
| SET-31 | TIM-548 item 6, TIM-558 item 8 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-32 | TIM-548 item 6 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-33 | TIM-548 item 6, amending TIM-542 item 14 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| SET-34 | TIM-548 item 7, TIM-542 item 23 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-35 | TIM-548 item 7 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-36 | TIM-548 item 7 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-37 | TIM-548 item 7 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| SET-38 | TIM-547 item 10; TIM-559 round 2 R4 for the event name | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-39 | TIM-547 item 13, TIM-540 item 18 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| SET-40 | TIM-548 item 7, amending TIM-542 item 12; TIM-559 ruling on CRON-G19; TIM-559 round 3 C7 | Architect (Tim has not read) | not run | TIM-548, TIM-559 | `rule` | `settings` |
| SET-41 | TIM-548 item 7 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `timers-cron` |
| SET-42 | TIM-540 items 9 and 18, TIM-543, TIM-548 item 8 | Tim for firing once; Architect (Tim has not read) for a plugin turned back on | run |  | `rule` | `timers-cron` |
| SET-43 | TIM-548 item 8 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `timers-cron` |
| SET-44 | TIM-548 item 9, amending TIM-534 item 6 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| SET-45 | TIM-548 item 9, amended by TIM-559 ruling on SET-G6 | Architect (Tim has not read) | not run | TIM-548, TIM-559 | `rule` | `settings` |
| SET-46 | TIM-548 item 9 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-47 | TIM-548 item 9 and round 2 item 2, amending TIM-542 item 25 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| SET-48 | TIM-548 item 10, amending TIM-540; TIM-558 item 54 | Architect (Tim has not read) | not run | TIM-548, TIM-558 | `rule` | `settings` |
| SET-49 | TIM-548 item 11 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-50 | TIM-548 item 11 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-51 | TIM-548 item 11 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-52 | TIM-548 item 11 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-53 | TIM-548 item 11 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-54 | TIM-548 item 11, TIM-542 item 11 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `apply` |
| SET-55 | TIM-548 item 14 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-56 | TIM-549 item 21, amended by TIM-558 items 32 and 54; TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SET-57 | TIM-548 item 12, TIM-557 items 36 and 40 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-58 | TIM-548 item 12, TIM-557 items 36 and 40 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-59 | TIM-548 item 12, TIM-557 items 36 and 40 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-60 | TIM-534 item 5, TIM-548 item 5, TIM-557 items 36 and 40 | Tim for the skip and the notice; Architect (Tim has not read) for the unresolved name and for what the notice lists | not run | TIM-557 | `rule` | `settings` |
| SET-61 | TIM-548 item 12 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SET-62 | TIM-548 item 13 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-63 | TIM-542 item 10, TIM-538 item 3; run in TIM-552 | Tim | run |  | `rule` | `settings` |
| SET-64 | TIM-547 item 7, amended by TIM-552 items 1 and 2, withdrawn by Tim's ruling that a running turn's tool call is never routed to another plugin version, chat 2026-11-16 | Tim | run |  | `rule` | - |
| SET-65 | TIM-548 item 14 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-66 | TIM-548 item 14, amending TIM-542 item 28 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| SET-67 | TIM-548 item 14 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-68 | TIM-548 item 14 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-69 | TIM-548 round 2 item 4 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-70 | TIM-548 item 14, amending TIM-542 item 19 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| SET-71 | TIM-548 item 15, amended by TIM-559 ruling on SET-G3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-72 | TIM-548 item 15 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-73 | TIM-548 item 16 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SET-74 | TIM-548 item 16, TIM-549 item 17 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-75 | TIM-548 (passed to TIM-549), TIM-549 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SET-76 | TIM-558 item 8 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-77 | TIM-557 item 27 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `settings` |
| SET-78 | TIM-559 ruling on SET-G8, withdrawn by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run | TIM-546, TIM-559 | `rule` | - |
| SET-79 | TIM-559 ruling on SET-G8 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| SET-80 | TIM-559 ruling on REC-G19 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| SET-81 | TIM-559 ruling on SET-G10 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-82 | TIM-559 ruling on SET-G7 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-83 | TIM-559 ruling on SET-G9 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| SET-84 | TIM-559 ruling on SET-G11 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| SET-85 | TIM-559 ruling on SET-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| SET-86 | TIM-559 ruling on SET-G6 | Architect (Tim has not read) | not run | TIM-548, TIM-559 | `rule` | `settings` |
| SET-87 | TIM-559 ruling on SET-G5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-88 | TIM-559 ruling on SET-G5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-89 | TIM-559 ruling on SET-G5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-90 | TIM-559 ruling on SET-G5, changed by TIM-559 round 3 L2; TIM-559 round 4 item 6 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-91 | TIM-559 ruling on SET-G5; TIM-559 round 4 item 6 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-92 | TIM-559 ruling on SET-G5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-93 | TIM-559 ruling on SET-G3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SET-94 | TIM-559 ruling on SET-G2 | Architect (Tim has not read) | not run | TIM-548, TIM-559 | `rule` | `settings` |
| SET-95 | TIM-559 ruling on CRON-G19; TIM-559 round 3 C7 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| SET-96 | TIM-559 round 3 C7 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| SET-97 | TIM-559 round 3 L2; TIM-559 round 4 item 6 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
