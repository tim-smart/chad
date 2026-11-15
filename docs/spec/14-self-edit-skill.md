# The bundled self-edit skill and the persona

This part covers `self-edit`, the skill that ships in the image and teaches chad's agent to change its own plugins, skills, MCP servers, settings and persona. It also covers the reading material the skill names under `/data/repo`, the two fixed sentences in the core prompt, the persona file, the file `chad plugin new` writes, what a check and an apply refuse, the CI checks on the skill, and the hash chad keeps of each bundled skill. The commands are specified in 10-cli.md, skill loading and the MCP rebuild rules in 12-skills-and-mcp.md, the effect of an apply on running turns and the order of the system prompt in 08-apply-and-swap.md, the repo and safe mode in 09-repo-and-recovery.md, the plugin API in 06-plugin-api.md, the image paths in 01-image-and-volume.md, the second bundled skill in 15-credentials.md, the third bundled skill and the notices in 16-failures-logs-status.md, and how the CI checks are run in 17-testing.md.

## The skill and its files

A skill is a directory with a `SKILL.md` file that the agent reads when the file's description matches the task in front of it. A bundled skill ships in the image. A repo skill lives in the git repo on the data volume, which the agent edits in the checkout at `/data/repo/work`. An apply is the `chad apply` command, which checks the whole checkout, commits it and loads it. A check is `chad check`, which runs the same steps and commits nothing. The owner is the one person chad works for. Safe mode is chad running as the image ships it, with nothing from the repo loaded.

chad teaches the agent to change itself through one skill. The skill's wording is expected to change once an agent has been watched using it, so this part fixes what the skill has to say and leaves its sentences free.

- **SELF-1** chad ships one bundled skill for changing itself, named `self-edit`. Plugins, skills, MCP servers, settings, secrets and the persona are all covered by that one skill.
- **SELF-2** The skill's `SKILL.md` holds the edit, check and apply loop, the rules, the exit codes, and a section each on skills, MCP servers, settings, secrets, the persona, undoing a change and safe mode.
- **SELF-3** Plugin writing is in a second file, `plugin.md`, in the same directory as `SKILL.md`.
- **SELF-4** chad ships no file of its own about Effect. The `AGENTS.md` file inside the effect package is that file.
- **SELF-5** The skill restates no signatures of the plugin API. It carries one complete small plugin and the rules that types cannot express.
- **SELF-6** The examples in the skill and the file `chad plugin new` writes follow the style of effect's `AGENTS.md`. Core modules come in one import from `"effect"`, with `"effect/ai"` and `"effect/http"` added where needed. Service methods use `Effect.fn`, and errors use `Schema.TaggedError`.
- **SELF-7** The skill says which effect and chad versions a plugin compiles against, where to read them, and that this is Effect 4.
- **SELF-8** `chad status` prints chad's version and effect's version (see 10-cli.md).
- **SELF-9** The text of `SKILL.md` and `plugin.md` at the end of this part and the starter file shown below are a starting point and are not normative. What binds a builder is what the skill has to teach, the decisions in this part, the file layout and the CI checks. The final wording is settled when someone watches an agent use the skill against a built chad.
- **SELF-10** A repo skill named `self-edit` replaces the bundled one, as a repo skill replaces any bundled skill with the same name (see 12-skills-and-mcp.md).
- **SELF-11** A second bundled skill, `credentials`, ships beside `self-edit`. The secrets section of `self-edit` points at it for passwords and sign-in codes (see 15-credentials.md).
- **SELF-124** A third bundled skill, `diagnose`, ships beside `self-edit` and `credentials`. It teaches the agent to answer why a turn failed (see 16-failures-logs-status.md).

```
<the bundled skills directory in the image>/
  self-edit/
    SKILL.md      front matter with name and description, then the skill
    plugin.md     plugin writing, named in the Plugins section of SKILL.md
  credentials/    see 15-credentials.md
  diagnose/       see 16-failures-logs-status.md
```

## What the agent reads for plugin work

For the plugin API and for Effect the skill sends the agent to files that ship with the running version, so they cannot drift from it. All of them are reached under `/data/repo`. There, `node_modules` is a symbolic link to the image's packages, and `examples` is a symbolic link to the source of the plugins chad ships, which this spec calls the bundled plugins. The declaration files are the `.d.ts` files that carry the types and doc comments of the `chad` package.

- **SELF-12** When the agent develops a plugin, chad tells it to read the `AGENTS.md` file inside the installed effect package.
- **SELF-13** For plugin work the skill names a reading order. First comes effect's `AGENTS.md`, then chad's declaration files, then one bundled plugin under `/data/repo/examples/`.
- **SELF-14** Every path in the table below exists in the image, and these are the paths the skill names.
- **SELF-15** `plugin.md` names the examples under effect's `ai-docs/src/` that a plugin needs. The draft names `01_effect/03_services`, `01_effect/05_resources`, `50_http-client/10_basics.ts` and `71_ai/20_tools.ts`.
- **SELF-16** `plugin.md` names the three things in those examples that do not apply to a plugin. chad provides `HttpClient`. chad runs the plugin, so there is no `runMain` and no `Layer.launch`. Only chad's direct dependencies can be imported.
- **SELF-17** Every exported member of the plugin API has a doc comment, and a check in CI holds that, because the declaration files are what the agent reads (see 06-plugin-api.md and 17-testing.md).
- **SELF-18** From the `chad` package a plugin can import only `chad`, `chad/Plugin`, `chad/Session` and `chad/Turns`, and the skill says so.

| What | Path |
| --- | --- |
| effect's guide | `/data/repo/node_modules/effect/AGENTS.md` |
| effect's examples | `/data/repo/node_modules/effect/ai-docs/src/` |
| chad's declaration files | `/data/repo/node_modules/chad/dist/Plugin.d.ts`, `Session.d.ts` and `Turns.d.ts` in the same directory |
| the bundled plugins' source | `/data/repo/examples/` |
| the two examples `plugin.md` names | `/data/repo/examples/cron/` and `/data/repo/examples/send-file.ts` |
| the daemon's log | `/data/logs/chad.log` |

The bundled plugins' source is kept as one copy in the image and shown to the agent through a link, so the examples always match the running version and safe mode cannot drop them.

- **SELF-19** The bundled plugins' TypeScript source ships as one copy, inside the package that `import { Plugin } from "chad"` resolves to. It does not ship at `/app/plugins` and is not copied into the repo.
- **SELF-20** At boot chad creates the symbolic link `/data/repo/examples`, which points at that directory. chad recreates it at every boot, so it always shows the running version's source.
- **SELF-21** The link sits next to `work/`, `live` and `node_modules`, above `work/` and outside git. Nothing loads from it. `git status` in `work/` shows neither `examples` nor `node_modules`.
- **SELF-22** The skill, the header of the starter file and the output of `chad plugin new` name `/data/repo/examples/` as the place to read working plugins. None of them names the path under `node_modules`.
- **SELF-23** The skill tells the agent to read `examples/`, not to edit it, and not to copy a bundled plugin into `work/plugins/` under its own name. An apply refuses a repo plugin that has a bundled plugin's name in any case.
- **SELF-24** The agent's user, uid 1000, cannot write through the link into the image's files. It can replace the link itself. At the next boot, anything at `repo/examples` or `repo/node_modules` that is not a link is moved to `<name>.replaced-<timestamp>` and logged, and chad puts the link back (see 01-image-and-volume.md).
- **SELF-25** The skill carries a sentence that asks the agent not to put anything at `repo/examples` or `repo/node_modules`.

The effect snapshots chad vendors include `AGENTS.md`, so the fallback in the second rule below is not expected to run. It stays as the rule for a snapshot that turns out to lack the files. The second and third rules are about the image build. They are tested on the effect package inside the image's own `node_modules`, and neither needs the link under `/data/repo`, which the first rule's path goes through.

