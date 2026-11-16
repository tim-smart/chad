# Skills and MCP servers

This part covers the two kinds of extension that are plain files in the repo and are not plugins. A skill is a set of instructions the model reads on demand, and an MCP server is an external tool server. The part says where both live, how chad hands them to clanka, how a change reaches open sessions, what clanka's own walk of a session's working directory shows a session without an apply, how an HTTP MCP server signs in, and what a tool call does while the MCP servers are being restarted. It leans on 09-repo-and-recovery.md for the repo, the apply and safe mode, on 07-plugin-loading.md for the exported tree and the `live` link, on 08-apply-and-swap.md for how a session rebuilds its Agent, on 10-cli.md for the commands, on 14-self-edit-skill.md for what the bundled skill tells the agent, on 15-credentials.md for the secret store, on 01-image-and-volume.md for the image's runtimes and the stop budget, on 16-failures-logs-status.md for the notices to the owner, and on 17-testing.md for the tests.

## Terms used in this part

A skill is a directory that holds a file named `SKILL.md`. The system prompt lists each skill's name and description, and the model reads the rest when a task matches.

MCP (Model Context Protocol) is the protocol clanka speaks to external tool servers. A stdio server is a child process of the daemon that is spoken to over its standard input and output. An HTTP server is reached over streamable HTTP.

The MCP layer is clanka's `McpServers` service, built from one reading of the MCP config. It connects every server when it is built and has no way to add, remove or reconnect one server afterwards. A rebuild is chad closing the layer and building a new one, which restarts every server.

A key is the name clanka gives one MCP tool, written `"<server>.<tool>"`. In a script the model calls it as `mcp.<server>.<tool>`. The `<server>` part is clanka's identifier for the server, derived from the name the server has in the config. In the messages below `<name>` is the configured name.

A turn takes its keys once, when it starts. A running turn is a turn that has taken its keys. A sub-agent takes its own keys when it is spawned.

The secret store is the file of named secrets on the volume, outside the repo (see 15-credentials.md).

## Where skills live and how a session gets them

clanka can find skills in two ways. Left alone it discovers them in `.agents/skills` and `.kiro/skills` under the session directory and under `$HOME`, and in `$HERMES_HOME/skills`. Given a list it uses the list and nothing else, lists each skill by name and description in the last section of the system prompt, and gives the model a `readSkill` tool that returns a skill's content by name. chad uses the list, so that skills go through the apply, the commit and the revert like everything else the agent can change.

- **MCP-1** Skills live at `skills/<name>/SKILL.md` at the root of the repo. The agent writes them under `repo/work/skills/`, and the daemon reads them from the applied tree through `repo/live` (see 07-plugin-loading.md).
- **MCP-2** A skill under `work/skills/` is a draft until an apply. No session sees it before that.
- **MCP-3** chad scans the skill directories itself and passes clanka an explicit list of skills in the `skills` option each time it builds an Agent. The list takes the place of the skills clanka discovers when an Agent is built, so a skill under `$HOME/.agents/skills`, `$HOME/.kiro/skills` or `$HERMES_HOME/skills` is not listed.
- **MCP-4** Each entry in the list carries the skill's name, its description and its content. chad appends the skill's directory to the content, so the agent can find the files that sit next to `SKILL.md`.
- **MCP-102** For a repo skill the directory chad appends is the absolute path through the `live` link, `repo/live/skills/<name>`. The link stays valid after later applies, where the exported tree it points at today is deleted.
- **MCP-103** For a bundled skill the directory chad appends is the skill's directory in the image.
- **MCP-104** The text chad appends says that edits go in `repo/work/skills/<name>`. An agent that is handed a `live` path edits there, and that edit is lost at the next apply.
- **MCP-5** A session sees a new, removed or renamed skill on its next turn, when it rebuilds its Agent. A skill change renders the session's system prompt again (see 08-apply-and-swap.md).
- **MCP-6** A plugin contributes no skills and no MCP servers in v1.
- **MCP-7** Safe mode loads no skills and no MCP servers from the repo (see 09-repo-and-recovery.md).
- **MCP-146** The sentence chad appends to a repo skill's content is "This skill's files are in <live path>. To change the skill, edit its copy in <work path> and run chad apply. An edit under <live path> is lost at the next apply." For a bundled skill it is "This skill is bundled with chad and its files are in <image path>, which is read-only. To change the skill, copy its directory to <work path>, edit it there and run chad apply. The repo's copy then hides the bundled one." The sentence follows the skill's trimmed text after a blank line.
- **MCP-105** Bundled skills stay listed in safe mode. They are part of the image, and `self-edit` and `diagnose` are what the agent needs to repair the repo from safe mode.
- **MCP-8** `chad skill new <name>` writes `skills/<name>/SKILL.md` into `work/` and does nothing else. A name is made of lower-case letters, digits and hyphens, and the command refuses a name that is taken or that a bundled skill uses (see 10-cli.md).

