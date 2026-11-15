# The repo, applying, and recovering from a bad self-edit

chad changes itself by editing files on its data volume, and this part says how it stays repairable when one of those edits is wrong. It covers the git repo that holds the editable files, the difference between a draft and an applied commit, what an apply checks and commits, what a boot loads and skips, safe mode, `chad revert` and `chad log`, extra mounted directories, what is kept outside the repo and refused to the agent, and where a notice goes when no turn is running. It leans on 07-plugin-loading.md for the loader and the order of an apply, 08-apply-and-swap.md for what a live session sees when versions change, 10-cli.md for the commands, their exit codes and the owner-command refusal, 01-image-and-volume.md and 02-storage.md for the volume and its files, and 11-settings.md and 12-skills-and-mcp.md for `chad.json`, skills and `mcp.json`. The wording of every notice, the rule for when a notice is sent again, the log and `chad status` are in 16-failures-logs-status.md, and the tests are in 17-testing.md.

Terms used below. The agent is the model working through clanka inside the daemon. The owner is the person chad answers to. The repo is the git repository at `repo/work/` on the data volume. An apply is a run of `chad apply`, the only way an edit in the repo reaches the running daemon. A draft is an edit in `repo/work/` that has not been applied. An applied commit is a commit that an apply or a revert made on the `applied` branch. An exported tree is a plain copy of the repo's files at one snapshot, written under `repo/versions/`. A bundled plugin or bundled skill is one that ships inside the image, as opposed to one in the repo.

## What chad guards against

- **REC-1** chad guards against the agent's mistakes and not against a hostile agent. The agent's shell commands run as the daemon's user, so nothing on the volume can be protected from it. Deliberate damage is left to backups of the volume (see 02-storage.md).
- **REC-2** Only the image and the container's environment variables are out of the agent's reach.
- **REC-3** A change to what chad loads takes effect only through a `chad` CLI command. chad has no file watcher.

## What lives in the repo

```
/data/repo/work/              the git repo. The agent edits here.
  plugins/<name>.ts           a plugin (or plugins/<name>/index.ts)
  skills/<name>/SKILL.md      a skill
  mcp.json                    MCP servers
  chad.json                   plugin settings and on/off switches
  persona.md                  the persona
```

- **REC-4** Plugins, skills, the MCP server config, the plugin settings and the persona are files in one git repo.
- **REC-5** A plugin is `plugins/<name>.ts` or `plugins/<name>/index.ts`. A skill is `skills/<name>/SKILL.md`. The MCP server config is `mcp.json`, the plugin settings are `chad.json` and the persona is `persona.md`, all three at the repo root (see 07-plugin-loading.md, 11-settings.md, 12-skills-and-mcp.md and 14-self-edit-skill.md).
- **REC-6** `chad serve` on an empty volume creates the repo with a first commit. The first commit includes `chad.json` as `{ "plugins": {} }` and an empty `persona.md`.
- **REC-7** Secrets stay out of git by where they are stored, which is `secrets/` on the volume. `mcp.json` and `chad.json` refer to a secret by name, as `${NAME}`, and never hold its value. The repo is local and is never pushed. v1 has no secret scanner.
- **REC-8** The SQLite file, the secrets, the chat connections, the files under `state/`, the session working directories and `home/` sit outside the repo. An apply never commits them and a revert never changes them.
- **REC-112** The first commit holds `chad.json` and `persona.md` and nothing else, and it is the first commit of the `applied` branch. A revert and the boot after a restore therefore always have an applied commit to start from.
- **REC-113** The branch checked out in `repo/work/` is named `main`.
- **REC-114** chad makes its commits with the git identity `chad` and `chad@localhost`.
- **REC-115** chad writes that identity into the repo's own git config when it creates the repo, so the agent's `git commit` in `work/` works with no global git config.

## The directories under repo/

The daemon never loads from the directory the agent edits. `repo/live` names the copy of the repo that is loaded, and an apply is what moves it.

```
/data/repo/
  work/               the one git repo, with its .git
  versions/<tree>/    an exported tree, named by its git tree id
  live                symlink to versions/<tree>, the applied tree
  node_modules        symlink to the image's node_modules
  package.json        says "type": "module"
  examples            symlink to the bundled plugins' source inside the chad package
```

- **REC-9** The repo is one git repo at `repo/work/`, and that is where the agent edits. A session's Agent starts in `sessions/<session-id>/`, so the agent reaches `repo/work/` by path.
- **REC-10** `repo/live` is a symlink to an exported tree under `repo/versions/<tree>/`. It is not a checkout, a git worktree or a second clone.
- **REC-11** The daemon loads plugins, skills, `mcp.json`, `chad.json` and the persona only from an exported tree. An apply loads from the tree it just exported, and a boot loads from the tree `repo/live` points at. Nothing is ever loaded from `repo/work/`.
- **REC-12** `repo/node_modules` is a symlink to the image's `node_modules`, `repo/package.json` says `"type": "module"`, and `repo/examples` is a symlink to the bundled plugins' source inside the chad package. All three sit above `work/` and outside git. Nothing loads from `repo/examples`. It is there for the agent to read (see 07-plugin-loading.md and 01-image-and-volume.md).
- **REC-13** `versions/`, `live`, `node_modules`, `package.json` and `examples` are derived. chad creates them at boot when they are missing. A backup takes `repo/work/` with its `.git` and nothing else from `repo/`, and the first boot after a restore rebuilds `versions/` and `live` from the head of the `applied` branch.
- **REC-14** At boot chad replaces a link found at `repo/examples` or `repo/node_modules` without asking. Anything else at those paths is moved to `<name>.replaced-<timestamp>` and logged.
- **REC-15** The applied history is the `applied` branch of the repo. Each apply that changes something adds one commit to it, and so does each revert.
- **REC-149** Provisional, open with Tim. The paths in this part are the image's, where the data volume is mounted at `/data`. `CHAD_DATA` names another data directory for running chad outside the image, and the whole of `repo/` follows it, the two links `repo/node_modules` and `repo/examples` included. Setting `CHAD_DATA` is not a supported way to move the volume inside the image (see 01-image-and-volume.md).

## Drafts and applied commits