- **SELF-26** The image carries effect's `AGENTS.md` and `ai-docs/` for the effect version it pins, reachable at `/data/repo/node_modules/effect/`.
- **SELF-27** If the vendored effect snapshot lacks `AGENTS.md` or `ai-docs/`, the image build takes effect's source at the commit that the manifest under `vendor/` names, runs the step of effect's own build that puts the two into the effect package before a publish, and copies what that step produces into the effect package in the image's `node_modules`. The image build fails if that step fails, and it fails if either of the two is missing from that package at the end.
- **SELF-28** The image never takes `AGENTS.md` or `ai-docs/` from another published version of effect, because they would describe another version.
- **SELF-135** The step of SELF-27 is effect's `scripts/copy-ai-docs.mjs`, which is the last step of the `build` script in the root of effect's repository. The image build gets effect's source as GitHub's tarball of the manifest's commit, `https://codeload.github.com/<repository>/tar.gz/<commit>`, because the build stage holds neither git nor curl. It installs `glob`, the one package the script imports, at the range effect's root `package.json` names, runs the script in that tree, and copies `packages/effect/AGENTS.md` and `packages/effect/ai-docs/` into the effect package. The fallback runs only in the build stage, and nothing of it is in the image.

## The five moments the AGENTS.md path is shown

Nothing can force the agent to read a file. chad shows the path of effect's `AGENTS.md` at each point where the agent starts or repairs a plugin, and that is all v1 does.

- **SELF-29** chad never inlines effect's `AGENTS.md` into the skill, the system prompt or a command's output. It shows the path.
- **SELF-30** The Plugins section of `SKILL.md` names the path.
- **SELF-31** The first line of `plugin.md` tells the agent to read the file at that path.
- **SELF-32** The header of the file `chad plugin new` writes names the path.
- **SELF-33** The output of `chad plugin new` prints the path.
- **SELF-34** A failed `chad check` or `chad apply` ends with one line that names the path when a type error is in a file under `plugins/`.
- **SELF-35** That line prints once for a failed run, however many errors there are. It does not print when no failing file is under `plugins/`.
- **SELF-36** v1 does nothing beyond these five moments to make the agent read the file.
- **SELF-125** Before a release, the skill runs put a real model through fixed tasks that follow the bundled skills, and their pass mark includes the path of effect's `AGENTS.md` appearing in the turn's scripts (see 17-testing.md).

## The core prompt

The core prompt is the block of system prompt text that chad itself supplies. It is held outside the repo, so nothing the agent applies can change it. The order of the whole system prompt and the rules for rendering it again are in 08-apply-and-swap.md.

- **SELF-37** chad's core prompt carries the two fixed sentences shown below, word for word.
- **SELF-38** When safe mode is on, the rendered prompt has one more line. It says that safe mode is on and that nothing from the repo is loaded.
- **SELF-39** Turning safe mode on or off always renders the system prompt again, even with an empty repo. The change does not arrive as an update message.
- **SELF-40** chad's core adds no line to the start of a turn that a plugin started.

```
Your plugins, skills, MCP servers, settings and persona are files you can change with the `chad` CLI. Read the `self-edit` skill before you do.
```

## The persona

The persona is the owner's description of who chad is for them. It is the one piece of system prompt text that the repo holds as a plain file. The two rules for when the agent edits it are among the rules that live only in the skill, further down.

- **SELF-41** The persona is the file `persona.md` at the root of the repo. It is plain Markdown and it is optional.
- **SELF-42** In the system prompt the persona goes after the core block and before the plugins' prompt chunks.
- **SELF-43** An applied change to `persona.md` renders each session's system prompt again on that session's next turn.
- **SELF-44** The first commit chad makes in a new repo includes an empty `persona.md`.
- **SELF-45** Safe mode leaves the persona out of the system prompt.
- **SELF-46** The persona is where the agent learns that the owner mounted a directory.

## The starter file from chad plugin new

`chad plugin new <name>` gives the agent a plugin that already loads, so its first edit starts from working code. The command itself is specified in 10-cli.md.

- **SELF-47** `chad plugin new <name>` writes `plugins/<name>.ts` into `work/` and does nothing else. With `--dir` it writes the same file as `plugins/<name>/index.ts`.
- **SELF-48** A name is made of lower-case letters, digits and hyphens. `chad plugin new` refuses a name that is taken and a name that a bundled plugin holds.
- **SELF-134** The name rule holds for every plugin in the repo, however its file was made. What a check, an apply and a boot do with a plugin whose name breaks the rule is specified in 07-plugin-loading.md.
- **SELF-49** The file is a working plugin. It has one tool named `<camelName>Hello`, one setting with a default, a comment block that lists the plugin's settings, and a comment that lists the other kinds of contribution a plugin can make.
- **SELF-50** The file's header names the `self-edit` skill, the path of effect's `AGENTS.md` and `/data/repo/examples/`.
- **SELF-51** The file passes `chad check` as written.
- **SELF-52** The description of the tool in the file starts with "Replace me".
- **SELF-53** The settings comment block at the top of a plugin file is a convention.

```ts
// plugins/<name>.ts, as written by `chad plugin new <name>`.
// <name> and <camelName> are filled in from the name given.
//
// Settings (under plugins.<name>.settings in chad.json):
//   greeting   string   default "Hello"
//
// Before changing this file, read the self-edit skill and
// /data/repo/node_modules/effect/AGENTS.md.
// Working plugins to read: /data/repo/examples/
// `chad check` type-checks it and loads it on trial. `chad apply -m "<why>"` makes it live.
import { Plugin } from "chad"
import { Config, Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

// A tool the agent calls from its scripts. Replace it with your own.
// `chad check` reports and `chad apply` refuses a description that still starts with "Replace me".
const Tools = Toolkit.make(
  Tool.make("<camelName>Hello", {
    description: "Replace me. Say what the tool does and when to call it.",
    parameters: Schema.Struct({ name: Schema.String }),
    success: Schema.Struct({ message: Schema.String })
  })
)

const ToolsLive = Plugin.toolkit(Tools).pipe(
  Layer.provide(Tools.toLayer(Effect.gen(function*() {
    // Runs once per load. Read settings and build clients here.
    const greeting = yield* Config.String("greeting").pipe(Config.withDefault("Hello"))
    return Tools.of({
      <camelName>Hello: ({ name }) => Effect.succeed({ message: `${greeting}, ${name}` })
    })
  })))
)

// Other contributions. Each returns a Layer to add to Plugin.make below.
//   Plugin.prompt((session) => ...)     a chunk of the system prompt
//   Plugin.beforeTurn((turn) => ...)    context added to one turn
//   Plugin.afterTurn((ended) => ...)    runs after a turn ends
//   Plugin.onSession((event) => ...)    a reset or a compaction
//   Plugin.background(effect)           a fiber for the plugin's whole life

export default Plugin.make(ToolsLive)
```

## What a check and an apply refuse

These checks exist because of the skill and the starter file. They run with the other steps of a check and an apply, which are in 10-cli.md and 08-apply-and-swap.md.