The shape clanka takes, read from clanka 0.28.0:

```ts
// src/AgentSkills.ts
export class ProvidedSkill extends Schema.Class<ProvidedSkill>("ProvidedSkill")({
  name: Schema.String,
  description: Schema.String,
  content: Schema.String,
}) {}

// src/Agent.ts, an option of Agent.makeWith
/**
 * The skills offered to the model. Unset uses the skills discovered on the
 * executor; a list, possibly empty, replaces them. The model reads a
 * skill's content with `readSkill`, which runs on the loop side.
 */
readonly skills?: ReadonlyArray<AgentSkills.ProvidedSkill> | undefined
```

A skill file starts with front matter that holds its name and description:

```
---
name: <the directory's name>
description: <what a session sees until it reads the skill>
---

<the instructions>
```

## What clanka's walk shows a session without an apply

One behaviour of clanka stays on with a list in place, and it covers more than skills. After each response clanka walks up from the directory the session's agent is working in, and it shows the model what it finds in an `<environment-update>` message that it appends to the history. The walk does not look at the plain `skills/` directory or at `persona.md`, which is why the repo keeps its skills in `skills/` and its persona in `persona.md`.

- **MCP-132** After each response, clanka walks from the session's working directory upwards, whether or not chad passed a list of skills. When the working directory is inside the session's starting directory, the walk ends at the starting directory. Otherwise it ends at the nearest directory that holds a `.git` entry. In both cases it stops before it would go up into `$HOME` or into the filesystem root. The working directory itself is always visited, so the walk visits `$HOME` or the filesystem root only when that directory is the working directory. A test of its own holds this against the pinned clanka. In it a script changes into a directory below a git root that is outside the starting directory, and the next update carries what lies in every directory from there up to the git root and nothing from above it.
- **MCP-133** In every directory the walk visits, clanka reads a file named `AGENTS.md` that is not empty and the skills under `.agents/skills` and `.kiro/skills`. It appends what it has not shown before to the session's history as one `<environment-update>` message, with the `AGENTS.md` files first and the outermost directory first. What clanka found when the Agent was built counts as shown. The test of MCP-132 holds this against the pinned clanka for `AGENTS.md` and for skills alike, with a list of skills passed.
- **MCP-134** The daemon does nothing about the walk in v1, because stopping it needs a change to clanka. A draft `repo/work/AGENTS.md`, or a draft skill under `repo/work/.agents/skills` or `repo/work/.kiro/skills`, therefore reaches the model of a session whose agent works under `repo/work/`, with no apply. The same holds for such a file in any other directory the walk visits. This is the one exception to the rule that a change takes effect only through a CLI command (see 00-overview.md).
- **MCP-135** `chad check` and an apply refuse an `AGENTS.md` file, an `.agents/` directory and a `.kiro/` directory, with a message that names `skills/` and `persona.md`. They look for the three names in the exported tree and in the working tree on disk, `repo/work/`, and refuse on either. A file that `.gitignore` keeps out of the export is therefore refused as well, because the walk reads it from disk all the same. The look on disk skips `.git/` and `node_modules/`, where packages ship an `AGENTS.md` of their own, so the walk can still show a session such a file when its agent works inside one of those two directories. A boot does nothing about such a file that the applied tree or `repo/work/` already holds, after a restore or an edit by hand, and it raises no notice. The next check or apply refuses the file, and until then the walk of MCP-132 reads it like any other. 07-plugin-loading.md owns the rule and states it in full. Without the refusal a second copy of a skill would be announced beside chad's own list.

The walk was read in clanka 0.28.0, at `src/AgentEnvironment.ts:62-117`, and not run. Two examples follow from it. From `repo/work/plugins/dice` the walk visits `plugins/dice`, `plugins` and `work`, because `work/` holds `.git`. From a directory under a session's own `sessions/<session-id>/` it goes no higher than that directory. The `self-edit` skill carries one line for each kind of file. It says that skills go in `skills/` and never in `.agents/skills`, and that what would go in an `AGENTS.md` goes in `persona.md` (see 14-self-edit-skill.md).

## Bundled skills and shadowing