- **REC-16** An edit in `repo/work/` that has not been applied is a draft. It changes nothing in the running daemon, and a boot does not load it.
- **REC-17** After an apply, `git status` in `work/` is clean. From then on `git diff` in `work/` shows the draft, and `chad status` says whether `work/` holds one (see 16-failures-logs-status.md).
- **REC-18** An apply covers the whole of `work/`, so it takes a draft that another session left there. Its output lists every changed file. v1 has no apply limited to paths.
- **REC-19** An apply resets the branch in `work/` to the applied commit. A commit the agent made itself in `work/` between applies leaves the branch and stays only in the reflog.
- **REC-20** The applied commits are reachable from `work/`. To undo one plugin or one file, the agent restores it with git in `work/`, for example `git checkout <commit> -- plugins/x.ts`, and then applies.
- **REC-21** Drafts in `work/` are part of a backup (see 02-storage.md).
- **REC-152** One kind of draft reaches the model with no apply, and it is the one exception to REC-11 and REC-16. clanka reads `AGENTS.md` and looks for `.agents/skills` and `.kiro/skills` in the directories around the agent's working directory, so an agent that changes into `repo/work/` gets such files from there (see 12-skills-and-mcp.md for how far that reaches). chad does not stop the read. `chad check` and an apply refuse `AGENTS.md`, `.agents/` and `.kiro/` instead, so none of them can become part of an applied commit. They look on disk in `repo/work/` as well as in the exported tree, so a draft of one that `.gitignore` keeps out of the snapshot of REC-22 is refused too. A boot does not look for them. It loads as usual when the applied tree or `repo/work/` holds one, and it raises no notice (see 07-plugin-loading.md for the refusal, its message, the two directories the look on disk leaves out, and the boot).

## What an apply checks

An apply never checks or loads the files in `work/` directly. It takes a snapshot, writes the snapshot out as an exported tree and works on that copy. The mechanics, the git commands and the order of the steps are in 07-plugin-loading.md. The full list of what fails an apply is in 10-cli.md.

- **REC-22** An apply takes its snapshot of `work/` with `git add -A` into a temporary index followed by `git write-tree`. The agent's own index, HEAD and branch are untouched, and `.gitignore` is respected.
- **REC-23** The snapshot does not miss an edit. A copied git index keeps the mtime of the original, or the snapshot starts from an empty index.
- **REC-24** chad exports the snapshot's tree to `repo/versions/<tree>/`, and every check and every load reads from that directory.
- **REC-25** An apply runs `tsc` on the exported tree, checks that each plugin's default export is a `Plugin.Plugin`, builds each plugin's Layer, and runs a trial `Agent.makeWith` with every plugin's tools. The trial exists because clanka dies on a tool name clash.
- **REC-26** A type error blocks the apply. There is no flag that skips the type-check or any other check.
- **REC-27** chad writes the tsconfig for each check itself, so no file in the repo can loosen the type-check.
- **REC-28** A malformed `mcp.json` fails an apply like any other failed load. An MCP server that fails to connect does not fail an apply.
- **REC-29** A failed apply changes nothing. The last good version keeps running, no session changes, `live`, the `applied` branch and `work/` stay as they were, and chad deletes the newly exported tree. The command prints the error and exits 1.
- **REC-30** Error text from a check or a load names `work/` paths and not paths in the exported tree, for example `work/plugins/dice.ts(23,30): error TS2322` and `at connect (work/plugins/broken.ts:6:9)`.

In the prototype that ran these checks the trial `Agent.makeWith` was a stand-in that compared tool names, and clanka was not loaded.

## What an apply commits

- **REC-31** On success an apply commits the snapshot's tree on the `applied` branch, repoints the `repo/live` symlink with a rename, resets the branch in `work/` to the new commit and deletes the older exported trees.
- **REC-32** `chad apply` requires `-m <why>`. The apply records that message and the session that ran it, which it takes from the `CHAD_SESSION` variable.
- **REC-33** An apply with nothing changed exits 0 and makes no commit.
- **REC-34** An apply cancelled before its commit changes nothing. From its commit on, an apply moves `live`, swaps the plugin versions and writes its log line inside a region the CLI client cannot interrupt, so it finishes even when the client is killed. The region gives way to a graceful stop.
- **REC-35** When a graceful stop cuts an apply after `live` has moved, the next boot loads the new version (see 08-apply-and-swap.md).
- **REC-36** `chad check` does everything an apply does up to the commit and throws the result away.
- **REC-37** `chad apply`, `chad check` and `chad revert` need the running daemon and take a place in its one queue. An apply started while the daemon is still booting queues behind the boot. With no daemon they exit 4 and write nothing (see 10-cli.md).
- **REC-108** An apply, a revert, a `chad safe on` and a `chad safe off` that are run from a session each post one line of Discord subtext in that session's thread when they succeed. For an apply the line is the one below, and it names the applied commit. The same command run from the owner's shell posts nothing, and a command that failed and changed nothing posts nothing. A reload that exits 1 after some of its plugins swapped is covered in 08-apply-and-swap.md. The same rule covers `chad plugin purge`, `chad secret rm` and `chad timezone` (see 10-cli.md for those commands).
- **REC-116** An apply records its `-m` text as the message of the applied commit and its session id as a trailer line on that commit. Git is the only store of both, so the record is in every backup of `work/` and can be read when the database cannot.
- **REC-117** An apply with nothing changed posts no line under REC-108, because it did not change what is loaded.
- **REC-118** `/safe on|off` typed in chat posts no line under REC-108, because the command's own text is already in the thread.
- **REC-119** When the volume fills before the commit of an apply or a revert, the command is a failed apply under REC-29.
- **REC-120** When the volume fills from the commit on, the apply or the revert exits 1, and the CLI's message says that the commit was made and that it loads at the next start. The next boot settles `live` by REC-121.
- **REC-146** An apply that finishes writes the log event `apply.done`. An apply that is refused or fails writes the log event `apply.failed`, which carries the stage and the error. Both names are in the closed list of events in 16-failures-logs-status.md.
- **REC-147** An apply, a revert, `chad safe on|off`, `/safe on|off` and the `connection` and `owner` commands each write the log event `command.ran` when they finish, as every CLI or chat command that changes something does. The line carries the command, the caller, which is the owner, a session id or the daemon, and the outcome, and it never carries a secret's value. It is the only trace of an agent that changed an owner, a connection, a secret or safe mode (see 16-failures-logs-status.md).