- **SELF-54** `chad check` reports a tool whose description starts with "Replace me", and `chad apply` refuses it. The error says to describe the tool or delete it.
- **SELF-128** What `chad check` exits with when a "Replace me" description is its only finding, and what the line it prints has to say, are specified in 10-cli.md.
- **SELF-55** `chad check` and `chad apply` fail on a `SKILL.md` that has no front matter.
- **SELF-56** `chad check` and `chad apply` fail on a `SKILL.md` whose `name` or `description` is missing or empty.
- **SELF-57** `chad check` and `chad apply` fail on a `SKILL.md` whose `name` differs from the name of its directory. The error says to set `name: <dir>`.
- **SELF-58** `chad check` and `chad apply` fail when two skills in the repo have one name.
- **SELF-59** Each of these skill errors names the file.
- **SELF-60** At boot a skill with one of these faults is skipped, and chad sends a notice. The notice's wording, where it is posted and when it may be sent again are in 16-failures-logs-status.md.
- **SELF-61** A repo skill with a bundled skill's name is an override and not an error.
- **SELF-133** What `chad check` and `chad apply` do with a file named `AGENTS.md` or a directory named `.agents` or `.kiro` in the repo is specified in 07-plugin-loading.md. Both refuse them wherever they sit in the repo, one that `.gitignore` covers included, because both look on disk in `repo/work/` as well as in the exported tree. The message names `skills/` and `persona.md`.
- **SELF-62** An error whose fix is known says the fix.
- **SELF-63** chad rewrites the error for a plugin with top-level await so that it says the fix.
- **SELF-64** chad rewrites the error for a missing module so that it lists what can be imported.
- **SELF-65** chad rewrites the error for a tool name clash so that it names who holds the name.
- **SELF-66** The skill's failure table keeps only the cases no message can explain. They are a missing service at `Plugin.make`, a hook that does nothing, a tool that is not there after an apply that worked, and a setting that is an empty string.

## Rules that live only in the skill

Nothing in chad's code enforces the rules in this section. The agent follows them because the skill says so, which makes each one a design decision that the skill's wording has to carry. An unattended turn is a turn that no owner message started, such as a scheduled cron run.

- **SELF-67** In an unattended turn the agent does not apply, revert, purge or change safe mode unless the turn's prompt tells it to. It leaves the change as a draft and says so in its answer. The skill's line for this is shown below.
- **SELF-68** That line is written against the wording cron stores with every job's prompt, which says the turn is a scheduled run and that nobody is there to answer questions (see 13-timers-and-cron.md).
- **SELF-69** `plugin.md` and the doc comments of `Turns.start`, `Turns.queue` and `Turns.schedule` tell a plugin author that the prompt has to say what started the turn and that nobody is there to answer questions. A turn is unattended by its origin, whichever of the three calls started it. The doc comments are in 06-plugin-api.md.
- **SELF-70** v1 has no check in the CLI against the turn's origin. A plugin whose author leaves that line out starts turns the agent treats as attended, and this is accepted.
- **SELF-71** The agent turns safe mode off only when the owner asked it to fix the problem and the fix is applied. If safe mode started by itself, the agent asks the owner first.
- **SELF-72** The agent never turns safe mode on unless the owner asks.
- **SELF-73** `chad safe` is not an owner command, so the CLI lets the agent run it. The two safe mode rules above are rules in the skill and not checks in the CLI.
- **SELF-74** The agent does not copy the `self-edit` skill into the repo to change it. The owner's conventions go in a separate skill.
- **SELF-75** The agent edits `persona.md` only when the owner asks.
- **SELF-76** When the owner mounts a directory, the agent records it in `persona.md` with its path under `/mnt` and what it holds.
- **SELF-77** The agent tests a change to a plugin's code in the turn after the one that applied it.
- **SELF-78** The skill says that the next turn cannot start while the current turn has a background sub-agent running. A message the owner sends then is steered into the running turn and runs on the old Agent, so the new version is not there yet. The refusal the agent sees ends with the sentence shown below.
- **SELF-79** A change to only a plugin's settings reaches the running turn at once, unless it changes a tool's description, or the tool's parameters stop accepting the value. In those two cases the tool waits for the next turn as well.
- **SELF-80** With no owner around, the agent tests by scheduling a one-off cron job. The job's prompt stands on its own and says what to call, with what, and what counts as a pass.
- **SELF-81** If the cron plugin is off, the agent reports what it changed and stops.
- **SELF-82** v1 adds no command for testing a change.
- **SELF-127** The `chad` package gives a plugin author no test helper in v1 (see 17-testing.md).
- **SELF-83** An apply that changes a plugin's code affects other sessions. The agent reads the apply output, which names those sessions, and says so in its answer.
- **SELF-126** Whatever the agent says, chad itself posts one subtext line in a session's thread when a command run from that session applies, reverts, turns safe mode on or off, purges a plugin, removes a secret or sets the timezone (see 16-failures-logs-status.md).

The skill's line for an unattended turn:

```
In a scheduled run, or any turn whose prompt says nobody is there to answer questions, do not apply, revert, purge or change safe mode unless the prompt tells you to. Leave the change as a draft and say so in the answer.
```

The end of the refusal while a turn has a sub-agent running:

```
The new version is in your next turn, which cannot start while this turn has a sub-agent running.
```

## What the skill has to teach

Each rule below is a fact decided in another part that the skill has to state. The sentences are free and the content is not. Where the skill quotes a message or names a command, the CI checks further down hold it to chad's source.

The loop and the repo:

- **SELF-84** The skill teaches that the agent edits files under `/data/repo/work`, and that an edit is a draft until it is applied.
- **SELF-85** The skill teaches that an apply resets the branch in `work/` to the applied commit, so commits the agent makes there do not last.
- **SELF-86** The skill teaches that an apply covers the whole of `work/`, another session's draft included.
- **SELF-87** The skill teaches that an applied change reaches a session on its next turn and not in the turn that applied it.
- **SELF-88** The skill teaches that a tool whose plugin's code an apply changed fails for the rest of the running turn with "changed by an apply", in every session, and that the fixed tool is there in the next turn.
- **SELF-89** The skill teaches the commands. `chad plugin new` and `chad skill new` start a file. `chad check` shows errors without committing. `chad apply -m` applies. `chad status` shows what loaded and what was skipped. `chad plugin reload` rebuilds one plugin whose code did not change. `chad plugin purge` drops the data and timers of a plugin that is gone from the applied repo, or of a bundled plugin that is turned off (see 11-settings.md).
- **SELF-131** The skill tells the agent that a skill of chad's own goes in `skills/` in the repo and never in a `.agents/skills` or `.kiro/skills` directory. It gives the reason. clanka announces a skill it finds in one of those two directories to the running session with no apply, so no check ran on it and no revert covers it. How far clanka looks for them is stated in 12-skills-and-mcp.md.
- **SELF-132** The skill tells the agent never to write an `AGENTS.md` file in the repo, and that what the agent should always know goes in `persona.md`. It gives the reason. clanka reads an `AGENTS.md` in the directory the agent works in, and in the directories above it that 12-skills-and-mcp.md names, straight into the session, so a draft `work/AGENTS.md` reaches the model with no apply.
- **SELF-90** The skill lists the exit codes. It says that 3 means an owner command and the agent asks the owner to run it, and that 4 means the daemon did not answer.

Plugins:

- **SELF-91** The skill teaches the Layer shape of a plugin, including that a plugin provides its own services before `Plugin.make`.
- **SELF-92** The skill teaches what the loader asks of a plugin. There is no top-level await. `import.meta` is empty. A plugin can import chad's direct dependencies and nothing else. A fiber that must not run next to the plugin's previous version is started with `Plugin.background`.
- **SELF-130** The skill teaches that `chad`, `effect` and Node's built-in modules are the imports chad promises to a plugin, and that chad's other direct dependencies resolve but are not promised (see 06-plugin-api.md).
- **SELF-93** The skill teaches that a tool which starts a turn calls `Turns.queue`, which returns once the request is saved and does not wait for the outcome, and that `Turns.start` called from a tool handler for the thread of its own turn fails at once with a message that names `Turns.queue` (see 06-plugin-api.md).
- **SELF-94** The skill teaches that chad renders a prompt chunk before every turn, so a plugin whose chunk must stay fixed for a session keeps the text itself.
- **SELF-95** The skill teaches that `turn.prompt` is what chad sends the model, while the owner's words are `turn.origin.message.text`.
- **SELF-96** The skill teaches that a plugin's store has no expiry, so a plugin prunes its own keys, and that `chad db query` is how the agent reads the database.
- **SELF-97** The skill teaches that nothing a plugin keeps in memory is sure to survive from a tool call or `beforeTurn` to `afterTurn`, and that what must survive goes in the plugin's store.
- **SELF-98** The skill teaches that a background fiber that waits on `Turns.start` can lose the outcome at a reload, and that it reads the outcome in `afterTurn` or from the store.
- **SELF-99** The skill teaches that a tool call still running 30 seconds into a swap is interrupted and may have partly run.