- **MCP-9** Bundled skills ship as a directory in the image. v1 bundles three, `self-edit` (see 14-self-edit-skill.md), `credentials` (see 15-credentials.md) and `diagnose` (see 16-failures-logs-status.md).
- **MCP-145** The bundled skills directory is `skills/` at the root of chad's package, next to `dist/`, which is `/opt/chad/skills` in the image. A missing directory holds no bundled skill.
- **MCP-10** A repo skill with the same name as a bundled skill wins. Sessions get the repo skill in place of the bundled one. This is an override and not an error, and it applies to `self-edit` as well.
- **MCP-11** The output of an apply says when a repo skill hides a bundled one.
- **MCP-12** `chad status` marks a repo skill that hides a bundled one.
- **MCP-147** The apply's line for a repo skill that hides a bundled one is "The repo skill <name> hides the bundled skill of the same name.", after the settings lines. Before it come the lines "Skills added: <names>.", "Skills changed: <names>." and "Skills removed: <names>.", each only when it names a skill, where a skill changed when the commit changed a file under its directory. The mark in `chad status` is the line "skill: <name>, from the repo, hides the bundled one", after the skipped plugins.
- **MCP-13** chad keeps a hash of each bundled skill under `state/`. A first boot stores the hashes and says nothing.
- **MCP-106** The hashes are kept in `state/bundled-skills.json`, one JSON object from a skill's name to its hash. chad writes the file to a temporary name and renames it.
- **MCP-107** A bundled skill's hash is a SHA-256 over the sorted relative paths of the files in its directory and the contents of those files.
- **MCP-108** A missing or unreadable `state/bundled-skills.json` counts as a first boot, so the shape of the file can change without a migration.
- **MCP-14** When a later image changes a bundled skill that a repo skill hides, the owner gets one notice. The notice rule and the wording are in 16-failures-logs-status.md.
- **MCP-15** v1 has no command that merges a repo skill with the bundled one it hides, and none that shows the difference.

## Checks on a skill

- **MCP-16** `chad check` and `chad apply` fail on a `SKILL.md` with no front matter, on a missing or empty `name` or `description`, on a name that differs from the skill's directory, and on two skills in the repo that share one name.
- **MCP-17** The error names the file. For a name that differs from its directory it says to set `name: <dir>`.
- **MCP-18** At boot a skill that would fail this check is skipped with a notice, and the rest load. The notice rule and the wording are in 16-failures-logs-status.md.
- **MCP-19** CI on the image runs the same check on every bundled skill (see 17-testing.md).

## The MCP config file

- **MCP-20** MCP servers are listed in one file, `mcp.json` at the root of the repo, in clanka's `{ "mcpServers": {} }` format.
- **MCP-21** A server is added, changed or removed by editing `work/mcp.json` and running `chad apply`. There is no `chad mcp add`.
- **MCP-22** v1 has no SSE transport. An entry with `"type": "sse"` is listed as unavailable with the error "SSE transport is not supported", and the other servers carry on.
- **MCP-23** A secret is never written in `mcp.json`. The file refers to it by name as `${NAME}`, and the value is stored outside the repo.
- **MCP-141** chad reads `mcp.json` at the root of the exported tree and no other MCP config. It decodes the file itself, with the keys of the table below, and does not call clanka's `McpConfig.load`, which would also read clanka's own config under `$XDG_CONFIG_HOME` or `$HOME/.config` and a `.mcp.json` beside the file. An entry that `McpConfig.load` would refuse fails the file in the same way.

An entry is a stdio server when it has a `command` and an HTTP server when it has a `url`, unless `type` says otherwise. clanka's loader accepts these keys and drops any other:

| Key | Applies to | Meaning |
| --- | --- | --- |
| `type` | both | `"stdio"` or `"http"`. Optional. |
| `command` | stdio | The program to start. |
| `args` | stdio | Its arguments, an array of strings. |
| `env` | stdio | Extra environment variables, a record of strings. |
| `cwd` | stdio | The working directory. clanka resolves a relative one against the directory of the config file and defaults to the daemon's working directory. chad refuses a relative one and fills in a missing one (MCP-109, MCP-110). |
| `url` | http | The server's URL. |
| `headers` | http | Static request headers, a record of strings. |
| `connectTimeout` | both | Milliseconds. clanka's default is 30 seconds. |
| `callTimeout` | both | Milliseconds. |