The line an apply posts under REC-108:

```
Applied `<sha>`: <first line of the `-m` message>
```

## What a boot loads and skips

An apply is strict and a boot is lenient. An apply can refuse because the last good version is still running. A boot has nothing to fall back on, so it loads what it can and reports the rest.

- **REC-38** A boot loads what `repo/live` points at, which is the last applied commit, through the same bundle loader an apply uses.
- **REC-121** When `repo/live` and the head of the `applied` branch name different trees at boot, the head of `applied` wins. The boot first makes `live` name the tree of that commit, exporting it if needed, and then loads `live` (see 07-plugin-loading.md for how a tree is exported). The commit is the record that lasts, and its tree passed every check before it was committed.
- **REC-39** A boot type-checks nothing.
- **REC-40** At boot a plugin whose Layer fails to build is skipped. So is a plugin whose Layer takes more than 30 seconds to build.
- **REC-41** At boot a plugin whose tool name clashes with a name that a new image uses is skipped.
- **REC-42** When a new image ships a bundled plugin whose name a repo plugin already uses, the bundled one loads and the repo one is skipped. The notice says that the two share one key-value table and that renaming the repo plugin does not move its data.
- **REC-150** At boot a plugin whose file or directory name breaks the plugin name rule is skipped like any other plugin that cannot load, under the notice key `plugin-skipped:<name>`. `chad check` and an apply refuse such a plugin (see 07-plugin-loading.md for the name rule and the refusal, and 16-failures-logs-status.md for the notice, which quotes the name and cuts it).
- **REC-43** At boot a plugin whose settings name a `${NAME}` that is found neither in the secret store nor in process env is skipped (see 11-settings.md).
- **REC-44** The plugins that were not skipped load. One notice to the owner names the skipped plugins, with one line for each, and `chad status` lists each plugin and why a skipped one was skipped. A plugin that is skipped at every boot is announced once (see 16-failures-logs-status.md).
- **REC-45** A malformed `mcp.json` at boot starts chad with no MCP servers and tells the owner. chad catches the error from clanka's `McpConfig.load` to do so. A server that cannot connect is marked failed and the rest carry on.
- **REC-46** At boot a `chad.json` that cannot be parsed counts as empty, with a notice to the owner. Unknown keys and entries that name no plugin are ignored with a notice (see 11-settings.md).
- **REC-151** At boot a `plugins` value in `chad.json` that is not a JSON object is ignored, and the other keys of the file stand. At boot a plugin's entry whose `enabled` value is not a boolean is ignored as a whole, with its `settings`, and the plugin gets what a plugin with no entry gets. Both are listed in the notice with the key `settings-ignored`. They are rules for a boot only, because `chad check` and an apply refuse both (see 11-settings.md, which also says what the same entry does in safe mode).
- **REC-47** At boot a malformed skill is skipped with a notice (see 12-skills-and-mcp.md).
- **REC-48** No file in the repo can stop a boot. The things outside the repo that do stop one are listed in 01-image-and-volume.md.
- **REC-49** A timer whose plugin is not loaded, because it was skipped at boot or is off in safe mode, is held until the plugin loads again. If it is overdue by then, it fires once (see 13-timers-and-cron.md).
- **REC-122** chad does not by itself try again a plugin that a boot skipped.
- **REC-123** `chad plugin reload <name>` builds a skipped plugin and loads it when the build succeeds, so a skipped plugin can come back without an apply or a restart (see 10-cli.md).
- **REC-124** The reload that `chad secret set` triggers also tries a skipped plugin whose settings name that secret (see 10-cli.md and 11-settings.md).
- **REC-125** A skipped plugin that loads clears the notice key `plugin-skipped:<name>` (see 16-failures-logs-status.md for every check that clears the key).
- **REC-126** A boot that cannot write `state/boot-count` or `state/safe-mode` logs the failure and does not stop.

## Safe mode

Safe mode is the owner's way back to a chad that works when something in the repo broke it. The agent stays reachable in safe mode and can still edit, check, apply and revert, so the usual repair is done in chat.

- **REC-50** Safe mode is chad as the image ships it. Nothing from the repo is loaded, which means no repo plugins, no MCP servers, no repo skills and no persona.
- **REC-51** chad passes clanka an explicit list of skills in place of clanka's own discovery, so a skill placed under `$HOME` is never loaded, in safe mode or out of it (see 12-skills-and-mcp.md).
- **REC-52** Bundled plugins stay on in safe mode and run on their defaults. Every bundled plugin builds from its defaults alone, and the image tests check that with a boot in safe mode (see 17-testing.md).
- **REC-53** Safe mode reads one thing from the repo, which is `"enabled": false` on bundled plugins in the applied `chad.json`. A bundled plugin the owner turned off stays off in safe mode. If that read fails, every bundled plugin is on.
- **REC-54** In safe mode sessions and their history are kept, the chat connections still load, and the agent can still read and fix the files in the repo.
- **REC-55** There are three ways into safe mode by hand. They are the environment variable `CHAD_SAFE_MODE=1`, `/safe on|off` typed in chat, and `chad safe on|off`.
- **REC-56** A toggle from chat or the CLI is stored in the file `state/safe-mode`, outside the repo, so it survives a restart. The file is written by temp file and rename and read before SQLite is opened, so safe mode works when the database is what broke. With no daemon running, `chad safe on|off` writes the file itself.
- **REC-57** `CHAD_SAFE_MODE=1` forces safe mode on whatever the stored value is.
- **REC-58** A toggle reaches each session on its next turn. Turning safe mode on or off always renders the system prompt again, and while safe mode is on the rendered prompt has one more line that says so and says that nothing from the repo is loaded (see 08-apply-and-swap.md).
- **REC-59** `chad safe on` is a swap to nothing on the one swap path. It unloads everything that came from the repo. The queued hooks of each plugin it switches off are dropped and logged, and their timers are held. A call from a running turn to a tool of such a plugin fails with the message below, and the turn carries on.
- **REC-60** `chad safe off` loads `live` the way a boot does. It skips what fails to load, names it, and never refuses.
- **REC-61** `/safe on|off` in chat runs the same daemon call as `chad safe on|off`, prints the same text and does not go through the model.
- **REC-62** An apply in safe mode runs every check, commits and moves `live`, and loads nothing. Its output says that the change loads when safe mode goes off. A revert in safe mode does the same and still resets `work/`.
- **REC-63** An apply or a revert in safe mode that flips `enabled` for a bundled plugin takes effect at once, in both directions.
- **REC-64** `chad safe` is not an owner command, so the agent may run it. When it does is a rule in the bundled `self-edit` skill and not a check in the CLI. The agent turns safe mode off only when the owner asked it to fix the problem and the fix is applied. If safe mode started by itself, the agent asks first. It never turns safe mode on unless the owner asks (see 14-self-edit-skill.md).
- **REC-127** `state/safe-mode` holds one word, which is `on` for a toggle by hand or `auto` for safe mode that chad started itself. The file is absent when safe mode is off (see 02-storage.md).
- **REC-128** While `CHAD_SAFE_MODE=1` is set, `chad safe off` and `/safe off` change nothing. Safe mode stays on and `state/safe-mode` keeps the value it had. Each prints the same line, which names the variable and says that it holds safe mode on, and `chad safe off` exits 1 (see 10-cli.md for the exit codes). A command that exits 1 after it changed something would mislead an agent that reads the exit code, so the stored value is left alone as well.
- **REC-129** `/safe` and `chad safe` with no argument print whether safe mode is on and what turned it on, and they change nothing.