Settings, secrets and MCP servers:

- **SELF-100** The skill teaches the shape of `chad.json`, shown below, that a secret is written `${NAME}`, and that a literal `${X}` is written `${CHAD_DOLLAR:-$}{X}`.
- **SELF-101** The skill teaches that an empty string reads as missing, and that a `${NAME}` found nowhere fails the plugin's load. It does not say that a missing name reads as missing.
- **SELF-102** The skill teaches that `chad check` and `chad apply` list the keys a plugin read and warn about keys it did not read, and that `chad status` is the one place a bundled plugin's settings can be seen.
- **SELF-103** The skill teaches that `"enabled": false` holds a plugin's timers and keeps its data, and that turning the plugin back on fires each overdue timer once.
- **SELF-104** The skill teaches that a secret is saved with `chad secret set` reading stdin, is named as `${NAME}` in `chad.json` and `mcp.json`, and is never written into a file in the repo.
- **SELF-105** The skill teaches that an MCP server is added by editing `mcp.json` and applying, and that no command adds one.
- **SELF-106** The skill names `chad mcp logout`, and it describes `chad mcp restart` as rebuilding every server and not as reconnecting one.

The image:

- **SELF-107** The skill teaches that the agent has no sudo and no apt, that `node` is in the image, and that npm globals, uv tools and binaries in `~/.local/bin` persist on the volume and sit last on PATH, so they cannot replace the image's own tools.
- **SELF-108** The skill teaches that the daemon's log is `/data/logs/chad.log` and that the directories the owner mounts sit under `/mnt`.

```json
{ "plugins": { "<name>": { "enabled": false, "settings": { ... } } } }
```

## CI checks on the skill

The skill names commands, paths and messages that live in other parts of chad. These checks run in CI on the built image and fail the build when the skill and the image disagree.

- **SELF-109** CI type-checks every `ts` block in each bundled skill, so in `credentials` and `diagnose` as well as `self-edit` (see 17-testing.md).
- **SELF-110** CI runs `chad plugin new ci-sample` in a scratch repo and then `chad check`, which has to pass. The starter file is checked this way because its template has placeholders and cannot be type-checked as written.
- **SELF-111** CI checks that every `chad` command, flag and exit code each bundled skill names exists.
- **SELF-112** CI checks that every path each bundled skill names exists in the image. That includes the path in the type-check footer, each `ai-docs` file `plugin.md` names, `/data/repo/examples/` and the two examples `plugin.md` names. This check is what catches a later effect snapshot that drops `AGENTS.md`.
- **SELF-113** CI checks that every chad message each bundled skill quotes appears in chad's source. It matches each quoted message against the templates of the one `Messages` module, which holds what chad posts in chat, its CLI errors and the messages the model reads as tool results (see 17-testing.md).
- **SELF-114** CI decodes the `mcp.json` and `chad.json` examples in each bundled skill with the apply's own code.
- **SELF-115** CI runs the malformed-skill check on the bundled skills.
- **SELF-116** CI runs the doc comment check on the plugin API (see 17-testing.md).

## Bundled skill hashes and the changed-skill notice

A repo skill with a bundled skill's name hides the bundled one. After an image upgrade the owner's copy may be older than the skill the new image ships, and nothing else would say so.

- **SELF-117** When a repo skill wins over a bundled skill of the same name, the apply says so (see 12-skills-and-mcp.md).
- **SELF-118** chad keeps a hash of each bundled skill in `state/` on the volume.
- **SELF-119** A first boot stores the hashes and sends no notice.
- **SELF-129** The name and format of the file under `state/` that holds the hashes, what a hash covers, and what chad does when that file is missing or cannot be read are specified in 12-skills-and-mcp.md.
- **SELF-120** When a later image changes a bundled skill that a repo skill hides, the owner gets one notice. Its wording, where it is posted and when it may be sent again are in 16-failures-logs-status.md.
- **SELF-121** `chad status` marks a repo skill that hides a bundled one.
- **SELF-122** v1 has no command that merges a repo skill with the bundled one and no command that shows their difference.

## MCP calls during a rebuild

- **SELF-123** What a running turn's MCP call does while chad rebuilds the MCP servers is specified in 12-skills-and-mcp.md. The MCP section of the skill states those results for the agent and quotes that part's messages exactly, including the 120 second limit on a held call.

## Text of the skill

The two files below are the starting point for the bundled skill. They are not normative. A line that ends in a comment of the form `<!-- adjusted: ... -->` differs from the prototype to match a later decision, and the comment is not part of the shipped file.

`SKILL.md`:

````markdown
---
name: self-edit
description: Read before changing chad itself. Covers adding or fixing a plugin (a tool, a prompt chunk, a hook, a background job), a skill, an MCP server, a plugin setting, a secret or the persona, and undoing a change that went wrong.
---

# Changing chad

Your plugins, skills, MCP servers, settings and persona are files in one git repo on the data volume. You change yourself by editing those files and applying them with the `chad` CLI. Nothing you edit takes effect until an apply.

## Where things are

```
/data/repo/work/              the checkout you edit
  plugins/<name>.ts           a plugin (or plugins/<name>/index.ts)
  skills/<name>/SKILL.md      a skill
  mcp.json                    MCP servers
  chad.json                   plugin settings and on/off switches
  persona.md                  who you are for the owner
/data/repo/live               what is loaded now. Never edit it.
/data/repo/node_modules/      what a plugin can import, with its declarations and docs
/data/repo/examples/          the source of the plugins chad ships, to read as examples
/data/logs/chad.log           the daemon's log
/data/home                    $HOME
/mnt/<name>                   a directory the owner mounted
```

- Your skills go in `work/skills/` and nowhere else. Never create a `.agents/skills` or `.kiro/skills` directory in the repo, and do not put skills in dot-directories under `$HOME`. A skill in one of those two directories in the repo is announced to you with no apply, so no check ran on it and no revert covers it. `chad check` and `chad apply` refuse both directories. <!-- adjusted: TIM-559 -->
- Never write an `AGENTS.md` in the repo. One under `work/` reaches you with no apply, and `chad check` and `chad apply` refuse it. What you should always know goes in `persona.md`, and only when the owner asks. <!-- adjusted: TIM-559 -->
- A directory under `/mnt` is outside the repo. It has no commits and no revert.
- `/data/repo/examples/` is the source of the bundled plugins for the version that is running. Read it, do not edit it, and do not copy a bundled plugin into `work/plugins/` under its own name. Do not put anything at `/data/repo/examples` or `/data/repo/node_modules`. <!-- adjusted: TIM-553 -->

## The loop

1. Edit files under `/data/repo/work`. `chad plugin new <name>` and `chad skill new <name>` write a starting file and do nothing else.
2. `chad check`. It runs everything an apply runs and commits nothing. Fix what it reports and run it again.
3. `chad apply -m "<why>"`.
4. `chad status` shows what is loaded, what was skipped and why, and the chad and effect versions.

## Rules that are easy to get wrong