An example with one stdio server and one HTTP server that carries a token in a header:

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data/home/notes"] },
    "github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }
  }
}
```

## Names in the MCP config

clanka expands names through Effect's `Config`, so the `ConfigProvider` that is in context when chad loads the file decides where a name resolves. That is how a name reaches the secret store without the value passing through the environment.

- **MCP-24** `${NAME}` and `${NAME:-default}` are expanded in `command`, `args`, `env`, `cwd`, `url` and `headers`.
- **MCP-25** A name resolves in chad's secret store first and then in the process environment.
- **MCP-26** A value from the secret store is never copied into `process.env`.
- **MCP-27** At load, a name that resolves nowhere and has no default marks that one server unavailable. The other servers carry on.
- **MCP-28** `mcp.json` has no escape for a literal `${`. The name `CHAD_DOLLAR` is reserved for writing one, as `${CHAD_DOLLAR:-$}{X}`, and `chad secret set` refuses that name (see 11-settings.md, where the same expander rules apply to `chad.json`).
- **MCP-30** chad passes the values of an entry's `env` to `McpServers.layer` as `Redacted` values. clanka fails a server whose `env` values are plain strings with "Unable to get redacted value".
- **MCP-31** A stdio server is started by clanka outside the spawner chad wraps. It gets the daemon's whole environment plus the entry's `env`, and so it carries `CHAD_SESSION=daemon` and not a session id (see 01-image-and-volume.md and 10-cli.md).
- **MCP-109** chad gives every stdio entry an absolute `cwd` before it hands the config to clanka. An entry with no `cwd` gets the daemon's `HOME`.
- **MCP-110** `chad check` and `chad apply` fail on a stdio entry whose `cwd` is relative. clanka would resolve it against the directory of the config file, which under `live` is deleted after the next apply, and the same file must not mean two things.

## When a config change takes effect

clanka builds the MCP layer without ever failing. A server that cannot start or connect is recorded as failed with its error, and the layer still comes up with the rest. The only failure is a config file that cannot be read or decoded.

- **MCP-32** An apply rebuilds the MCP layer only when `mcp.json` changed.
- **MCP-33** A malformed `mcp.json` fails an apply, like any other failed load.
- **MCP-34** A server that fails to connect does not block an apply.
- **MCP-35** When `mcp.json` changed, the apply prints each server's status and its tool count.
- **MCP-111** When `mcp.json` changed, `chad apply` waits for the MCP rebuild to end before it prints the lines of MCP-35. The plugins activate without waiting, as MCP-93 says.
- **MCP-112** `chad apply` prints the line that names the commit before that wait, so a CLI that is killed during the wait has already shown that the apply landed.
- **MCP-36** `chad check` reads the snapshot's `mcp.json` with clanka's `McpConfig.load`, checks that every `${NAME}` resolves, and prints which servers an apply would add, remove or change. It connects nothing, and its output says so (see 10-cli.md).
- **MCP-113** For a `${NAME}` in `mcp.json` that resolves nowhere and has no default, `chad check` prints the server and the name as a warning and still exits 0.
- **MCP-114** In the same case `chad apply` goes ahead and lists that server as unavailable.
- **MCP-37** At boot a malformed `mcp.json` starts chad with no MCP servers. The owner gets a notice, and `chad status` lists the file under "Problems" (see 16-failures-logs-status.md for both). No file on the volume can stop a boot.
- **MCP-38** Nothing reconnects or restarts a server that dropped. It stays failed until the layer is rebuilt.
- **MCP-39** `chad mcp restart` rebuilds the MCP layer. It restarts every server and cannot restart one.
- **MCP-40** With the daemon running, `chad secret set` and `chad secret rm` rebuild the MCP layer when `mcp.json` names the changed secret, and the command prints what it reloaded. A change to a secret that `mcp.json` does not name rebuilds nothing.
- **MCP-41** Every rebuild restarts every server, whatever caused it, and a stdio server loses whatever it held in memory. This is accepted.
- **MCP-42** `chad mcp restart` needs the daemon and exits 4 without it. It goes through the daemon's one queue with applies, and the agent may run it (see 10-cli.md).
- **MCP-43** The system prompt lists the MCP servers by name with each one's tool count, and for a failed server the first line of its error. A change to the MCP servers renders a session's system prompt again on its next turn (see 08-apply-and-swap.md).
- **MCP-144** Each server's line, as `chad apply`, `chad secret set` and `rm`, `chad mcp restart` and `chad safe` print it once a rebuild ends, is "MCP server <name>: connected, <n> tools." or "MCP server <name>: unavailable: <first line of its error>". A rebuild with no server prints "No MCP servers are configured.". An apply prints these lines before its closing line. `chad safe` prints them only when there were servers before it or are after it. `chad status` has one line per server: "mcp: <name>, connected, <n> tools", "mcp: <name>, failed (<first line of its error>)" or, during a rebuild, "mcp: <name>, starting". `chad check` prints "MCP server <name>: an apply adds it.", "removes it" or "changes it" for each server that differs from the applied file, and then "The check connected no MCP server.".

## Runtimes for stdio servers

- **MCP-44** The image carries uv, with uvx, and Node's `npx` as the runtimes for stdio servers. It carries no Python package (see 01-image-and-volume.md).
- **MCP-45** The uv cache and the npm cache are on the volume, under `cache/` (see 01-image-and-volume.md).

## OAuth for HTTP servers

Many hosted MCP servers answer 401 until the client has signed in with OAuth. v1 does not sign in with OAuth. clanka builds its HTTP transport with the static headers of the server's entry, so a server that wants a token gets it from a header, and a 401 at connect marks the server failed.

- **MCP-139** v1 has no OAuth for MCP servers. An HTTP server signs in with the static `headers` of its entry in `mcp.json`, and a secret in a header is written as `${NAME}` (MCP-23). chad passes no `authProvider` to clanka's `McpServers.layer`, hands every server to that layer and builds no transport itself. A server that answers 401 is a failed server like any other. It is listed as unavailable with the first line of its error, in the apply output, in `chad status` and in the system prompt. There is no `chad mcp login` and no `chad mcp logout`, no `secrets/mcp-oauth.json`, no "needs login" status, and no notice, message or pending login for one. chad never consumes a pasted callback URL.

## Tool calls while the MCP layer rebuilds

A rebuild takes seconds and can take a minute, and sessions keep running through it. These rules say what each MCP call gets meanwhile. There is one wrapper and one path for every cause. Unlike the plugin swap in 08-apply-and-swap.md, a rebuild has no gate, no drain and no held calls.

Five facts about clanka 0.27.0 shape the rules. All five were seen in the runs.

- An Agent reads the MCP section of the system prompt and the MCP declarations once, when it is built.
- clanka asks for the MCP handlers once per spawn, synchronously. That is once for a turn and once for each sub-agent. The keys it gets back are the only `mcp.*` names that the scripts of that turn or sub-agent have.
- A server that failed to connect has no handlers at all, so clanka has no error of its own for a call to it.
- An interrupted call returns at once. The SDK drops the request and sends the server a cancellation.
- Closing the layer closes the servers one after another. A stdio server gets its standard input closed, SIGTERM 2 seconds later and SIGKILL 2 seconds after that.

### The wrapper

- **MCP-65** chad hands every Agent one wrapper around clanka's `McpServers` service, in place of a layer. Every turn and every sub-agent in every session takes its handlers from the wrapper.
- **MCP-66** The wrapper routes each call by its key to the layer that is current when the call is made. A running turn's call after a rebuild is answered by the restarted server.
- **MCP-67** Every rebuild takes the same path, whatever caused it. The causes are an apply that changed `mcp.json`, `chad mcp restart`, a change to a secret that `mcp.json` names, and a boot.
- **MCP-68** When a new layer becomes current, each session whose Agent was built before it rebuilds its Agent at the start of its next turn. That turn takes its keys and its prompt section from the new layer.

### The rebuild path

- **MCP-71** A rebuild interrupts every call that is in flight when it starts, at once, and each caller gets message 1 in the table below. The turn carries on.
- **MCP-73** chad closes the old layer and only then connects the new one. No server of the old layer is running when a server of the new layer starts.
- **MCP-74** The close has no deadline in a rebuild. It takes 4 seconds for each stdio server that ignores both its standard input closing and SIGTERM, one after another.
- **MCP-75** The new layer becomes current when clanka has finished connecting it. clanka connects the servers in parallel, each under its `connectTimeout`, so one server that never answers keeps the new layer from becoming current for that timeout.
- **MCP-100** An MCP rebuild has no duration of chad's own, so chad's one `Timings` service holds none for it (see 17-testing.md).

### Calls held at the gate

- **MCP-140** From the start of a rebuild until the new layer is current, a call fails at once with message 2. Nothing was sent, so the agent can call again. No call is held, and there is no backstop.

### What a running turn gets from the new layer

A running turn keeps the keys it took. After a rebuild some of those keys name things the new layer does not have. chad words these failures itself, from the new layer's config and status.

- **MCP-81** A call to a server that is gone from `mcp.json` fails with message 3.
- **MCP-82** A call to a tool that its server no longer lists fails with message 4, whatever caused the rebuild.
- **MCP-83** A call to a server that is still in `mcp.json` and is not connected fails with message 5, which carries the first line of the server's status error.
- **MCP-85** A call to a tool that still exists with different parameters fails clanka's validation against the new schema, and the call is not sent. chad adds nothing for this case.
- **MCP-86** A server that a rebuild added is callable from each session's next turn. A running turn has no name for it, so a call to it throws inside the script and never reaches chad.
- **MCP-87** When `searchTools` runs in a turn or sub-agent that holds no key for a tool the current layer has, chad adds a line to the result that names those tools and says they are callable from the next turn (message 8).
- **MCP-88** A sub-agent that a running turn spawns after the rebuild takes its keys from the new layer, so it can call a tool the rebuild added.

### Turns that start during a rebuild

- **MCP-89** A turn or sub-agent that starts during a rebuild does not wait. It takes the keys and the prompt section of the last layer that finished connecting and is a running turn from then on. Its MCP calls fail with message 2 until the new layer is current.
- **MCP-90** A boot is a rebuild. The servers connect in the background, so the daemon takes turns before its MCP servers are connected.
- **MCP-91** At boot there is no earlier layer to fall back on. A turn that starts before the first layer has connected does not wait for it.
- **MCP-92** That turn starts without MCP. Its prompt has no MCP section and carries message 7 instead, and it holds no keys, so its scripts have no `mcp` name at all. A turn that starts once the first layer has connected has MCP.

### An apply that changes plugins and the MCP config

- **MCP-93** When one apply changes plugins and `mcp.json`, the plugins activate without waiting for the MCP layer to connect. One slow `npx -y` download therefore does not hold every plugin tool in every session (see 08-apply-and-swap.md).

### Stops and restarts

- **MCP-94** A graceful stop abandons a rebuild that is in progress (see 01-image-and-volume.md for the stop's budget). A call made after that fails with message 2 or is cut with its turn.
- **MCP-97** In a stop the plugins' scopes close before the MCP layer, so the stop's 60 second deadline cuts only MCP servers. A stop cut by the deadline exits 1, and its `stop.cut` log line names the servers that were still open. The cut stays a log line, and the owner gets no notice for it (see 16-failures-logs-status.md). The rule for the 60 second deadline and its exit code, with how the `stop.cut` line is written before the exit, is in 01-image-and-volume.md.
- **MCP-131** chad does nothing in v1 to keep a resumed turn from sending an MCP call a second time. The paragraph below states the limit.

The runs recorded three things that no rule changes. A turn that a graceful stop cut while its MCP call was in flight sends that call to the server a second time when it resumes, which matters for a call that is not safe to repeat. An MCP call in flight when the daemon restarts fails with "Connection closed". clanka never deletes the HTTP session when it closes an HTTP server, which is a known leak that chad does not work around.

### Messages returned to the model

The texts are exact. `<server>.<tool>` is the key, and `<name>` is the server's name in `mcp.json`.

- **MCP-99** The seven texts in the table below are templates in chad's one `Messages` module (see 17-testing.md).

| # | Text | When |
| --- | --- | --- |
| 1 | `mcp.<server>.<tool> was interrupted by an MCP restart. It may have run in part or in full.` | The call was in flight when a rebuild started (MCP-71). |
| 2 | `MCP servers are restarting. This call was not sent.` | The call was made during a rebuild, before the new layer was current (MCP-140). |
| 3 | `mcp.<server>.<tool>: MCP server "<name>" was removed from mcp.json.` | The server is gone from `mcp.json` (MCP-81). |
| 4 | `mcp.<server>.<tool>: "<name>" no longer lists this tool.` | The server is connected and does not list the tool (MCP-82). |
| 5 | `mcp.<server>.<tool>: MCP server "<name>" is not connected: <first line of the status error>` | The server is configured and not connected (MCP-83). |
| 6 | Withdrawn. |  |
| 7 | `MCP servers were still starting when this turn began. They are available from your next turn.` | In the prompt of a turn that started at boot without MCP (MCP-92). |
| 8 | `mcp.<server>.<tool>, … are callable from your next turn.` | Added to a `searchTools` result (MCP-87). |

- **MCP-142** Message 8 names at most 10 tools, in the order the current layer lists them, and counts the rest as ", and <n> more". A single tool takes "is" in place of "are".
- **MCP-143** A `searchTools` call when the current layer has no connected server fails with "searchTools: no MCP server is connected.", and a call made when no layer exists and none is being built fails with "MCP servers are not running.".

Message 5 has the shape clanka uses for a server that drops. An example from the run is `mcp.slowpoke.echo: MCP server "slowpoke" is not connected: connection timed out after 30000ms`. An example of MCP-85 from the run is `mcp.fs.store: Expected number`. Message 8 is appended to the result after a blank line, and for a single tool the prototype wrote "is" in place of "are".

### The wrapper and the rebuild in code

The prototype that ran these rules in their earlier wording, on clanka 0.27.0, had a gate, a drain and held calls, so its code is not shown here. What still holds from it is that chad provides the wrapper as clanka's `McpServers` service when a session builds its Agent, and that clanka reads `prompt` and `dts` from it once per build and calls `handlers` once per spawn. chad builds each layer with `McpServers.layer` in a scope of its own and closes that scope to stop the layer's servers.

The prototype keeps a counter of its own for the MCP layer, beside the plugins' generation, and a session rebuilds its Agent when it is behind either one. 08-apply-and-swap.md words the same thing as one generation that an MCP rebuild bumps. What a builder has to hold is MCP-68, and whether that is one counter or two is the builder's choice.

### What was measured

The earlier wording of these rules ran on clanka 0.27.0 with its own MCP layer and MCP SDK client 1.32.2. The rules as they stand, with no gate, no drain and no held calls, were not run, and the Provenance table still marks the edited rules as run for their earlier wording. Four measurements still hold. An interrupted call returned within 5 ms, and three of four servers finished the work after the caller had been told. A close straight after an interrupt cut off the cancellation before the HTTP server received it. The close took 4.0 seconds for each stdio server that ignores its input closing and SIGTERM, one after another. With default timeouts one server that never answers held the connect for 32.0 seconds.

## Log events

The log events that this part's behaviour writes are `skill.skipped`, `skill.bundled-changed`, `mcp.config-unreadable`, `mcp.server-failed` and `mcp.rebuilt`. A rebuild that ends writes `mcp.rebuilt` with its duration and its counts, and a server that fails to connect writes `mcp.server-failed`. The table of every event, with its rule id, its level and what its line carries, is in 16-failures-logs-status.md, and this part adds no rule of its own for them.

## Gaps

- **MCP-G10** [builder] The wording of the apply's line for a repo skill that hides a bundled one, and of the per-server status lines. TIM-537 items 3 and 6. MCP-144 settles the per-server status lines, and MCP-147 the skill's line and mark.
- **MCP-G15** [builder] Where in the image the bundled skills directory is. TIM-537 item 3. MCP-145 settles it.
- **MCP-G17** [builder] The sentence chad appends to a skill's content around the path of MCP-102 or MCP-103, which has to say what MCP-104 requires. TIM-537 item 1 and TIM-538. MCP-146 settles it.

## Provenance

The follow-up rules on TIM-537 are the seven rules agreed in TIM-549 (items 24 to 30). TIM-555 ran them, and its "Decided" items amend them.

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| MCP-1 | TIM-537 item 1, TIM-534 item 3, TIM-538 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-2 | TIM-534 item 2 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-3 | TIM-537 item 1 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-4 | TIM-537 item 1 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-5 | TIM-537 item 2, TIM-531 item 2 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-6 | TIM-537 item 4 | Tim | not run |  | `definition` | - |
| MCP-7 | TIM-534 item 6 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-8 | TIM-542 item 11 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-9 | TIM-537 item 3, TIM-549 item 1, TIM-546 item 22, amended by TIM-557 item 43 | Tim; which skills are bundled Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| MCP-10 | TIM-537 item 3, TIM-549 items 10 and 19 | Tim; the override of `self-edit` Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-11 | TIM-537 item 3 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-12 | TIM-549 item 23 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-13 | TIM-549 item 23 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-14 | TIM-549 item 23, TIM-557 items 36 and 40 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-15 | TIM-549 item 23 | Architect (Tim has not read) | not run |  | `definition` | - |
| MCP-16 | TIM-549 item 19 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-17 | TIM-549 item 19 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-18 | TIM-549 item 19, TIM-534 item 5, TIM-557 items 36 and 40 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-19 | TIM-549 item 21, amended by TIM-558 item 32 and TIM-557 item 43 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| MCP-20 | TIM-537 item 5 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-21 | TIM-537 item 5, TIM-542 item 13 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-22 | TIM-537 item 8 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-23 | TIM-534 item 14 | Tim | read |  | `definition` | - |
| MCP-24 | TIM-537 item 7 and its facts comment | Tim | read |  | `rule` | `skills-mcp` |
| MCP-25 | TIM-537 item 7 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-26 | TIM-537 item 7 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-27 | TIM-534, as recorded on TIM-537 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-28 | TIM-548 item 6 | Architect (Tim has not read) | read |  | `rule` | `skills-mcp` |
| MCP-30 | TIM-553, as recorded on TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-31 | TIM-550 item 3, TIM-553 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-32 | TIM-537 item 5 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-33 | TIM-534 item 4 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-34 | TIM-537 item 6, TIM-534 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-35 | TIM-537 item 6 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-36 | TIM-542 follow-up point 3 | Architect (Tim has not read) | read |  | `rule` | `skills-mcp` |
| MCP-37 | TIM-534 item 5, TIM-557 items 27 and 40 | Tim; the notice and the "Problems" entry Architect (Tim has not read) | read; the notice and the "Problems" entry not run |  | `rule` | `skills-mcp` |
| MCP-38 | TIM-537 item 6 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-39 | TIM-537 item 6, TIM-555 rule 1 | Tim | run |  | `rule` | `skills-mcp` |
| MCP-40 | TIM-542 item 14, TIM-555 rule 1 | Tim | run |  | `rule` | `skills-mcp` |
| MCP-41 | TIM-531 item 6, TIM-555 rule 1 | Tim | run |  | `rule` | `skills-mcp` |
| MCP-42 | TIM-542 items 4, 24 and 30, amended by TIM-559 ruling on MCP-G6, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Tim; the queue places Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-43 | TIM-531 item 2, TIM-537 round 3 facts | Tim | read |  | `rule` | `skills-mcp` |
| MCP-44 | TIM-537 item 8, TIM-541 item 2 | Tim; `npx` and no Python package Architect (Tim has not read) | run |  | `rule` | `harness` |
| MCP-45 | TIM-537 item 8, TIM-541 item 12 | Tim; the cache paths Architect (Tim has not read) | run |  | `rule` | `harness` |
| MCP-65 | TIM-531 item 6, TIM-537 follow-up rule 1, kept by TIM-555 | Architect (Tim has not read) | run | TIM-549, TIM-555 | `rule` | `skills-mcp` |
| MCP-66 | TIM-537 follow-up rule 1, kept by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-67 | TIM-537 follow-up rule 1, TIM-555 item 2, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-68 | TIM-537 follow-up rule 7, TIM-555 prototype | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-71 | TIM-537 follow-up rule 2, amended by TIM-555 item 5, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-73 | TIM-537 follow-up rule 2, kept by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-74 | TIM-555 finding 4, TIM-553 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-75 | TIM-537 follow-up rules 2 and 3, TIM-555 finding 3, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-81 | TIM-537 follow-up rule 4, amended by TIM-555 item 4 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-82 | TIM-537 follow-up rule 4, amended by TIM-555 item 4 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-83 | TIM-537 follow-up rule 4, amended by TIM-555 item 4 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-85 | TIM-537 follow-up rule 4, kept by TIM-555 | Architect (Tim has not read) | run |  | `fact` | `skills-mcp` |
| MCP-86 | TIM-537 follow-up rule 7, kept by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-87 | TIM-555 item 6 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-88 | TIM-555 item 6 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-89 | TIM-537 follow-up rule 6, amended by TIM-555 item 1, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-90 | TIM-555 item 2, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-91 | TIM-555 item 2, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-92 | TIM-555 item 2, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-93 | TIM-549 item 28 (TIM-537 follow-up rule 5), kept by TIM-555, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-94 | TIM-555 item 7, TIM-553, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-97 | TIM-553 item 8, as recorded on TIM-555, TIM-557 item 41, TIM-559 round 2 R4 and R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | run; no notice not run |  | `rule` | `skills-mcp` |
| MCP-99 | TIM-558 item 33, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-100 | TIM-558 item 17, amended by TIM-559 ruling on MCP-G20, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16, amended by Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-102 | TIM-559 ruling on MCP-G17 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-103 | TIM-559 ruling on MCP-G17 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-104 | TIM-559 ruling on MCP-G17 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-105 | TIM-559 ruling on MCP-G18 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-106 | TIM-559 ruling on MCP-G16 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-107 | TIM-559 ruling on MCP-G16 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-108 | TIM-559 ruling on MCP-G16 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-109 | TIM-559 ruling on MCP-G14 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-110 | TIM-559 ruling on MCP-G14 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-111 | TIM-559 ruling on MCP-G11 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-112 | TIM-559 ruling on MCP-G11 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-113 | TIM-559 ruling on MCP-G12 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-114 | TIM-559 ruling on MCP-G12 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-131 | TIM-559 ruling on MCP-G23 | Architect (Tim has not read) | not run |  | `definition` | - |
| MCP-132 | TIM-559 round 3 A1 | Architect (Tim has not read) | read |  | `fact` | `skills-mcp` |
| MCP-133 | TIM-559 round 3 A1 | Architect (Tim has not read) | read |  | `fact` | `skills-mcp` |
| MCP-134 | TIM-559 round 3 A1 | Architect (Tim has not read) | not run | TIM-559 | `definition` | - |
| MCP-135 | TIM-559 round 3 A1, TIM-559 round 4 items 7 and 8 | Architect (Tim has not read) | not run |  | `definition` | - |
| MCP-139 | Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Tim; the wording Jarvis (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-140 | Tim's ruling that an MCP rebuild has no gate, no drain and no held calls, chat 2026-11-16 | Tim; the wording Jarvis (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-141 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-142 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-143 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-144 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-145 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-146 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-147 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `skills-mcp` |

Retired ids. These rules were withdrawn and removed from this part with their Provenance rows, and the git history of this file holds their text. An id on this list is never used again, and a new rule takes a number above every id in the table and on this list.

MCP-29, MCP-46, MCP-47, MCP-48, MCP-49, MCP-50, MCP-51, MCP-52, MCP-53, MCP-54, MCP-55, MCP-56, MCP-57, MCP-58, MCP-59, MCP-60, MCP-61, MCP-62, MCP-63, MCP-64, MCP-69, MCP-70, MCP-72, MCP-76, MCP-77, MCP-78, MCP-79, MCP-80, MCP-84, MCP-95, MCP-96, MCP-98, MCP-101, MCP-115, MCP-116, MCP-117, MCP-118, MCP-119, MCP-120, MCP-121, MCP-122, MCP-123, MCP-124, MCP-125, MCP-126, MCP-127, MCP-128, MCP-129, MCP-130, MCP-136, MCP-137, MCP-138.