The message a running turn's call gets from REC-59:

```
<tool> is off in safe mode.
```

## Automatic safe mode after unclean boots

An unclean boot is a boot whose daemon died without stopping on purpose. A plugin that crashes the daemon while it loads would otherwise crash it again on every restart, with nobody able to reach the agent.

- **REC-65** Three unclean boots in a row start chad in safe mode, and chad tells the owner. The notice names the last apply by its commit, its message and when it was made, and it tells the owner to fix or revert that apply and then turn safe mode off (see 16-failures-logs-status.md for the wording).
- **REC-66** The count is kept in the file `state/boot-count`, written by temp file and rename and read before SQLite is opened.
- **REC-67** The boot counter goes up by one after the daemon has taken its lock and the check of `state/version` has passed, and before the socket, the shard count guard and the database (see 01-image-and-volume.md for the boot order). The counter comes after the version check so that a boot refused for a newer `state/version` has nothing to put back.
- **REC-68** The boot counter clears 60 seconds after the boot finished loading, and it clears when the SIGTERM handler runs.
- **REC-69** A crash, an out-of-memory kill, a power cut and the kill of a frozen daemon count as unclean. A restart by the owner does not, even when Docker's default 10 second timeout ends it with SIGKILL.
- **REC-70** A boot does not count as unclean when it was refused the lock, found a newer `state/version`, could not open its socket, was refused by the shard count guard or could not open or migrate the database. Safe mode cannot fix any of those. The first two end before the counter goes up. For the other three the boot puts the counter back to the value it had before and does not clear it (see 01-image-and-volume.md).
- **REC-71** chad never reverts on its own, because it cannot know which commit was good.
- **REC-72** A freeze is not a crash, so nothing restarts a frozen daemon by itself. It needs a liveness probe that restarts the container, and that probe is `chad health` (see 01-image-and-volume.md).
- **REC-106** A crash of chad with no turn running posts nothing in chat. The crash is in stdout and in the log, and `chad status` shows that the exit before the current boot was unclean (see 16-failures-logs-status.md). The third unclean boot in a row brings the notice of REC-65.
- **REC-107** The 30 seconds of REC-40 and the 60 seconds of REC-68 are values of the one `Timings` service, and the shipped chad has no setting that changes them (see 17-testing.md).
- **REC-130** The boot that starts in safe mode is the one that finds three unclean boots before it. This matches the notice, which says that chad crashed on its last three starts.
- **REC-131** Automatic safe mode writes `auto` to `state/safe-mode`, so it lasts across restarts until `chad safe off` or `/safe off`.
- **REC-132** Starting safe mode does not reset the boot counter. The counter clears by REC-68 as it does on any other boot.
- **REC-133** `state/boot-count` holds one decimal number (see 02-storage.md).
- **REC-148** Provisional, open with Tim. A stop that chad's own 60 second deadline cuts exits with code 1 and is not an unclean boot, because the SIGTERM handler cleared the counter (REC-68) before it started the deadline's timer. A blocked event loop stops that timer, and Docker's kill at 90 seconds is then the backstop. Whether that boot counts as unclean follows from REC-68 alone. It does not count when the handler ran before the loop blocked, and it counts when the handler never ran, as the kill of any frozen daemon does (REC-69). The deadline itself is in 01-image-and-volume.md.

In the image run, three restarts under Docker's default 10 second timeout each left the counter at 1, three `docker kill` runs counted 1, 2 and 3, and stopping a daemon frozen with SIGSTOP left the counter at 1. The start of safe mode from the counter was not run.

## Plugins that break at runtime

A plugin can pass every check and still fail while chad runs. chad contains the failure and reports it. It does not switch the plugin off.