- An apply takes the whole of `work/`, drafts from another session included. Read the list of changed files that `chad check` prints. If a file there is not yours, stop and tell the owner.
- A change reaches a session on its next turn. In the turn that applied it you keep the tools you had. A tool whose plugin's code you changed fails with "changed by an apply" until the turn ends. A change to only that plugin's settings reaches your running turn at once, unless it changes a tool's description, or the tool's parameters stop accepting the value. Then that tool waits for the next turn too. <!-- adjusted: TIM-552 -->
- An apply that changes a plugin's code affects other sessions. Their running turns lose that plugin's tools until they end, and a call still running 30 seconds into the swap is interrupted and may have partly run. The apply output names the affected sessions. Say so in your answer.
- An apply resets the branch in `work/` to the applied commit, so commits you make there do not last. Use git in `work/` to read history or bring one file back (`git checkout <commit> -- plugins/x.ts`), then apply.
- A secret never goes in a file in the repo. Save it with `chad secret set NAME`, with the value on stdin, and write `${NAME}` where it is needed in `chad.json` or `mcp.json`.
- In a scheduled run, or any turn whose prompt says nobody is there to answer questions, do not apply, revert, purge or change safe mode unless the prompt tells you to. Leave the change as a draft and say so in the answer.

## Testing a change

- Apply, say what you changed, and test in the next turn.
- While your turn has a background sub-agent running, a message the owner sends is steered into that turn and runs on the old Agent, so the new version is not there yet. The refusal says so: "The new version is in your next turn, which cannot start while this turn has a sub-agent running." <!-- adjusted: TIM-552 -->
- With no owner around, schedule a one-off cron job that runs the test. Its prompt has to stand on its own: what to call, with what, and what counts as a pass. It runs as a new turn that has only the history.
- If the cron plugin is off, report what you changed and stop. Do not look for another way to start a turn.

## Exit codes

- 0: done.
- 1: it ran and failed. The output says what and where, with `work/` paths.
- 2: bad usage.
- 3: an owner command. Ask the owner to run it. Do not work around it.
- 4: the command needs the daemon and it is missing or did not answer. Run `chad status` and `chad logs`, then tell the owner. <!-- adjusted: TIM-559 -->

## Plugins

Before you write one, read `/data/repo/node_modules/effect/AGENTS.md` and then `plugin.md` next to this file. Start from `chad plugin new <name>`. Working plugins to read are in `/data/repo/examples/`.

- A repo plugin cannot take a bundled plugin's name, and `chad plugin new` refuses a taken or bundled name.
- `chad plugin reload <name>` rebuilds one plugin whose code did not change, for example after a service it talks to came back. It builds the new version first and keeps the old one if the build fails.
- Deleting a plugin's file unloads it and keeps its data and timers. `chad plugin purge <name>` drops them for good. It works only once the deletion is applied, and refuses a plugin still in the applied repo, including one that is off. A bundled plugin cannot be deleted, so it can be purged while it is turned off and not while it is on. <!-- adjusted: TIM-559 -->

## Skills

A skill is `skills/<name>/SKILL.md` with `name` and `description` in its front matter. The name has to match the directory. The description is all a session sees until it reads the skill, so write it as "read this when ...". Put longer material in files next to it and name them in the skill.

- A check or an apply fails on a skill with no front matter, a missing or empty `name` or `description`, a name that differs from its directory, or two skills in the repo with one name.
- A skill with a bundled skill's name replaces the bundled one, and that includes this skill. Do not copy this skill to change it. Write the owner's conventions as a separate skill.

## MCP servers

Edit `mcp.json` and apply. There is no command that adds one.

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data/home/notes"] },
    "linear": { "url": "https://mcp.linear.app/mcp" },
    "github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }
  }
}
```

- stdio servers run with `npx`, `uvx` or `node`. The image has no Python packages, no apt and no sudo. What you install with `npm install -g`, `uv tool install` or into `~/.local/bin` stays on the volume and sits last on PATH, so it cannot replace the image's own tools.
- `chad check` reads `mcp.json`, checks that every `${NAME}` resolves and prints which servers an apply would add, remove or change. It connects nothing. A malformed `mcp.json` fails the apply.
- A server that cannot connect does not fail the apply. The apply prints each server's status and tool count.
- Any MCP restart pauses every session's MCP calls until the servers are back, and a stdio server loses what it held in memory. An apply that changes `mcp.json`, `chad mcp restart`, a finished login and a change to a secret that `mcp.json` names all restart every server.
- A call made during a restart is held until the servers are back. If that takes more than 120 seconds it fails with "MCP servers are restarting. This call was not sent." Nothing ran, so call again. <!-- adjusted: TIM-555 -->
- After a restart a tool's parameters may have changed. When a call fails validation, check it against the tool's current declaration.
- "needs login" means an OAuth server with no token. Run `chad mcp login <name>`. chad posts a link in the thread. The owner opens it, signs in, and pastes the address the browser ends on back into the thread. You never see that message. The command returns as soon as the link is posted, so do not wait on it. A pending login expires after 10 minutes.
- `chad mcp logout <name>` deletes a server's stored tokens.
- `chad mcp restart` restarts every MCP server. Run it when a server dropped. Nothing restarts one by itself.

## Settings and secrets

`chad.json` holds each plugin's settings and its on/off switch.

```json
{ "plugins": { "weather": { "enabled": true, "settings": { "latitude": -36.85, "token": "${WEATHER_TOKEN}" } } } }
```

- `"enabled": false` turns a plugin off and keeps its data and timers. This works for bundled plugins too. Turning a plugin back on fires each overdue held timer once, and the apply says how many.
- An unknown key or an entry that names no plugin fails the apply.
- An empty string reads as missing. A `${NAME}` found nowhere fails the load with an error that names it.
- `${NAME:-default}` gives a default. To write a literal `${X}`, write `${CHAD_DOLLAR:-$}{X}`.
- `chad status` lists the settings each loaded plugin read and where each came from. It is the only place a bundled plugin's settings are listed.
- `chad secret set NAME`, `chad secret list`, `chad secret rm NAME`. There is no way to read a value back. Changing a secret reloads what names it. If a plugin fails to load with the new value, it keeps its old instance, the command exits 1 and the secret stays stored. `chad status` marks it as running with the previous secret.
- For a password or a code that a tool signs in with, read the `credentials` skill.

## The persona

`persona.md` is who you are for the owner. It is plain Markdown and goes into your system prompt.

- Edit it only when the owner asks you to.
- When the owner mounts a directory, record its path under `/mnt` and what it holds in `persona.md`, then apply.

## Undoing

- `chad log` lists the applies. `chad revert` goes back one, `chad revert <commit>` further. A revert covers the whole repo and saves what was in `work/` to a git ref it prints.
- To undo one file, restore it with git in `work/` and apply.

## Safe mode

- In safe mode nothing from the repo is loaded. An apply still runs every check and commits, and its change loads when safe mode goes off (`chad safe off` or `/safe off`). Turning a bundled plugin on or off in `chad.json` takes effect at once.
- Turn safe mode off only when the owner asked you to fix the problem and your fix is applied. If safe mode started by itself, ask first.
- Never turn safe mode on unless the owner asks.

## When a check or an apply fails

Most errors say what to fix. These do not:

| What you see | What it means |
| --- | --- |
| `Plugin.make` does not compile and names a service | A contribution still needs one of your own Layers. Add `Layer.provide(YourService.layer)` to it. |
| A setting is missing, and it is in `chad.json` | Its value is an empty string, which reads as missing. |
| The apply worked and the tool is not there | It arrives next turn. |
| A hook does nothing | A hook that fails or runs past its budget is logged and skipped. Read `/data/logs/chad.log`. After three failures in a row of the same hook, chad tells the owner once. |
````

`plugin.md`:

````markdown
# Writing a plugin

Before you write a plugin, read `/data/repo/node_modules/effect/AGENTS.md`. It is how Effect is written in the version chad ships. Its examples are under `/data/repo/node_modules/effect/ai-docs/src/`, and the ones a plugin needs are `01_effect/03_services`, `01_effect/05_resources`, `50_http-client/10_basics.ts` and `71_ai/20_tools.ts`. Trust these files and the `.d.ts` files over what you remember about Effect.

Three things in the examples do not apply to a plugin:

- chad provides `HttpClient`, so do not provide your own.
- chad runs the plugin, so there is no `runMain` or `Layer.launch`.
- You can import only chad's direct dependencies.

Read in this order:

1. `/data/repo/node_modules/effect/AGENTS.md`, for how to write Effect.
2. `/data/repo/node_modules/chad/dist/Plugin.d.ts`, `Session.d.ts` and `Turns.d.ts`, for the plugin API. Their doc comments say what each call does.
3. One bundled plugin as a worked example: `/data/repo/examples/cron/` or `/data/repo/examples/send-file.ts`. These are the plugins chad ships, at the version that is running.

Plugins compile against the effect and chad packages under `/data/repo/node_modules`. Their `package.json` files give the versions, and so does `chad status`. This is Effect 4. Names you remember from Effect 3, such as imports from `@effect/platform` where this version has `effect/http`, are the most common cause of type errors.

A plugin is one TypeScript file, `plugins/<name>.ts`, or a directory with `plugins/<name>/index.ts` and the local files it imports. Its name is the file or directory name. Its default export is a Layer made with `Plugin.make`.

## The shape

```ts
import { Plugin } from "chad"
import { Config, Context, Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { HttpClient } from "effect/http"

class NotesError extends Schema.TaggedError<NotesError>()("NotesError", {
  message: Schema.String
}) {}

// The plugin's own service. Built once per load and shared by everything below.
class Api extends Context.Service<Api, {
  search(query: string): Effect.Effect<string, NotesError>
}>()("plugins/notes/Api") {
  static readonly layer = Layer.effect(
    Api,
    Effect.gen(function*() {
      const url = yield* Config.String("url")
      const client = yield* HttpClient.HttpClient

      const search = Effect.fn("Api.search")(function*(query: string) {
        const response = yield* client.get(url, { urlParams: { q: query } })
        return yield* response.text
      }, Effect.mapError((cause) => new NotesError({ message: String(cause) })))

      return Api.of({ search })
    })
  )
}

const Notes = Toolkit.make(
  Tool.make("notesSearch", {
    description: "Search the owner's notes. Call it before answering a question about something they wrote down.",
    parameters: Schema.Struct({ query: Schema.String }),
    success: Schema.String,
    failure: NotesError
  })
)

const NotesTools = Plugin.toolkit(Notes).pipe(
  Layer.provide(Notes.toLayer(Effect.gen(function*() {
    const api = yield* Api
    return Notes.of({ notesSearch: ({ query }) => api.search(query) })
  }))),
  Layer.provide(Api.layer)
)

const Chunk = Plugin.prompt(() => Effect.succeed("The owner keeps notes. Search them with notesSearch."))

export default Plugin.make(NotesTools, Chunk)
```

- Every contribution function returns a Layer. Give it what it needs with `Layer.provide`, then hand every Layer to `Plugin.make`.
- chad supplies `PluginContext`, `Turns`, `Chat`, `HttpClient`, `FileSystem`, `Path` and `DateTime.CurrentTimeZone`. Anything else is yours to provide before `Plugin.make`, which fails to compile and names what is missing.
- Two contributions that provide the same Layer share one instance of it.

## What the loader asks

- No top-level await.
- `import.meta` is empty, so a plugin cannot find files next to itself.
- A plugin can import chad's direct dependencies and nothing else. They are the `dependencies` in chad's `package.json` under `/data/repo/node_modules/`. A plugin has no dependencies of its own. From chad itself the importable modules are `chad`, `chad/Plugin`, `chad/Session` and `chad/Turns`. Only `chad`, `effect` and Node's built-in modules are promised to stay importable. The other dependencies resolve today and can be gone in a later version. <!-- adjusted: TIM-553, TIM-559 -->
- A fiber that runs for the plugin's whole life is started with `Plugin.background(effect)`. A fiber forked while the Layer builds runs next to the previous version's for a moment after an apply.

## Tools

- Tool names are shared with every other plugin and with your built-in tools. A taken name fails the load, and the error names who holds it.
- The description is all the model knows about the tool. Say what it does and when to call it. `chad check` reports a description that still starts with "Replace me", and `chad apply` refuses it. <!-- adjusted: TIM-549 item 18 -->
- A tool learns its session and turn by listing `Session.CurrentSession` in its `dependencies`.
- A tool cannot tell you from one of your sub-agents.
- After an apply that changes the plugin's code, a turn that is still running cannot call its tools until the turn ends.
- A tool call still running 30 seconds into a swap is interrupted and may have partly run. Keep tools with side effects short or safe to repeat.

## Prompt chunks

- `Plugin.prompt(render)` is rendered before every turn, inside 2 seconds. An empty string means no chunk. A render that fails leaves the session with the text it last saw.
- If a chunk has to stay the same for a whole session, keep the text in the store and return what you kept.
- A chunk that changes during a session reaches it as an update message.

## Hooks

- `Plugin.beforeTurn` runs on the reply path, inside 5 seconds. A string it returns is added to the turn as context.
- `turn.prompt` is what chad sends the model. The owner's words are `turn.origin.message.text`, and only when `turn.origin._tag === "Message"`.
- `turn.resumed` is true for a turn picked up after a restart. `beforeTurn` runs again for it.
- `Plugin.afterTurn` runs after the answer is posted, inside 30 seconds, one at a time per plugin. A turn that ends as chad is killed never reaches it.
- `Plugin.onSession` gets `Reset` and `Compacted`, inside 10 seconds. More events may be added, so match with a default.
- A hook that fails or runs past its budget is logged and skipped, and the turn carries on. After three failures in a row of the same hook, chad tells the owner once.
- Nothing held in memory is sure to last from a tool call or `beforeTurn` to `afterTurn`, because an apply can swap the plugin in between. What must last goes in the store.

## State

- `PluginContext.store` is a `KeyValueStore` only this plugin can see, kept in the database.
- It has no expiry. Prune your own keys.
- Queued hooks run on the new version after a reload, so the new version reads keys the old one wrote. Decode stored values with a schema that accepts the old shape.
- `chad db query` reads the database from outside.

## Settings

- `Config.String("url")` reads `plugins.<name>.settings.url` from `chad.json` and nothing else. There is no fallback to the environment.
- A secret is `Config.Redacted("token")`, written as `"${NAME}"` in `chad.json`.
- Give a setting a default where one makes sense, so the plugin loads with an empty `chad.json`.
- List the settings in the comment block at the top of the file. `chad check` prints the keys the plugin read and warns about keys in the file it did not read.
- A tool whose description is built from a setting changes when that setting does, so a running turn loses it until its next turn. The same holds when a setting changes a tool's parameters so that they stop accepting the value. <!-- adjusted: TIM-552 -->

## Starting turns

- `Turns.start({ thread, prompt, label })` runs a turn in that thread's session and posts the answer there.
- The prompt has to say what started the turn and that nobody is there to answer questions, whether the turn comes from `Turns.start`, `Turns.queue` or `Turns.schedule`. The agent reads that line to know it must not apply changes unasked. <!-- adjusted: TIM-559 -->
- A tool starts a turn with `Turns.queue(options)`, which returns once the request is saved and does not wait for the outcome. `Turns.start` called from a tool for the thread of its own turn fails at once, and the error names `Turns.queue`. <!-- adjusted: TIM-559 -->
- A background fiber that waits on `Turns.start` loses the outcome at a reload. Read the outcome in `afterTurn` or from the store.
- `Turns.schedule`, `cancel` and `scheduled` are timers that survive a restart.
- A plugin-started turn whose answer is exactly `[SILENT]` posts nothing.
- To post without the agent, use `Chat`.

## The owner

- `PluginContext.owners` holds the owner ids as `<platform>:<id>`.
````

## Gaps

- **SELF-G1** [builder] The path of the bundled skills directory in the image. TIM-537 item 3 says only that bundled skills ship as a directory in the image.
- **SELF-G3** [builder] The wording of the type-check footer line, the "Replace me" error, the malformed-skill errors, the three rewritten errors, the output of `chad plugin new` and the mark in `chad status` on a repo skill that hides a bundled one. TIM-549 items 3, 18, 19, 20 and 23 give the content and no text.
- **SELF-G4** [builder] The wording of the safe mode line in the system prompt. TIM-549 item 15 gives its two points and no text.
- **SELF-G5** [builder] The rest of the core prompt's text beyond the two fixed sentences. TIM-549 item 14.
- **SELF-G6** [builder] How an empty or missing `persona.md` renders in the system prompt, and whether the persona gets a heading there. TIM-549 item 16.
- **SELF-G8** [builder] How CI finds the commands, flags, exit codes, paths and quoted messages in a skill's prose. TIM-549 item 21 and TIM-558 items 32 and 33 give the rules and what a quoted message is matched against, and no method for finding one.
- **SELF-G9** [builder] How `<camelName>` is derived from a name that has hyphens or starts with a digit. TIM-549 item 17.
- **SELF-G10** [builder] What `chad skill new` writes inside `SKILL.md`. TIM-542 item 11 gives the path only.
- **SELF-G11** [builder] Ten of the 17 corrections to the first drafts are not listed anywhere. TIM-549 item 6 says all are applied in the drafts, and round 1 lists seven.
- **SELF-G15** [builder] Whether `self-edit` points at the `diagnose` skill, or names `chad logs`, where its draft sends the agent to `/data/logs/chad.log`. TIM-557 items 11 and 43 add the command and the skill and say nothing about this skill's text.
- **SELF-G16** [builder] Which command is effect's build step in SELF-27, and how the image build gets effect's source when it holds only the tarballs under `vendor/`. TIM-549 item 22 names the step and no command, and nobody has run it. Recommended: the build clones effect at the manifest's commit and runs the script of that repository that fills the `AGENTS.md` and `ai-docs/**/*` entries of the `files` list in `packages/effect/package.json`. If the repository has no such script, the build copies `AGENTS.md` and `ai-docs/` as they sit in that tree.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| SELF-1 | TIM-549 item 1 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-2 | TIM-549 item 1 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-3 | TIM-549 item 1 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-4 | TIM-549 item 1, round 1 point 1 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-5 | TIM-549 item 2 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-6 | TIM-549 item 5, round 2 corrections | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| SELF-7 | TIM-549 item 7 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-8 | TIM-549 item 7, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `cli` |
| SELF-9 | TIM-549 item 31 and "Not settled here" | Architect (Tim has not read) | not run |  | `definition` | - |
| SELF-10 | TIM-537 item 3, TIM-549 item 19 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-11 | TIM-546 item 22, TIM-549 "Passed on to other tickets" | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-12 | Tim's comment on TIM-549 of 2026-11-14 17:51 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-13 | TIM-549 item 2, kept by the repo/examples follow-up item 3 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-14 | TIM-549 "Changed by TIM-553", TIM-553 "How well each is supported" | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| SELF-15 | TIM-549 item 3 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| SELF-16 | TIM-549 item 3 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-17 | TIM-549 item 4 as changed by TIM-558, TIM-558 item 31, TIM-530 as changed by TIM-549 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| SELF-18 | TIM-549 "Changed by TIM-553", TIM-553 decision 3 | Architect (Tim has not read) | run | TIM-553 | `rule` | `bundled-skills` |
| SELF-19 | TIM-549 item 4, kept by the repo/examples follow-up item 1; TIM-541 as changed by TIM-549 | Tim | run |  | `rule` | `apply` |
| SELF-20 | TIM-549 repo/examples follow-up item 2, TIM-553 claims | Tim | run |  | `rule` | `apply` |
| SELF-21 | TIM-549 repo/examples follow-up item 2, TIM-538 as changed by TIM-549, TIM-549 "Changed by TIM-553" | Tim | run |  | `rule` | `apply` |
| SELF-22 | TIM-549 repo/examples follow-up item 3 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-23 | TIM-549 repo/examples follow-up item 4, TIM-548 item 11 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-24 | TIM-549 "Changed by TIM-553", TIM-553 decision 9 | Architect (Tim has not read) | run |  | `rule` | `apply` |
| SELF-25 | TIM-549 "Changed by TIM-553" | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-26 | TIM-549 item 22, TIM-541 as changed by TIM-549, TIM-549 "Changed by TIM-553" | Architect (Tim has not read) | run |  | `rule` | `loader` |
| SELF-27 | TIM-549 item 22 and comment "From Tim: effect snapshots include AGENTS.md"; TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| SELF-28 | TIM-549 item 22, round 2 point 1 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| SELF-29 | TIM-549 item 3 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-30 | TIM-549 item 3 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-31 | TIM-549 item 3, "What Architect changed" | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-32 | TIM-549 item 3 and item 17 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SELF-33 | TIM-549 item 3, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SELF-34 | TIM-549 item 3, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SELF-35 | TIM-549 round 2 point 1 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SELF-36 | TIM-549 item 3 | Architect (Tim has not read) | not run |  | `definition` | - |
| SELF-37 | TIM-549 item 14, TIM-531 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `bundled-skills` |
| SELF-38 | TIM-549 item 15, TIM-531 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `apply` |
| SELF-39 | TIM-549 item 15 and "What Architect changed", TIM-531 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `apply` |
| SELF-40 | TIM-549 item 8, round 2 point 2 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| SELF-41 | TIM-549 item 16, TIM-534 as changed by TIM-549 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| SELF-42 | TIM-549 item 16, TIM-531 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `settings` |
| SELF-43 | TIM-549 item 16, TIM-531 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `settings` |
| SELF-44 | TIM-549 item 16, TIM-534 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `apply` |
| SELF-45 | TIM-549 item 16, TIM-534 item 6 | Tim | not run |  | `rule` | `settings` |
| SELF-46 | TIM-549 item 11, TIM-534 item 10 | Tim | not run |  | `definition` | - |
| SELF-47 | TIM-542 item 11, TIM-549 item 17 | Tim | not run |  | `rule` | `apply` |
| SELF-48 | TIM-542 item 11 | Tim | not run |  | `rule` | `apply` |
| SELF-49 | TIM-549 item 17 and "How well each is supported" | Architect (Tim has not read) | run |  | `rule` | `apply` |
| SELF-50 | TIM-549 item 17, repo/examples follow-up item 3 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SELF-51 | TIM-549 item 17 and item 21 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SELF-52 | TIM-549 item 18, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SELF-53 | TIM-548 item 16 | Architect (Tim has not read) | not run |  | `definition` | - |
| SELF-54 | TIM-549 item 18, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549, TIM-559 | `rule` | `apply` |
| SELF-55 | TIM-549 item 19, TIM-537 follow-up, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `skills-mcp` |
| SELF-56 | TIM-549 item 19, TIM-537 follow-up, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `skills-mcp` |
| SELF-57 | TIM-549 item 19 and round 2 point 3 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `skills-mcp` |
| SELF-58 | TIM-549 item 19 and round 2 corrections | Architect (Tim has not read) | not run | TIM-549 | `rule` | `skills-mcp` |
| SELF-59 | TIM-549 item 19 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| SELF-60 | TIM-549 item 19, TIM-537 follow-up, TIM-557 items 36, 37, 38 and 40 | Architect (Tim has not read) | not run | TIM-549, TIM-557 | `rule` | `skills-mcp` |
| SELF-61 | TIM-549 item 19 and round 2 corrections | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| SELF-62 | TIM-549 item 20 | Architect (Tim has not read) | not run |  | `rule` | `loader` |
| SELF-63 | TIM-549 item 20, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `loader` |
| SELF-64 | TIM-549 item 20, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `loader` |
| SELF-65 | TIM-549 item 20, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `plugin-api` |
| SELF-66 | TIM-549 item 20 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-67 | TIM-549 item 8, TIM-534 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `bundled-skills` |
| SELF-68 | TIM-549 item 8 and round 2 point 2, TIM-540 item 16 | Architect (Tim has not read) | read |  | `rule` | `bundled-skills` |
| SELF-69 | TIM-549 item 8, TIM-530 as changed by TIM-549, TIM-559 round 3 SELF-G16 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-70 | TIM-549 "Not settled here", round 2 point 2 | Architect (Tim has not read) | not run |  | `definition` | - |
| SELF-71 | TIM-549 item 9, TIM-534 and TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `bundled-skills` |
| SELF-72 | TIM-549 item 9, TIM-534 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `bundled-skills` |
| SELF-73 | TIM-542 as changed by TIM-549, TIM-549 round 1 corrections | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SELF-74 | TIM-549 item 10 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-75 | TIM-549 item 11, TIM-534 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `bundled-skills` |
| SELF-76 | TIM-549 item 11, TIM-534 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `bundled-skills` |
| SELF-77 | TIM-549 item 12 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-78 | TIM-549 "Changed by TIM-552", TIM-552 decision 7 | Tim | run |  | `rule` | `bundled-skills` |
| SELF-79 | TIM-547 item 7, TIM-552 decision 1, TIM-549 item 12 as changed by TIM-552 | Tim | run |  | `rule` | `settings` |
| SELF-80 | TIM-549 item 12 and round 1 point 7 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-81 | TIM-549 item 12 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-82 | TIM-549 item 12 | Architect (Tim has not read) | not run |  | `definition` | - |
| SELF-83 | TIM-549 item 13 | Architect (Tim has not read) | not run | TIM-547, TIM-549 | `rule` | `bundled-skills` |
| SELF-84 | TIM-549 body, from TIM-534 item 2 and TIM-538 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-85 | TIM-549 body, from TIM-538 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-86 | TIM-549 body, from TIM-542 item 9 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-87 | TIM-549 body, from TIM-531 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-88 | TIM-549 comment "From four tickets closed on 2026-11-14", from TIM-547; run in TIM-552 | Architect (Tim has not read) | run | TIM-547 | `rule` | `bundled-skills` |
| SELF-89 | TIM-549 body, from TIM-542 items 7 to 12; round 1 corrections; TIM-559 round 3 C7 | Tim; the purge of a bundled plugin that is off Architect (Tim has not read) | not run | TIM-559 | `rule` | `bundled-skills` |
| SELF-90 | TIM-549 body and item 1, from TIM-542 item 27 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-91 | TIM-549 body, from TIM-530 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-92 | TIM-549 body, from TIM-538; round 1 corrections, from TIM-541 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-93 | TIM-559 ruling on API-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `bundled-skills` |
| SELF-94 | TIM-549 body, from TIM-539 and TIM-531 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-95 | TIM-549 body, from TIM-539 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-96 | TIM-549 body, from TIM-536 item 6 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-97 | TIM-549 comment "From four tickets closed on 2026-11-14", from TIM-547 | Architect (Tim has not read) | not run | TIM-547 | `rule` | `bundled-skills` |
| SELF-98 | TIM-549 comment "From four tickets closed on 2026-11-14" and round 1 corrections, from TIM-547 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-99 | TIM-549 comment "From four tickets closed on 2026-11-14" and round 1 corrections, from TIM-547; run in TIM-552 | Architect (Tim has not read) | run | TIM-547 | `rule` | `bundled-skills` |
| SELF-100 | TIM-549 comment "From four tickets closed on 2026-11-14", from TIM-548 items 1, 5 and 6 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-101 | TIM-549 round 1 corrections, from TIM-548 items 4 and 5 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-102 | TIM-549 comment "From four tickets closed on 2026-11-14", from TIM-548 items 14 and 16 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `bundled-skills` |
| SELF-103 | TIM-549 comment "From four tickets closed on 2026-11-14", from TIM-548 items 7 and 8 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-104 | TIM-549 body, from TIM-542 items 14 and 15 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-105 | TIM-549 body, from TIM-537 item 5 | Tim | not run |  | `rule` | `bundled-skills` |
| SELF-106 | TIM-549 round 1 corrections, from TIM-537 item 6 and TIM-542 item 13 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-107 | TIM-549 comment "From four tickets closed on 2026-11-14" and round 1 corrections, from TIM-541 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-108 | TIM-549 comment "From four tickets closed on 2026-11-14", from TIM-541 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-109 | TIM-549 item 21 as changed by TIM-558, TIM-558 item 32, TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-110 | TIM-549 item 21, round 1 point 4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SELF-111 | TIM-549 item 21 as changed by TIM-558, TIM-558 item 32, TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-112 | TIM-549 item 21 as changed by TIM-558, repo/examples follow-up item 5, comment "From Tim: effect snapshots include AGENTS.md", TIM-541 as changed by TIM-549, TIM-558 item 32, TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-113 | TIM-549 item 21 as changed by TIM-558, TIM-558 items 32 and 33, TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-114 | TIM-549 item 21 as changed by TIM-558, TIM-558 item 32, TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-115 | TIM-549 item 21 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-116 | TIM-549 item 21 and item 4 as changed by TIM-558, TIM-558 item 31 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| SELF-117 | TIM-537 item 3 | Tim | not run |  | `rule` | `skills-mcp` |
| SELF-118 | TIM-549 item 23, TIM-537 follow-up | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| SELF-119 | TIM-549 item 23 and round 1 point 5 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| SELF-120 | TIM-549 item 23, TIM-537 follow-up, TIM-557 items 36, 37, 38 and 40 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| SELF-121 | TIM-549 item 23, TIM-542 as changed by TIM-549 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `skills-mcp` |
| SELF-122 | TIM-549 item 23 | Architect (Tim has not read) | not run |  | `definition` | - |
| SELF-123 | TIM-549 items 24 to 30, TIM-537 follow-up as changed by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `bundled-skills` |
| SELF-124 | TIM-557 item 43, TIM-549 and TIM-541 as changed by TIM-557 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-125 | TIM-558 item 39 | Architect (Tim has not read) | not run |  | `rule` | `live` |
| SELF-126 | TIM-557 item 39, TIM-534 and TIM-550 as changed by TIM-557 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| SELF-127 | TIM-558 item 50 | Architect (Tim has not read) | not run |  | `definition` | - |
| SELF-128 | TIM-559 ruling on SELF-G2 | Architect (Tim has not read) | not run | TIM-549, TIM-559 | `definition` | - |
| SELF-129 | TIM-559 ruling on SELF-G7 | Architect (Tim has not read) | not run |  | `definition` | - |
| SELF-130 | TIM-559 ruling on API-G12 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `bundled-skills` |
| SELF-131 | TIM-559 round 3 A1 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `bundled-skills` |
| SELF-132 | TIM-559 round 3 A1 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| SELF-133 | TIM-559 round 3 A1, TIM-559 round 4 item 7 | Architect (Tim has not read) | not run | TIM-559 | `definition` | - |
| SELF-134 | TIM-559 round 3 A2 | Architect (Tim has not read) | not run | TIM-559 | `definition` | - |
| SELF-135 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `harness` |