- **REC-73** A plugin tool that fails or dies fails only that call. clanka turns the handler's exit into a response to the agent's script, and the turn continues.
- **REC-74** Hooks fail soft. A hook that fails, dies or runs past its budget is logged and skipped, and the turn carries on (see 06-plugin-api.md). After 3 failures in a row of the same hook, chad sends the owner one notice. It does not send that notice again while the hook keeps failing, restarts included, or when the hook starts failing again within 24 hours of it (see 16-failures-logs-status.md).
- **REC-75** chad never disables a plugin by itself. The asphodel plugin would otherwise be disabled every time its sidecar restarts.
- **REC-76** Plugin tools and hooks run on the daemon's main thread, and only the agent's scripts run in a worker. A synchronous loop in a plugin freezes the whole daemon, and no hook budget can interrupt it. The liveness probe is the answer to that.
- **REC-77** The daemon also writes its log to `logs/chad.log` on the volume, so the agent can read why a plugin was skipped or a hook failed. The agent reads it with `chad logs` (see 16-failures-logs-status.md for the command and the log's format, and 01-image-and-volume.md).
- **REC-134** chad keeps a separate count of failures in a row for each hook of each plugin. Where the count is held is left to the builder (see Gaps), as long as REC-135 holds.
- **REC-135** A success of the hook, a restart of the daemon and a swap of the plugin each reset the count. These three resets decide when the owner is told, and the 24 hour rule of REC-74 already stops a repeated notice.

## chad revert

```
chad revert             go back to the applied commit before the current one
chad revert <commit>    go back to an earlier applied commit
```

- **REC-78** `chad revert` goes back to the applied commit before the current one. `chad revert <commit>` goes back to an earlier one.
- **REC-79** A revert covers the whole repo. It runs the same checks and the same load as an apply, on the target commit's tree.
- **REC-80** A revert is recorded as a new commit on the `applied` branch, so reverting a revert works.
- **REC-81** A target that no longer loads fails like any apply and changes nothing.
- **REC-82** A revert resets `work/` to the new commit. Before it does, it saves what was in `work/` to a git ref, and it names that ref in its output.
- **REC-83** A revert never changes the chat connections, who the owner is, the secrets or the stored MCP tokens.
- **REC-84** There is no `/revert` in chat. The route from a phone is `/safe on`, then asking chad to revert or fix the change.
- **REC-85** A turn the owner did not start does not apply, revert, purge or change safe mode unless its prompt says to. This is a rule in the `self-edit` skill and not a check in the CLI (see 14-self-edit-skill.md).
- **REC-136** A revert's commit message names the commit it went back to.
- **REC-137** The save of REC-82 is a commit made from the same temporary index snapshot an apply takes (REC-22), so it keeps untracked files and respects `.gitignore`. chad stores it under the ref `refs/chad/saved/<timestamp>`, and the agent can restore from that ref with plain git.
- **REC-138** chad never prunes the saved refs in v1.
- **REC-139** The reset of `work/` in a revert deletes nothing that the save did not capture, so ignored files stay where they are.
- **REC-140** `chad revert` with no applied commit before the current one exits 1 with a message and changes nothing.
- **REC-141** `chad revert <commit>` with a commit that is not on the `applied` branch exits 1 with a message and changes nothing.
- **REC-142** A revert whose target has the same tree as the current applied commit exits 0, makes no commit and leaves `work/` as it is, as an apply with nothing changed does.

The skill's line for REC-85:

```
In a scheduled run, or any turn whose prompt says nobody is there to answer questions, do not apply, revert, purge or change safe mode unless the prompt tells you to. Leave the change as a draft and say so in the answer.
```

A revert and a boot both start from a commit that already exists, where an apply starts from a snapshot of `work/`. The code below is how the loader prototype exported the tree of an existing commit. It covers the export only. The new commit and the reset of `work/` in REC-80 and REC-82 are not in the prototype.

```ts
const checkout = (commit: string) => {
  const tree = git(["rev-parse", commit + "^{tree}"])
  const dir = path.join(VERSIONS, tree)
  if (!fs.existsSync(dir)) {
    const index = path.join(REPO, ".snapshot-index")
    const env = { GIT_INDEX_FILE: index }
    git(["read-tree", tree], env)
    git(["checkout-index", "-a", "--prefix=" + dir + "/"], env)
    fs.rmSync(index, { force: true })
  }
  return { tree, dir, fresh: false }
}
```

## chad log

- **REC-86** `chad log` lists the applied commits. It only reads, so it works with no daemon running, and it takes `--json` (see 10-cli.md).
- **REC-143** `chad log` prints one line for each applied commit, newest first, with the short commit id, the time, the session that ran the apply, or "terminal" when no session did, and the first line of the message. It reads all four from the commit itself (REC-116), so it needs neither the daemon nor the database.
- **REC-144** With `--json`, `chad log` prints an array of objects that hold the same fields in full, with the full commit id (see 10-cli.md for `--limit` and for how many commits are listed by default).

## Mounting other directories

- **REC-87** The owner can mount other directories into the container, such as an Obsidian vault. An extra mount sits at `/mnt/<name>`, which is `/mnt/vault` in the examples.
- **REC-88** An extra mount is outside the repo, so it gets no commits and no revert. Backing it up is the owner's job.
- **REC-89** A read-only mount is how the owner protects a mounted directory from the agent.
- **REC-90** The agent learns that a mount exists from the persona. It records a mounted directory in `persona.md`, with its path under `/mnt` and what it holds, and it edits that file only when the owner asks.
- **REC-91** "One data volume" means one volume for chad's own state.

## What is stored outside the repo and refused to the agent

A chat connection is one chat platform's token together with the ids of the owners allowed to talk to chad on it. Connections decide who can reach chad at all, so they are kept where an apply and a revert cannot touch them, and the CLI does not let the agent change them.

- **REC-92** Chat connections are stored in `secrets/connections.json` on the volume, outside the repo, and are managed through the CLI. The store holds more than one connection. v1 ships Discord and a `local` connection kind for development and tests (see 17-testing.md), and Slack stays out of scope.
- **REC-93** No environment variable supplies a Discord token in v1.
- **REC-94** An apply never commits a connection, and a revert never changes who the owner is.
- **REC-95** chad sets the marker variable `CHAD_SESSION=<session id>` on every command the agent runs (see 10-cli.md for the spawner).
- **REC-96** When `CHAD_SESSION` is set, the CLI refuses the `connection` and `owner` commands with exit 3 and tells the agent to ask the owner. The same refusal covers the other owner commands, and 10-cli.md holds the list of them and of the commands that stay open to the agent. Only the CLI refuses, and the daemon does not.
- **REC-97** The refusal is not a security boundary. The agent can read a secret file if it goes looking, and it can get round a refusal by unsetting the variable or by writing the file itself. v1 stops neither. The refusals stop an agent that is confused or was told something by a web page.
- **REC-98** A token is checked against the platform before it is saved, and the old token is kept if the check fails. The daemon makes the check when it is running, and the CLI makes it itself when no daemon runs (see 10-cli.md).
- **REC-99** Removing the last owner id of a connection, or the last connection, needs `--force` (see 10-cli.md for the commands and their exit codes).
- **REC-100** A wrong token or a dropped owner id cuts the chat channel. The repair is then from a terminal, with `docker exec` or `kubectl exec`. REC-96, REC-98 and REC-99 exist to keep that rare.

## Notices outside a turn

A notice is a short message chad posts on its own account, as opposed to the agent's answer. Most notices belong to a turn and go to that turn's thread. The rules here are for a notice that has no turn.

- **REC-101** A notice outside a turn goes to the DM session in which the owner's latest message arrived. If the owner has no DM session, it goes to the session of any kind in which the owner's latest message arrived. A message counts whether it started a turn, steered one or was a chat command, and a turn that no owner's message started, such as a scheduled run, does not move the destination. A skipped plugin, an automatic safe mode and a failing hook are notices of this kind.
- **REC-102** A notice outside a turn is always logged as well.
- **REC-103** The same route carries a model login code when no session asked for it, the one notice that an MCP server dropped to "needs login", and the notice that a scheduled job's thread is gone (see 05-model-and-login.md, 12-skills-and-mcp.md and 13-timers-and-cron.md).
- **REC-104** A notice is a Discord post and can hang. The line an apply posts in its session's thread (REC-108) is forked into the daemon's scope and is not waited for, so it cannot block the queue or a stop.
- **REC-105** A notice outside a turn is a normal message and not subtext, because it is the content and not a footnote. In a server thread it carries the owner's mention. Subtext stays for lines inside a turn's flow, and no notice uses emoji (see 04-discord.md).
- **REC-109** chad writes the destination of REC-101 to the file `state/notice-thread` whenever it changes, as one JSON line with the connection's name and the thread, by temp file and rename. The shape of the line is in 02-storage.md, and the thread is the thread string defined in 03-sessions-and-turns.md. A boot that cannot use the database reads the file to tell the owner (see 16-failures-logs-status.md).
- **REC-110** When no session is known, or when the post fails twice, the notice is logged and listed under "Problems" in `chad status`. If its condition still holds when a session first exists, it is posted then (see 16-failures-logs-status.md for the "Problems" block).
- **REC-111** A notice about a condition that lasts has a key, and it is sent when the condition begins and not again while the condition holds. In this part the keys are `plugin-skipped:<name>`, `hook-failing:<plugin>:<hook>` and `safe-mode-auto`. The full rule, the check that clears each key and the wording of every notice are in 16-failures-logs-status.md.
- **REC-145** chad works out the destination of REC-101 when an owner's message arrives and updates `state/notice-thread` then, so it runs no database query to find it.

## Gaps

- **REC-G10** [builder] What `chad safe on|off` and `/safe on|off` print (TIM-542 item 22).
- **REC-G12** [builder] The wording of the safe mode line in the rendered prompt (TIM-549 item 15).
- **REC-G13** [builder] The wording of the notice of REC-42 about a repo plugin that shares a bundled plugin's name, for which the skipped-plugin notice has only one error line per plugin, and the messages chad adds to a refused apply, such as "could not be loaded", which are the prototype's own (TIM-548 item 12, TIM-557 item 40, TIM-538).
- **REC-G17** [builder] The wording of the line of REC-108 for a revert and for safe on and off (TIM-557 "Not settled here").
- **REC-G21** [builder] How long an apply takes on a repo with many files. An apply exports the whole tree, skills and persona included, and only a small repo was run (TIM-538 "Stand-ins and gaps").
- **REC-G22** [builder] Where the count of a hook's failures in a row is held. REC-135 fixes what resets it, and nothing about the count needs a migration (TIM-559 round 3 C3).
- **REC-G23** [builder] How `chad safe off` run with no daemon learns that `CHAD_SAFE_MODE=1` is set for the daemon. With no daemon the command writes `state/safe-mode` itself (REC-56), and REC-128 has it change nothing while the variable is set (TIM-559 round 3 C2).

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| REC-1 | TIM-534 item 1 | Tim | not run |  | `definition` | - |
| REC-2 | TIM-534 item 11 | Tim | not run |  | `definition` | - |
| REC-3 | map, Agreed at charting | charting | not run |  | `rule` | `apply` |
| REC-4 | TIM-534 item 2, TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| REC-5 | TIM-542 item 11, TIM-537 items 1 and 5, TIM-548 item 1, TIM-549 item 16 | Tim; chad.json and persona.md Architect (Tim has not read) | not run | TIM-549 | `rule` | `apply` |
| REC-6 | TIM-542 item 32, TIM-548 item 1, TIM-549 item 16 | Tim; the two files Architect (Tim has not read) | not run | TIM-548, TIM-549 | `rule` | `apply` |
| REC-7 | TIM-534 item 14, TIM-537 item 7, TIM-548 item 5 | Tim; chad.json Architect (Tim has not read) | read |  | `rule` | `settings` |
| REC-8 | TIM-534 items 2 and 11, TIM-536 items 1, 2 and 12 | Tim | not run |  | `rule` | `apply` |
| REC-9 | TIM-538 item 6, TIM-536 item 10 | Tim | run |  | `rule` | `apply` |
| REC-10 | TIM-538 item 6, TIM-534 comment "Changed by TIM-538" | Tim | run |  | `rule` | `apply` |
| REC-11 | TIM-534 item 3, amended by TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| REC-12 | TIM-538 item 8, TIM-538 comment "Changed by TIM-549" | Tim | run |  | `rule` | `apply` |
| REC-13 | TIM-541 facts block, TIM-542 follow-up point 2 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| REC-14 | TIM-553 item 9 | Architect (Tim has not read) | run |  | `rule` | `apply` |
| REC-15 | TIM-538 item 6, TIM-534 comment "Changed by TIM-538" | Tim | run |  | `rule` | `apply` |
| REC-16 | TIM-534 item 2 | Tim | run |  | `rule` | `apply` |
| REC-17 | TIM-538 item 6 and prototype answer 5, TIM-542 item 19 | Tim | run |  | `rule` | `apply` |
| REC-18 | TIM-542 item 9 | Tim | not run |  | `rule` | `apply` |
| REC-19 | TIM-538 "What this changes in closed tickets", TIM-534 comment "Changed by TIM-538" | Tim | run |  | `rule` | `apply` |
| REC-20 | TIM-534 item 9 and comment "Changed by TIM-538" | Tim | not run |  | `rule` | `apply` |
| REC-21 | TIM-542 follow-up point 2 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| REC-22 | TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| REC-23 | TIM-538 item 7 | Tim | run |  | `rule` | `apply` |
| REC-24 | TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| REC-25 | TIM-534 item 4, TIM-531 item 5 | Tim | run |  | `rule` | `loader` |
| REC-26 | TIM-534 item 4 | Tim | run |  | `rule` | `apply` |
| REC-27 | TIM-538 item 8 | Tim | run |  | `rule` | `loader` |
| REC-28 | TIM-534 item 4, TIM-537 item 6 | Tim | read |  | `rule` | `skills-mcp` |
| REC-29 | TIM-531 item 5, TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| REC-30 | TIM-534 item 3, TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| REC-31 | TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| REC-32 | TIM-534 item 9, TIM-542 items 9 and 29 | Tim | not run |  | `rule` | `apply` |
| REC-33 | TIM-542 item 9 | Tim | not run |  | `rule` | `apply` |
| REC-34 | TIM-542 item 6, TIM-550 item 11 | Tim; the region Architect (Tim has not read) | run | TIM-550 | `rule` | `apply` |
| REC-35 | TIM-547 item 15 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| REC-36 | TIM-542 item 8 | Tim | not run |  | `rule` | `apply` |
| REC-37 | TIM-542 items 4 and 24, TIM-550 item 7 | Tim; queueing behind the boot Architect (Tim has not read) | run | TIM-550 | `rule` | `apply` |
| REC-38 | TIM-534 item 2, TIM-538 item 10 | Tim | run |  | `rule` | `apply` |
| REC-39 | TIM-534 item 5, TIM-538 item 10 | Tim | run |  | `rule` | `apply` |
| REC-40 | TIM-534 item 5, TIM-542 item 6 | Tim | not run |  | `rule` | `apply` |
| REC-41 | TIM-534 item 5 | Tim | not run |  | `rule` | `apply` |
| REC-42 | TIM-548 item 12 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-43 | TIM-548 item 5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| REC-44 | TIM-534 item 5, TIM-542 item 19, amended by TIM-557 items 36 and 40 | Tim; the one notice and when it is sent again Architect (Tim has not read) | not run | TIM-557 | `rule` | `apply` |
| REC-45 | TIM-534 item 5 and "How well each is supported", TIM-537 body | Tim | read |  | `rule` | `skills-mcp` |
| REC-46 | TIM-548 item 12 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| REC-47 | TIM-549 item 19 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| REC-48 | TIM-534 item 5, narrowed by TIM-541 item 14 and TIM-553 item 4 | Tim; the narrowing from the volume to the repo Architect (Tim has not read) | not run | TIM-541, TIM-553 | `rule` | `apply` |
| REC-49 | TIM-540 item 18, TIM-542 item 12 | Tim | run |  | `rule` | `timers-cron` |
| REC-50 | TIM-534 item 6 | Tim | not run |  | `rule` | `apply` |
| REC-51 | TIM-537 item 1 | Tim | read |  | `rule` | `skills-mcp` |
| REC-52 | TIM-534 item 6, TIM-548 items 9 and 10, TIM-558 item 54 | Tim; defaults and the image test Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| REC-53 | TIM-548 item 9 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| REC-54 | TIM-534 item 6 | Tim | not run |  | `rule` | `apply` |
| REC-55 | TIM-534 item 6 | Tim | not run |  | `rule` | `apply` |
| REC-56 | TIM-534 item 6, TIM-536 item 2, TIM-542 item 24 | Tim | not run |  | `rule` | `apply` |
| REC-57 | TIM-534 item 6 | Tim | not run |  | `rule` | `apply` |
| REC-58 | TIM-534 item 6, TIM-549 item 15 | Tim; the prompt line Architect (Tim has not read) | not run | TIM-549 | `rule` | `apply` |
| REC-59 | TIM-547 items 1, 8 and 10 | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| REC-60 | TIM-542 item 25 | Tim | run |  | `rule` | `apply` |
| REC-61 | TIM-542 item 22 | Tim | not run |  | `rule` | `apply` |
| REC-62 | TIM-542 item 25 and follow-up point 4 | Tim; the revert Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-63 | TIM-548 item 9 | Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| REC-64 | TIM-542 item 30, TIM-549 item 9 | Tim; the skill rule Architect (Tim has not read) | not run | TIM-549 | `rule` | `bundled-skills` |
| REC-65 | TIM-534 item 7, amended by TIM-557 item 40 | Tim; what the notice names Architect (Tim has not read) | not run | TIM-557 | `rule` | `apply` |
| REC-66 | TIM-536 item 2 | Tim | not run |  | `rule` | `apply` |
| REC-67 | TIM-541 item 26, amended by TIM-559 ruling on IMG-G5 and STO-G5 | Architect (Tim has not read) | not run | TIM-541, TIM-559 | `rule` | `apply` |
| REC-68 | TIM-534 item 7, TIM-541 item 26 | Tim; the two clearing points Architect (Tim has not read) | run | TIM-541 | `rule` | `apply` |
| REC-69 | TIM-541 item 26 | Architect (Tim has not read) | run | TIM-541 | `rule` | `apply` |
| REC-70 | TIM-536 item 14, TIM-550 item 8, TIM-541 items 14 and 26, TIM-553 item 4, amended by TIM-559 ruling on IMG-G5 and STO-G5 | Tim for the database; the rest Architect (Tim has not read) | not run | TIM-541, TIM-550, TIM-553, TIM-559 | `rule` | `apply` |
| REC-71 | TIM-534 item 7 | Tim | not run |  | `rule` | `apply` |
| REC-72 | TIM-534 item 7, TIM-541 item 24 | Tim; the probe Architect (Tim has not read) | run |  | `rule` | `image` |
| REC-73 | TIM-534 "How well each is supported" | Tim | read |  | `fact` | `plugin-api` |
| REC-74 | TIM-530 item 8, TIM-534 item 8, amended by TIM-557 item 36 | Tim; when the notice is sent again Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| REC-75 | TIM-534 item 8 | Tim | not run |  | `rule` | `plugin-api` |
| REC-76 | TIM-534 "How well each is supported", TIM-538 body | Tim | read |  | `fact` | `image` |
| REC-77 | TIM-541 item 13, TIM-534 comment "Changed by tickets closed after this one", TIM-557 item 11 | Architect (Tim has not read) | not run | TIM-541, TIM-557 | `rule` | `failures` |
| REC-78 | TIM-534 item 9 | Tim | not run |  | `rule` | `apply` |
| REC-79 | TIM-534 item 9 | Tim | not run |  | `rule` | `apply` |
| REC-80 | TIM-534 item 9 | Tim | not run |  | `rule` | `apply` |
| REC-81 | TIM-534 item 9 | Tim | not run |  | `rule` | `apply` |
| REC-82 | TIM-534 item 9 | Tim | not run |  | `rule` | `apply` |
| REC-83 | TIM-534 item 11, TIM-537 item 13 | Tim | not run |  | `rule` | `apply` |
| REC-84 | TIM-534 item 9 | Tim | not run |  | `rule` | `apply` |
| REC-85 | TIM-549 item 8 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `bundled-skills` |
| REC-86 | TIM-534 item 9, TIM-542 items 24 and 26 | Tim | not run |  | `rule` | `apply` |
| REC-87 | TIM-534 item 10, TIM-541 item 16 | Tim; the path Architect (Tim has not read) | not run |  | `rule` | `image` |
| REC-88 | TIM-534 item 10 | Tim | not run |  | `rule` | `image` |
| REC-89 | TIM-534 item 10 | Tim | not run |  | `definition` | - |
| REC-90 | TIM-534 item 10, TIM-549 item 11 | Tim; what is recorded Architect (Tim has not read) | not run | TIM-549 | `rule` | `bundled-skills` |
| REC-91 | TIM-534 item 10 | Tim | not run |  | `definition` | - |
| REC-92 | TIM-534 item 11, TIM-536 item 1, TIM-558 item 20 | Tim; the local kind Architect (Tim has not read) | not run | TIM-558 | `rule` | `cli` |
| REC-93 | TIM-542 item 34 | Tim | not run |  | `rule` | `cli` |
| REC-94 | TIM-534 item 11 | Tim | not run |  | `rule` | `apply` |
| REC-95 | TIM-534 item 12, TIM-542 item 29, TIM-550 items 3 and 4 | Tim | run |  | `rule` | `cli` |
| REC-96 | TIM-534 item 12, TIM-542 item 30, TIM-550 item 2, TIM-559 cold read | Tim; that only the CLI refuses Architect (Tim has not read) | run | TIM-550 | `rule` | `cli` |
| REC-97 | TIM-542 item 31, TIM-550 item 2 | Tim | run |  | `definition` | - |
| REC-98 | TIM-534 item 13, TIM-542 item 17, TIM-559 cold read | Tim | not run |  | `rule` | `cli` |
| REC-99 | TIM-534 item 13, TIM-559 cold read | Tim | not run |  | `rule` | `cli` |
| REC-100 | TIM-534 "Where Tim overruled the recommendation" | Tim | not run |  | `definition` | - |
| REC-101 | TIM-534 item 15, amended by TIM-559 ruling on REC-G15 | Tim; what counts as most recently active Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| REC-102 | TIM-534 item 15 | Tim | not run |  | `rule` | `failures` |
| REC-103 | TIM-535 resolution, TIM-537 item 13, TIM-540 item 19 | Tim | not run |  | `rule` | `timers-cron` |
| REC-104 | TIM-550 item 11, amended by TIM-557 item 39 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-105 | TIM-533 item 12, amended by TIM-557 item 37 | Architect (Tim has not read); no emoji Tim | not run | TIM-557 | `rule` | `failures` |
| REC-106 | TIM-557 item 42 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-107 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-108 | TIM-557 item 39, TIM-550 comment "Changed by TIM-557", amended by TIM-559 ruling on SWAP-G13 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `apply` |
| REC-109 | TIM-557 items 35 and 38, TIM-534 comment "Changed by TIM-557", amended by TIM-559 rulings on STO-G18 and REC-G15 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| REC-110 | TIM-557 item 38 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| REC-111 | TIM-557 items 36 and 40, TIM-534 comment "Changed by TIM-557" | Architect (Tim has not read) | not run | TIM-557 | `rule` | `apply` |
| REC-112 | TIM-559 ruling on REC-G5 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-113 | TIM-559 ruling on REC-G5 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-114 | TIM-559 ruling on REC-G5 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-115 | TIM-559 ruling on REC-G5 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-116 | TIM-559 ruling on REC-G2 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-117 | TIM-559 ruling on REC-G18 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-118 | TIM-559 ruling on REC-G18 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-119 | TIM-559 ruling on REC-G20 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-120 | TIM-559 ruling on REC-G20 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| REC-121 | TIM-559 ruling on REC-G6 and LOAD-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| REC-122 | TIM-559 ruling on REC-G19 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-123 | TIM-559 ruling on REC-G19 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| REC-124 | TIM-559 ruling on REC-G19 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `settings` |
| REC-125 | TIM-559 ruling on REC-G19 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-126 | TIM-559 ruling on REC-G20 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-127 | TIM-559 ruling on REC-G9 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-128 | TIM-559 round 3 C2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| REC-129 | TIM-559 ruling on REC-G11 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-130 | TIM-559 ruling on REC-G7 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-131 | TIM-559 ruling on REC-G7 and REC-G9 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-132 | TIM-559 ruling on REC-G7 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-133 | TIM-559 ruling on REC-G9 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-134 | TIM-559 ruling on REC-G14, amended by TIM-559 round 3 C3 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| REC-135 | TIM-559 ruling on REC-G14, TIM-559 round 3 C3 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-136 | TIM-559 ruling on REC-G2 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-137 | TIM-559 ruling on REC-G3 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-138 | TIM-559 ruling on REC-G3 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-139 | TIM-559 ruling on REC-G3 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-140 | TIM-559 ruling on REC-G4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-141 | TIM-559 ruling on REC-G4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-142 | TIM-559 ruling on REC-G4 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| REC-143 | TIM-559 ruling on REC-G1 and CLI-G2 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-144 | TIM-559 ruling on REC-G1 and CLI-G2 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-145 | TIM-559 ruling on REC-G15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| REC-146 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-147 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-148 | TIM-559 round 2 R5, TIM-553 question 1 and its stand-in answer | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| REC-149 | TIM-559 round 2 R5, TIM-553 question 2 and its stand-in answer | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-150 | TIM-559 round 3 A2 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| REC-151 | TIM-559 round 3 L2, TIM-559 round 4 item 6 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| REC-152 | TIM-559 round 3 A1, TIM-559 round 4 items 7 and 8 | Architect (Tim has not read) | read for clanka's walk; the refusal and the boot not run |  | `rule` | `apply` |
