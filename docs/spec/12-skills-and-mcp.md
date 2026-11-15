# Skills and MCP servers

This part covers the two kinds of extension that are plain files in the repo and are not plugins. A skill is a set of instructions the model reads on demand, and an MCP server is an external tool server. The part says where both live, how chad hands them to clanka, how a change reaches open sessions, what clanka's own walk of a session's working directory shows a session without an apply, how an HTTP MCP server signs in with OAuth, and what a tool call does while the MCP servers are being restarted. It leans on 09-repo-and-recovery.md for the repo, the apply and safe mode, on 07-plugin-loading.md for the exported tree and the `live` link, on 08-apply-and-swap.md for how a session rebuilds its Agent and for the plugin swap that the MCP restart is modelled on, on 10-cli.md for the commands, on 14-self-edit-skill.md for what the bundled skill tells the agent, on 15-credentials.md for the secret store, on 01-image-and-volume.md for the image's runtimes and the stop budget, on 16-failures-logs-status.md for the notices to the owner, and on 17-testing.md for the tests.

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
- **MCP-10** A repo skill with the same name as a bundled skill wins. Sessions get the repo skill in place of the bundled one. This is an override and not an error, and it applies to `self-edit` as well.
- **MCP-11** The output of an apply says when a repo skill hides a bundled one.
- **MCP-12** `chad status` marks a repo skill that hides a bundled one.
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

An example with one stdio server, one HTTP server that signs in with OAuth and one HTTP server that carries a token in a header:

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data/home/notes"] },
    "linear": { "url": "https://mcp.linear.app/mcp" },
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
- **MCP-29** A `${NAME}` in `mcp.json` that names a TOTP secret fails the apply, and `chad secret set NAME --totp` is refused while the applied `mcp.json` names `NAME` (see 15-credentials.md).
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
- **MCP-42** `chad mcp restart`, `chad mcp login` and `chad mcp logout` need the daemon and exit 4 without it. `chad mcp restart` and `chad mcp logout` go through the daemon's one queue with applies, `chad mcp login` takes a place in it only as MCP-123 says, and the agent may run all three (see 10-cli.md).
- **MCP-43** The system prompt lists the MCP servers by name with each one's tool count, and for a failed server the first line of its error. A change to the MCP servers renders a session's system prompt again on its next turn (see 08-apply-and-swap.md).

## Runtimes for stdio servers

- **MCP-44** The image carries uv, with uvx, and Node's `npx` as the runtimes for stdio servers. It carries no Python package (see 01-image-and-volume.md).
- **MCP-45** The uv cache and the npm cache are on the volume, under `cache/` (see 01-image-and-volume.md).

## OAuth for HTTP servers

Many hosted MCP servers answer 401 until the client has signed in with OAuth. The MCP SDK that clanka uses, version 1.32.2, does the authorization code flow with PKCE, dynamic client registration and token refresh through an object it calls an `OAuthClientProvider`. It has no device flow. Without a provider clanka builds its HTTP transport with static headers, so a 401 at connect marks the server failed.

- **MCP-46** OAuth for HTTP MCP servers is in v1.
- **MCP-47** The transport gets its provider through the optional second argument of clanka's `McpServers.layer(config, authProvider?)`. `authProvider` is a function `(name, config) => OAuthClientProvider | undefined`, and clanka hands the provider it returns to the SDK transport.
- **MCP-115** chad's function returns `undefined` for an HTTP server whose entry has an `Authorization` header, which leaves that server without a provider.
- **MCP-48** The argument gives clanka no new status and no way to reconnect one server, and clanka's own CLI does not use it. Tokens, the login flow and the "needs login" status all live in chad.
- **MCP-49** This argument is the only change to clanka that chad v1 depends on. clanka 0.28.0, the version chad pins (see 00-overview.md), carries it, so chad hands every server to clanka's own `McpServers.layer` and builds no transport itself.
- **MCP-50** `mcp.json` carries no OAuth marker. Every HTTP server whose entry has no `Authorization` header gets the provider. There is no `oauth.clientId` key in v1.
- **MCP-51** v1 covers servers that offer dynamic client registration. A server without it, such as GitHub's remote server, goes in with a personal access token in a header.
- **MCP-52** Tokens and the client registration are kept on the volume, outside the repo, keyed by server name and URL. They are in a file of their own next to the secret store, `secrets/mcp-oauth.json` with mode 0600 (see 02-storage.md).
- **MCP-116** `secrets/mcp-oauth.json` has a top-level `version` field and one entry for each server. The key of an entry is the server's name in `mcp.json`. The entry stores the URL it was issued for and everything the SDK's provider saves, the client registration included, each object unchanged.
- **MCP-136** chad uses an entry only when the URL it stores equals the server's resolved URL, which is the `url` of the server's entry in the applied `mcp.json` after `${NAME}` expansion. An entry stored for another URL does not count, which is how the tokens are keyed by server name and URL (MCP-52) and why a server whose URL changed needs a new login (MCP-53).
- **MCP-137** When a login finishes for a server whose stored entry was issued for another URL, the save replaces the whole entry. The new entry holds the URL the login was for, its tokens and the client registration made for that URL, and it keeps nothing of the old entry, the old client registration included. The old URL's tokens are gone, so a server that is set back to the old URL afterwards needs a new login.
- **MCP-138** A login for a new URL that does not finish, because it fails or expires, leaves the stored entry as it was, with the old URL, its tokens and its client registration. The client that such a login registered for the new URL is not in the entry afterwards. A server that is set back to the old URL before a login for the new URL has finished therefore has its old entry in use again (MCP-136) and needs no login.
- **MCP-117** `chad secret list` does not show what `secrets/mcp-oauth.json` holds, and no `${NAME}` resolves to it.
- **MCP-53** An apply or a revert never touches the stored tokens. A server whose URL changed needs a new login.
- **MCP-101** Withdrawn.

The signature, read from clanka 0.28.0. clanka calls `authProvider` once for each HTTP server, when the layer is built:

```ts
// clanka 0.28.0, src/McpServers.ts
export type AuthProviderFor = (
  name: string,
  config: HttpServerConfig,
) => OAuthClientProvider | undefined

export const layer = (
  config: Readonly<Record<string, ServerEntry>>,
  authProvider?: AuthProviderFor | undefined,
): Layer.Layer<McpServers>
```

### The "needs login" status

- **MCP-54** An HTTP server that answers 401 while chad holds no token for it has the status "needs login". The status is shown in the apply output and in the server list of the system prompt.
- **MCP-55** chad keeps the "needs login" status itself. clanka only knows the server as failed.
- **MCP-56** When a token refresh fails, the server drops to "needs login", the model's call gets an error that says so (the wording is in "Messages returned to the model" below), and the owner gets one notice. It is the notice whose key starts `mcp-needs-login:`, and the notice rule, the key and the wording are in 16-failures-logs-status.md.
- **MCP-57** chad never posts a login link on its own. A login starts only with `chad mcp login`.

The following was read from the SDK and clanka and not run. It shows that chad's provider can produce the status without clanka knowing it. With a provider and no stored token, a 401 at connect makes the SDK discover the authorization server, register a client if none is stored, save the PKCE verifier and call the provider's `redirectToAuthorization`. An error thrown there is not caught by the SDK, so it becomes the connect failure, and clanka puts the first line of a connect failure in the system prompt's server list. When a refresh fails during a tool call the SDK calls `redirectToAuthorization` again, and the call fails with whatever the provider throws. clanka marks a server dropped only on a close or a 404.

### Logging in

A hosted server redirects the browser to a URL the client registered. chad runs in a container the owner's browser cannot reach, so the redirect goes to a loopback address where nothing listens, the browser shows an error page, and the owner hands chad the address the browser ended on.

- **MCP-58** `chad mcp login <name>` starts the login for a server, and the daemon posts the login link in the thread that asked. The thread is found through `CHAD_SESSION`.
- **MCP-118** `chad mcp login <name>` reads the applied `mcp.json`. It refuses a name that is not in it, a stdio server and an HTTP server whose entry has an `Authorization` header, each with a message that says why (see 10-cli.md for the exit code).
- **MCP-119** For a server that already holds a token, `chad mcp login` starts a new login, which is how the owner changes account. The old token is kept until the new login finishes.
- **MCP-120** With `CHAD_SESSION=daemon` the command is refused with a message, without testing for a terminal, because such a process has no thread to show the link in (see 10-cli.md for the exit code).
- **MCP-121** With `CHAD_SESSION` unset the command takes the terminal path of MCP-62 when it has a terminal and is refused when it has none (see 10-cli.md for the exit code).
- **MCP-122** `chad mcp login` holds no place in the daemon's queue while it starts the login, posts the link or waits for the paste. Nothing holds a queue place while chad waits on a person or on a remote server, so an apply never waits behind a link nobody has opened.
- **MCP-123** The rebuild after a finished login is the only step of `chad mcp login` that takes a place in the queue.
- **MCP-59** The redirect goes to `http://127.0.0.1:58213/callback`, one fixed port where nothing listens. The browser opens the address on the owner's own machine, so the port is one that desktop software rarely listens on, and the address is part of each stored client registration, so changing it means registering again with every server.
- **MCP-60** The owner copies the URL from the browser's address bar and pastes it into a thread. chad finds the pending login by the URL's `state` value and accepts a matching paste in any thread, because the state identifies the login.
- **MCP-124** chad consumes every owner message that is only a URL at the callback address of MCP-59, whether or not its `state` matches a pending login. The URL carries an authorization code, so such a message never starts a turn, never reaches the model and is never stored in the history.
- **MCP-125** chad answers a pasted URL whose `state` matches no pending login, an expired login's included, with one line that says no login is waiting.
- **MCP-61** A pending login expires after 10 minutes. The deadline is the daemon's.
- **MCP-62** Run by the agent, `chad mcp login` returns as soon as the link is posted, so the turn does not wait for the paste. Run from a terminal, the CLI waits and prompts for the same pasted URL.
- **MCP-63** A finished login rebuilds the MCP layer, which restarts every server. It does so only when the server is still in the applied `mcp.json` at the same URL.
- **MCP-64** `chad mcp logout <name>` deletes the server's stored tokens.
- **MCP-126** `chad mcp logout <name>` keeps the client registration for the next login and does not rebuild the MCP layer.
- **MCP-127** After a logout chad marks the server "needs login" at once, and the next call to that server gets message 6.
- **MCP-128** `chad mcp logout <name>` works for a name that is no longer in `mcp.json`.
- **MCP-129** When the server rejects a login because it does not know the stored client, chad registers a new client and carries on with it. A dead registration would otherwise have no way out.
- **MCP-98** When a pending login expires, chad posts one subtext line in the thread that asked. An expired login is an event and not a condition, so the line has no notice key and is posted every time it happens. The wording is in 16-failures-logs-status.md.

Finishing a login needs nothing from clanka. The SDK's `auth(provider, { serverUrl, authorizationCode })` exchanges the code from the pasted URL with no transport open.

## Tool calls while the MCP layer rebuilds

A rebuild takes seconds and can take a minute, and sessions keep running through it. These rules say what each MCP call gets meanwhile. They follow the plugin swap in 08-apply-and-swap.md, with one wrapper, a gate, a drain and one path for every cause, and they differ where clanka's MCP layer differs from a plugin.

Five facts about clanka 0.27.0 shape the rules. All five were seen in the runs.

- An Agent reads the MCP section of the system prompt and the MCP declarations once, when it is built.
- clanka asks for the MCP handlers once per spawn, synchronously. That is once for a turn and once for each sub-agent. The keys it gets back are the only `mcp.*` names that the scripts of that turn or sub-agent have.
- A server that failed to connect has no handlers at all, so clanka has no error of its own for a call to it.
- An interrupted call returns at once. The SDK drops the request and sends the server a cancellation.
- Closing the layer closes the servers one after another. A stdio server gets its standard input closed, SIGTERM 2 seconds later and SIGKILL 2 seconds after that.

### The wrapper

- **MCP-65** chad hands every Agent one wrapper around clanka's `McpServers` service, in place of a layer. Every turn and every sub-agent in every session takes its handlers from the wrapper.
- **MCP-66** The wrapper routes each call by its key to the layer that is current when the call is made. A running turn's call after a rebuild is answered by the restarted server.
- **MCP-67** Every rebuild takes the same path, whatever caused it. The causes are an apply that changed `mcp.json`, `chad mcp restart`, a finished `chad mcp login`, a change to a secret that `mcp.json` names, and a boot.
- **MCP-68** When a new layer becomes current, each session whose Agent was built before it rebuilds its Agent at the start of its next turn. That turn takes its keys and its prompt section from the new layer.

### The rebuild path

- **MCP-69** A rebuild starts by closing a gate, in one synchronous step. From then on a call that arrives is held and not sent.
- **MCP-70** Calls that were in flight when the gate closed get a 30 second drain. The old layer stays current during the drain, and a call that finishes within it finishes on the old layer.
- **MCP-71** At 30 seconds chad interrupts every call still in flight, and each caller gets message 1 in the table below. The turn carries on, and its next call is held like any other.
- **MCP-130** The rebuild waits at most 1 second for each interrupted call to stop, and then carries on. Without the bound one call whose fiber does not stop would hold the gate closed for every session.
- **MCP-72** chad then waits 250 ms before it closes the old layer. The pause lets an HTTP server hear the cancellation, which the close would otherwise cut off before it is sent.
- **MCP-73** chad closes the old layer and only then connects the new one. No server of the old layer is running when a server of the new layer starts.
- **MCP-74** The close has no deadline in a rebuild. It takes 4 seconds for each stdio server that ignores both its standard input closing and SIGTERM, one after another.
- **MCP-75** The new layer becomes current when clanka has finished connecting it, and the gate opens at that moment. clanka connects the servers in parallel, each under its `connectTimeout`, so one server that never answers holds the gate for that timeout.
- **MCP-76** An interrupted MCP call is reported with message 1 only. The plugin swap's message for a call that "did not stop when an apply interrupted it and may still be running" has no MCP counterpart, because the interrupt drops the request on chad's side whatever the server does afterwards.
- **MCP-100** The 30 second drain, the 1 second wait of MCP-130, the 250 ms pause, the 120 second backstop and the 10 minute life of a pending login are defaults of chad's one `Timings` service, and the shipped binary has no setting that changes them (see 17-testing.md).

### Calls held at the gate

- **MCP-77** A call held at the gate waits until the rebuild ends. It is then routed against the new layer and answered by it.
- **MCP-78** The wait has a backstop of 120 seconds. At the backstop the call fails with message 2, and the rebuild carries on. Nothing was sent, so the agent can call again.
- **MCP-79** The same call made again while the gate is still closed is held again, with a new backstop.
- **MCP-80** When the rebuild ends and the new layer cannot answer a held call, the call gets the message that MCP-81 to MCP-85 give for its case. A call whose server is configured and did not connect gets message 5.

### What a running turn gets from the new layer

A running turn keeps the keys it took. After a rebuild some of those keys name things the new layer does not have. chad words these failures itself, from the new layer's config and status.

- **MCP-81** A call to a server that is gone from `mcp.json` fails with message 3.
- **MCP-82** A call to a tool that its server no longer lists fails with message 4, whatever caused the rebuild.
- **MCP-83** A call to a server that is still in `mcp.json` and is not connected fails with message 5, which carries the first line of the server's status error.
- **MCP-84** A call to a server that needs login fails with message 6.
- **MCP-85** A call to a tool that still exists with different parameters fails clanka's validation against the new schema, and the call is not sent. chad adds nothing for this case.
- **MCP-86** A server that a rebuild added is callable from each session's next turn. A running turn has no name for it, so a call to it throws inside the script and never reaches chad.
- **MCP-87** When `searchTools` runs in a turn or sub-agent that holds no key for a tool the current layer has, chad adds a line to the result that names those tools and says they are callable from the next turn (message 8).
- **MCP-88** A sub-agent that a running turn spawns after the rebuild takes its keys from the new layer, so it can call a tool the rebuild added.

### Turns that start during a rebuild

- **MCP-89** A turn or sub-agent that starts during a rebuild does not wait. It takes the keys and the prompt section of the last layer that finished connecting and is a running turn from then on. Its MCP calls are held at the gate and answered by the new layer.
- **MCP-90** A boot is a rebuild. The gate is closed from the start and the servers connect in the background, so the daemon takes turns before its MCP servers are connected.
- **MCP-91** At boot there is no earlier layer to fall back on. A turn that starts before the first layer has connected waits for it, with the same 120 second backstop.
- **MCP-92** When that backstop passes, the turn starts without MCP. Its prompt has no MCP section and carries message 7 instead, and it holds no keys, so its scripts have no `mcp` name at all. Its next turn has MCP.

### An apply that changes plugins and the MCP config

- **MCP-93** When one apply changes plugins and `mcp.json`, the plugin gate and the MCP gate close together, and the plugins activate without waiting for the MCP layer to connect. One slow `npx -y` download therefore does not hold every plugin tool in every session (see 08-apply-and-swap.md).

### Stops and restarts

- **MCP-94** A graceful stop abandons a rebuild that is in progress (see 01-image-and-volume.md for the stop's budget).
- **MCP-95** When the stop lands during the drain, the old layer is still current. A held call is routed again, to the old layer, and answered.
- **MCP-96** When the stop lands after the old layer closed, no layer is current. A held call is neither answered nor failed. It waits for the stop to cut its turn, and the turn resumes on the next boot against the `mcp.json` that was applied.
- **MCP-97** In a stop the plugins' scopes close before the MCP layer, so the stop's 60 second deadline cuts only MCP servers. A stop cut by the deadline exits 1, and its `stop.cut` log line names the servers that were still open. The cut stays a log line, and the owner gets no notice for it (see 16-failures-logs-status.md). The rule for the 60 second deadline and its exit code, with how the `stop.cut` line is written before the exit, is in 01-image-and-volume.md.
- **MCP-131** chad does nothing in v1 to keep a resumed turn from sending an MCP call a second time. The paragraph below states the limit.

The runs recorded three things that no rule changes. A turn that a graceful stop cut while its MCP call was in flight sends that call to the server a second time when it resumes, which matters for a call that is not safe to repeat. An MCP call in flight when the daemon restarts fails with "Connection closed". clanka never deletes the HTTP session when it closes an HTTP server, which is a known leak that chad does not work around.

### Messages returned to the model

The texts are exact. `<server>.<tool>` is the key, and `<name>` is the server's name in `mcp.json`.

- **MCP-99** The eight texts in the table below are templates in chad's one `Messages` module (see 17-testing.md). The constants in the code further down stand for those templates.

| # | Text | When |
| --- | --- | --- |
| 1 | `mcp.<server>.<tool> was interrupted by an MCP restart. It may have run in part or in full.` | The call was still in flight at the end of the drain (MCP-71). |
| 2 | `MCP servers are restarting. This call was not sent.` | The call was held for 120 seconds (MCP-78). |
| 3 | `mcp.<server>.<tool>: MCP server "<name>" was removed from mcp.json.` | The server is gone from `mcp.json` (MCP-81). |
| 4 | `mcp.<server>.<tool>: "<name>" no longer lists this tool.` | The server is connected and does not list the tool (MCP-82). |
| 5 | `mcp.<server>.<tool>: MCP server "<name>" is not connected: <first line of the status error>` | The server is configured and not connected (MCP-83). |
| 6 | `MCP server "<name>" needs login.` | The server needs login (MCP-56, MCP-84). |
| 7 | `MCP servers were still starting when this turn began. They are available from your next turn.` | In the prompt of a turn that started at boot without MCP (MCP-92). |
| 8 | `mcp.<server>.<tool>, … are callable from your next turn.` | Added to a `searchTools` result (MCP-87). |

Message 5 has the shape clanka uses for a server that drops. An example from the run is `mcp.slowpoke.echo: MCP server "slowpoke" is not connected: connection timed out after 30000ms`. An example of MCP-85 from the run is `mcp.fs.store: Expected number`. Message 8 is appended to the result after a blank line, and for a single tool the prototype wrote "is" in place of "are".

### The wrapper and the rebuild in code

This is `chad/mcp.ts` from the prototype that ran these rules on clanka 0.27.0. Its log calls, its stand-in for the secret store and the switch that ran the rules in their first wording are left out.

State and messages:

```ts
import { McpServers } from "clanka"

type Service = (typeof McpServers.McpServers)["Service"]
type Handlers = Record<string, (params: unknown) => Effect.Effect<unknown, string>>

/** Calls in flight into the old layer get this long. */
export const DRAIN_MS = 30_000 // adjusted: TIM-555, the prototype's test override is removed
/** The backstop for a call held at the gate, and for a turn at boot that waits for the first layer. */
export const HELD_MS = 120_000 // adjusted: TIM-555 item 3
/** The pause between interrupting calls and closing the old layer. */
const PAUSE_MS = 250 // adjusted: TIM-555 item 5
/** How long the rebuild waits for an interrupted call to stop (MCP-130). */
const STOP_MS = 1_000 // adjusted: TIM-555, the prototype's test override is removed

interface Flight {
  readonly key: string
  readonly session: string
  readonly startedAt: number
  readonly done: Deferred.Deferred<void>
  fiber: Fiber.Fiber<any, any> | undefined
  cut: boolean
  readonly cutNow: Deferred.Deferred<void>
}
interface Built {
  readonly n: number
  readonly why: string
  readonly service: Service
  readonly scope: Scope.Closeable
  /** mcp.json as written. */
  readonly raw: string
  /** identifier -> configured name, for every server in mcp.json whether or not it connected. */
  readonly names: Map<string, string>
  readonly keys: ReadonlyArray<string>
  readonly inflight: Set<Flight>
  readonly handlers: WeakMap<object, Handlers>
  state: "open" | "closed"
}

let current: Built | undefined
/** What the last layer that was current offered. A turn or sub-agent that spawns while nothing is current gets these. */
let previous: { readonly keys: ReadonlyArray<string>; readonly prompt: string; readonly dts: string } = { keys: [], prompt: "", dts: "" }
let rebuilding: { readonly gate: Deferred.Deferred<void>; readonly label: string; readonly startedAt: number } | undefined
/** A graceful stop abandoned a rebuild after the old layer closed. */
let between = false
let builds = 0
/** Bumped when a new layer becomes current. A session rebuilds its Agent at its next turn when it is behind. */
export let generation = 0
/** A layer has been current in this process. False from boot until the first one connects. */
let hadLayer = false
/** identifier -> configured name, for every server any layer has had. */
const everNames = new Map<string, string>()
/** Sessions whose running turn started at boot with no layer at all. Their prompt says so. */
const withoutMcp = new Set<string>()
export const startedWithout = (session: string) => withoutMcp.has(session) // adjusted: TIM-555 item 2
/** chad's own record of the servers that need login. Not in the prototype, which had no OAuth server. */
declare const needsLogin: (name: string) => boolean // adjusted: TIM-537 item 13
/** chad's function that gives an HTTP server its OAuth provider, or none (MCP-47, MCP-115). Not in the prototype. */
declare const authProvider: McpServers.AuthProviderFor // adjusted: TIM-559 ruling on MCP-G1

const CUT = (key: string) => "mcp." + key + " was interrupted by an MCP restart. It may have run in part or in full." // adjusted: TIM-555 item 5
export const NOT_SENT = "MCP servers are restarting. This call was not sent."
export const STILL_STARTING = "MCP servers were still starting when this turn began. They are available from your next turn."
const REMOVED = (key: string) =>
  "mcp." + key + ": MCP server \"" + (everNames.get(key.slice(0, key.indexOf("."))) ?? key.slice(0, key.indexOf("."))) + "\" was removed from mcp.json." // adjusted: TIM-555 item 4
const NEEDS_LOGIN = (name: string) => "MCP server \"" + name + "\" needs login." // adjusted: TIM-555 item 4
const firstLine = (text: string) => text.split("\n")[0]

/** Why the current layer has no handler for this key. */
const missing = (layer: Built, key: string): Effect.Effect<never, string> =>
  Effect.gen(function*() {
    if (key === "searchTools") return yield* Effect.fail("searchTools: no MCP server is connected.")
    const dot = key.indexOf(".")
    const name = layer.names.get(key.slice(0, dot))
    // Gone from mcp.json.
    if (name === undefined) return yield* Effect.fail(REMOVED(key))
    const status = (yield* layer.service.status)[name]
    // Still in mcp.json. clanka makes no handler for a server that did not connect, so there is no
    // error of clanka's to keep: chad words this one itself, from the status.
    if (status !== undefined && status._tag === "Failed") {
      if (needsLogin(name)) return yield* Effect.fail(NEEDS_LOGIN(name)) // adjusted: TIM-555 item 4
      return yield* Effect.fail("mcp." + key + ": MCP server \"" + name + "\" is not connected: " + firstLine(status.error))
    }
    // Connected, and it no longer lists the tool.
    return yield* Effect.fail("mcp." + key + ": \"" + name + "\" no longer lists this tool.") // adjusted: TIM-555 item 4
  })
```

The wrapper that every Agent is handed:

```ts
/** Runs one call in a fiber of its own and records it as in flight on its layer. */
const fly = <A, E>(layer: Built, key: string, session: string, effect: Effect.Effect<A, E>) => {
  const flight: Flight = { key, session, startedAt: Date.now(), done: Deferred.makeUnsafe<void>(), fiber: undefined, cut: false, cutNow: Deferred.makeUnsafe<void>() } // adjusted: TIM-555 item 8
  layer.inflight.add(flight)
  const fiber = Effect.runFork(effect)
  flight.fiber = fiber
  fiber.addObserver(() => {
    layer.inflight.delete(flight)
    Deferred.doneUnsafe(flight.done, Exit.void)
  })
  return Effect.raceFirst(
    Fiber.await(fiber) as Effect.Effect<Exit.Exit<A, E>>,
    Effect.as(Deferred.await(flight.cutNow), Exit.interrupt() as Exit.Exit<A, E>)
  ).pipe(
    Effect.onInterrupt(() => Fiber.interrupt(fiber)),
    Effect.map((exit) => ({ exit, flight }))
  )
}

const handlersOf = (layer: Built, onImage: object): Handlers => {
  let h = layer.handlers.get(onImage)
  if (h === undefined) layer.handlers.set(onImage, h = layer.service.handlers(onImage as any) as Handlers)
  return h
}

/** What searchTools shows and this turn or sub-agent holds no key for. */
const hint = (layer: Built, own: ReadonlySet<string>, value: unknown) => {
  if (typeof value !== "string") return value // adjusted: TIM-555 item 6
  const extra = layer.keys.filter((k) => k !== "searchTools" && !own.has(k)).map((k) => "mcp." + k)
  if (extra.length === 0) return value
  return value + "\n\n" + extra.join(", ") + (extra.length === 1 ? " is" : " are") + " callable from your next turn."
}

const handler = (session: string, key: string, onImage: object, own: ReadonlySet<string>) => (params: unknown): Effect.Effect<unknown, string> =>
  Effect.suspend(() => {
    const arrived = Date.now()
    const attempt = (): Effect.Effect<unknown, string> => {
      if (rebuilding !== undefined) {
        // Held at the gate. The backstop counts from when the call arrived.
        return Deferred.await(rebuilding.gate).pipe(
          Effect.timeoutOption(Math.max(0, HELD_MS - (Date.now() - arrived))),
          Effect.flatMap((opened) => Option.isNone(opened) ? Effect.fail(NOT_SENT) : Effect.suspend(attempt))
        )
      }
      const layer = current
      if (layer === undefined) {
        // A graceful stop abandoned the rebuild after the old layer closed. As for plugins: the call
        // is not answered, and the stop cuts its turn, which resumes after the restart.
        if (between) return Effect.never
        return Effect.fail("MCP servers are not running.")
      }
      const call = handlersOf(layer, onImage)[key]
      if (call === undefined) return missing(layer, key)
      return fly(layer, key, session, call(params)).pipe(
        Effect.flatMap(({ exit, flight }): Effect.Effect<unknown, string> => {
          if (Exit.isSuccess(exit)) return Effect.succeed(key === "searchTools" ? hint(layer, own, exit.value) : exit.value)
          if (flight.cut) return Effect.fail(CUT(key))
          const failure = Cause.squash(exit.cause)
          return Effect.fail(typeof failure === "string" ? failure : failure instanceof Error ? failure.message : JSON.stringify(failure))
        })
      )
    }
    return attempt()
  })

/**
 * What chad provides as clanka's McpServers when it builds a session's Agent. clanka reads
 * `prompt` and `dts` once per build, and calls `handlers` once per spawn.
 */
export const serviceFor = (session: string): Service =>
  McpServers.McpServers.of({
    status: Effect.suspend(() => current === undefined ? Effect.succeed({}) : current.service.status),
    get prompt() {
      return current !== undefined ? current.service.prompt : previous.prompt // adjusted: TIM-555 item 1
    },
    get dts() {
      return current !== undefined ? current.service.dts : previous.dts // adjusted: TIM-555 item 1
    },
    handlers: (onImage) => {
      // During the drain the old layer is still current. Between its close and the new layer there is none.
      const keys = current !== undefined ? current.keys : previous.keys // adjusted: TIM-555 item 1
      const own = new Set(keys)
      return Object.fromEntries(keys.map((key) => [key, handler(session, key, onImage, own)]))
    }
  } as Service)

/** A stamp of what an Agent was built against. It differs once a layer becomes current after the build. */
export const builtToken = () => generation + (current === undefined ? "-none" : "")

/** Called at the start of every turn, before the session builds its Agent and the turn takes its keys. */
export const awaitTurnStart = (session: string) =>
  Effect.suspend(() => {
    withoutMcp.delete(session)
    if (rebuilding === undefined) return Effect.void
    // With a layer to fall back on the turn does not wait. It starts on that layer's keys
    // and prompt and is a running turn from then on.
    if (hadLayer) return Effect.void // adjusted: TIM-555 item 1
    // At boot there is nothing to fall back on, so it waits like a held call.
    return Deferred.await(rebuilding.gate).pipe(
      Effect.timeoutOption(HELD_MS), // adjusted: TIM-555 item 2
      Effect.map((opened) => {
        if (Option.isNone(opened)) withoutMcp.add(session) // adjusted: TIM-555 item 2
      })
    )
  })
export const turnEnded = (session: string) => {
  withoutMcp.delete(session)
}
```

The one rebuild path and its callers. `resolve` turns the text of `mcp.json` into clanka's server entries, `Plugins.queued` is the daemon's one queue, and `Plugins.companion.atCommit` is the step of an apply that closes the plugin gates (see 08-apply-and-swap.md).

```ts
const connect = (why: string, raw: string) =>
  Effect.gen(function*() {
    const { entries } = resolve(raw)
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(McpServers.layer(entries, authProvider), scope).pipe( // adjusted: TIM-559 ruling on MCP-G1
      Effect.onInterrupt(() => Scope.close(scope, Exit.void))
    )
    const service = Context.get(context, McpServers.McpServers)
    const names = new Map<string, string>()
    for (const name of Object.keys(entries)) {
      const id = McpServers.identifier(name)
      if (!names.has(id)) names.set(id, name)
      everNames.set(id, name)
    }
    const layer: Built = {
      n: ++builds, why, service, scope, raw, names, keys: Object.keys(service.handlers(() => Effect.void)), inflight: new Set(), handlers: new WeakMap(), state: "open"
    }
    return layer
  })

const install = (layer: Built) => {
  current = layer
  previous = { keys: layer.keys, prompt: layer.service.prompt, dts: layer.service.dts }
  between = false
  hadLayer = true
  generation++
}

/** The gate closes here, in one synchronous step, so an apply can close it together with the plugin gates. */
const closeGate = (label: string) => {
  const gate = Deferred.makeUnsafe<void>()
  rebuilding = { gate, label, startedAt: Date.now() }
  return gate
}

const rebuild = (label: string, raw: string, gate: Deferred.Deferred<void>) =>
  Effect.gen(function*() {
    const old = current
    if (old !== undefined) {
      // 1. One drain, one deadline.
      const flights = [...old.inflight]
      yield* Effect.forEach(flights, (f) => Deferred.await(f.done), { concurrency: "unbounded", discard: true }).pipe(Effect.timeoutOption(DRAIN_MS))
      const late = [...old.inflight]
      for (const f of late) f.cut = true
      yield* Effect.forEach(late, (f) =>
        f.fiber === undefined ? Effect.void : Fiber.interrupt(f.fiber).pipe(
          Effect.timeoutOption(STOP_MS),
          Effect.map(() => Deferred.doneUnsafe(f.cutNow, Exit.void)) // adjusted: TIM-555 item 8
        ), { concurrency: "unbounded", discard: true })
      if (late.length > 0) yield* Effect.sleep(PAUSE_MS) // adjusted: TIM-555 item 5
      // 2. The old layer closes. It has no deadline.
      old.state = "closed"
      yield* Scope.close(old.scope, Exit.void)
      current = undefined
    }
    // 3. The new layer connects.
    const next = yield* connect(label, raw)
    install(next)
    rebuilding = undefined
    Deferred.doneUnsafe(gate, Exit.void)
  }).pipe(
    // A graceful stop abandons the rebuild wherever it is.
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        if (rebuilding === undefined) return
        if (current !== undefined && current.state === "closed") current = undefined
        if (current === undefined) between = true
        rebuilding = undefined
        Deferred.doneUnsafe(gate, Exit.void)
      })
    )
  )

/** chad mcp restart, a finished chad mcp login, a changed secret: the config is what live holds. */
export const restart = (label: string) =>
  Plugins.queued(Effect.suspend(() => {
    const raw = readRaw(liveDir() ?? Plugins.WORK)
    return rebuild(label, raw, closeGate(label))
  }))

/**
 * Called by an apply at its commit, before the plugin gates close. When mcp.json changed, the MCP
 * gate closes in the same synchronous step and the rebuild runs next to the plugin swap.
 */
Plugins.companion.atCommit = (dir: string) =>
  Effect.suspend(() => {
    const raw = readRaw(dir)
    if (current !== undefined && current.raw === raw) return Effect.succeed(undefined)
    if (current === undefined && raw === "{}" && !between) return Effect.succeed(undefined)
    const gate = closeGate("apply")
    return Effect.sync(() => Effect.runFork(rebuild("apply", raw, gate)))
  })

/**
 * A boot closes the gate at once and connects in the background, so the daemon is up before its
 * MCP servers are. A turn that arrives meanwhile is a turn that starts during a rebuild.
 */
export const boot = Effect.sync(() => {
  const dir = liveDir()
  if (dir === undefined) return
  const raw = readRaw(dir)
  if (raw === "{}") return
  const gate = closeGate("boot")
  Effect.runFork(Plugins.queued(rebuild("boot", raw, gate)))
})

/** The graceful stop closes the layer after the plugins' scopes. */
export const closeAll = Effect.suspend(() => {
  const layer = current
  if (layer === undefined || layer.state === "closed") return Effect.void
  layer.state = "closed"
  return Scope.close(layer.scope, Exit.void)
})
```

The session's side, added to the rebuild in 08-apply-and-swap.md:

```ts
// When the session builds its Agent:
Effect.provideService(McpServers.McpServers, Mcp.serviceFor(row.id)),

// At the start of a turn:
yield* Mcp.awaitTurnStart(row.id)
if (agent === undefined || generation !== Plugins.generation || mcpBuilt !== Mcp.builtToken()) yield* rebuild
// A turn that started at boot without MCP carries message 7 in its prompt.
const starting = Mcp.startedWithout(row.id)

// When the turn ends:
Mcp.turnEnded(row.id)
```

The prototype keeps a counter of its own for the MCP layer, beside the plugins' generation, and a session rebuilds its Agent when it is behind either one. 08-apply-and-swap.md words the same thing as one generation that an MCP rebuild bumps. What a builder has to hold is MCP-68, and whether that is one counter or two is the builder's choice.

### What was measured

The rebuild rules ran on clanka 0.27.0 with its own MCP layer, MCP SDK client 1.32.2, a scripted model, stdio servers that exit when asked, stdio servers that ignore their input closing and SIGTERM, and one streamable HTTP server. 169 checks passed over 22 scenario runs.

- One turn on one Agent made four calls and four server processes answered them, before and after `chad mcp restart`, a change to a named secret and an apply that added a server.
- A drain ended at 30.0 seconds. The interrupted call returned in 1 ms, and all 8 interrupted calls across the runs returned within 5 ms. Three of four servers finished the work after the caller had been told.
- With default timeouts and one server that never answers, a rebuild took 62.1 seconds, which is 30.0 for the drain, 0.07 for the close and 32.0 for the connect. The last 2 seconds are the SDK killing the server that timed out. That is why the backstop is 120 seconds.
- The close took 11 ms for a server that exits when its input closes, 4.0 seconds for one stubborn stdio server, 8.0 for two and 12.0 for three.
- Without the 250 ms pause the HTTP server never received the cancellation. With it the cancellation arrived.
- The plugin gate and the MCP gate closed 1 ms apart. The plugin activated 2 ms after the gate and answered a running turn 5.3 seconds before the MCP server connected.
- A turn that started during a 62 second rebuild started in 3 ms, and a turn that used only a plugin tool ended in 0.1 seconds.
- Abandoning a rebuild during its connect took a graceful stop 2.0 seconds, the time to kill the half-started server.
- In the image, a stop with a running turn and three stubborn servers exited 0 at 27.1 seconds. With twelve it was cut at 60.0 seconds with exit 1.

These were not run: a finished `chad mcp login` as a cause of a rebuild, message 6, a real model, the 120 second backstop at its real length (it ran at 3 seconds, for a held call and at boot), a real `npx -y` server, a secret in an HTTP header, and the `searchTools` line for a long list of tools. The Provenance table marks the rules they touch as run, because the path they share ran.

## Log events

The log events that this part's behaviour writes are `skill.skipped`, `skill.bundled-changed`, `mcp.config-unreadable`, `mcp.server-failed`, `mcp.rebuilt`, `mcp.needs-login` and `mcp.login-expired`. A rebuild that ends writes `mcp.rebuilt` with its duration and its counts, and a server that fails to connect writes `mcp.server-failed`. The table of every event, with its rule id, its level and what its line carries, is in 16-failures-logs-status.md, and this part adds no rule of its own for them.

## Gaps

- **MCP-G3** [builder] The wording of the login link message, of the terminal prompt for the paste, of what the thread or the terminal shows when a login finishes or fails, of what the terminal shows when a login expires, of the line of MCP-125 that says no login is waiting, and of the refusals of MCP-118, MCP-120 and MCP-121. TIM-537 items 10 and 11.
- **MCP-G10** [builder] The wording of the apply's line for a repo skill that hides a bundled one, and of the per-server status lines. TIM-537 items 3 and 6.
- **MCP-G13** [builder] How chad keeps clanka's `McpConfig.load` to the one file. As read, `load` also reads `$XDG_CONFIG_HOME/clanka/mcp.json` or `$HOME/.config/clanka/mcp.json`, and `.mcp.json` in the directory it is given, before the files it is passed. TIM-537 item 5 says "one `mcp.json`".
- **MCP-G15** [builder] Where in the image the bundled skills directory is. TIM-537 item 3.
- **MCP-G17** [builder] The sentence chad appends to a skill's content around the path of MCP-102 or MCP-103, which has to say what MCP-104 requires. TIM-537 item 1 and TIM-538.
- **MCP-G21** [builder] Two texts the prototype used and no ticket decides. They are "searchTools: no MCP server is connected.", for a `searchTools` call the current layer cannot answer, and "MCP servers are not running.", for a call made when no layer exists and none is being built. TIM-555 prototype.
- **MCP-G22** [builder] How message 8 is shortened or grouped when many tools are new. TIM-555 lists the long list as not run.

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
| MCP-29 | TIM-546 item 8 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
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
| MCP-42 | TIM-542 items 4, 24 and 30, amended by TIM-559 ruling on MCP-G6 | Tim; the queue places Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-43 | TIM-531 item 2, TIM-537 round 3 facts | Tim | read |  | `rule` | `skills-mcp` |
| MCP-44 | TIM-537 item 8, TIM-541 item 2 | Tim; `npx` and no Python package Architect (Tim has not read) | run |  | `rule` | `harness` |
| MCP-45 | TIM-537 item 8, TIM-541 item 12 | Tim; the cache paths Architect (Tim has not read) | run |  | `rule` | `harness` |
| MCP-46 | TIM-537 item 9 | Tim | not run |  | `definition` | - |
| MCP-47 | TIM-537 item 9 and round 3 item 1 (TIM-545), amended by TIM-559 ruling on MCP-G1 | Tim; the signature Architect (Tim has not read) | read | TIM-559 | `rule` | `skills-mcp` |
| MCP-48 | TIM-537 item 9 and round 3 item 1, amended by TIM-559 ruling on MCP-G1 | Tim; the wording Architect (Tim has not read) | read |  | `definition` | - |
| MCP-49 | TIM-537 items 9 and 14, amended by TIM-559 ruling on OV-G1 | Tim; the pin and no fallback Architect (Tim has not read) | read | TIM-559 | `fact` | `skills-mcp` |
| MCP-50 | TIM-537 item 12 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-51 | TIM-537 item 12 | Tim | read |  | `definition` | - |
| MCP-52 | TIM-537 item 13, amended by TIM-559 ruling on MCP-G8 | Tim; the file Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-53 | TIM-537 item 13 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-54 | TIM-537 item 11 | Tim | read |  | `rule` | `skills-mcp` |
| MCP-55 | TIM-537 item 9 and round 3 facts | Tim | read |  | `rule` | `skills-mcp` |
| MCP-56 | TIM-537 item 13, TIM-534 item 15, TIM-557 items 36 and 40 | Tim; the notice key Architect (Tim has not read) | read; the notice key not run | TIM-557 | `rule` | `skills-mcp` |
| MCP-57 | TIM-537 item 13 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-58 | TIM-537 item 11, TIM-542 item 29, amended by TIM-559 ruling on MCP-G5 | Tim; dropping the `daemon` clause Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-59 | TIM-537 item 10, amended by TIM-559 ruling on MCP-G2 | Tim; the port number Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-60 | TIM-537 item 10, amended by TIM-559 ruling on MCP-G4 | Tim; any thread Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-61 | TIM-537 item 10, TIM-542 item 6 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-62 | TIM-542 item 13, TIM-537 item 10 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-63 | TIM-537 item 11, amended by TIM-559 ruling on MCP-G6 | Tim; the condition Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-64 | TIM-537 item 11 | Tim | not run |  | `rule` | `skills-mcp` |
| MCP-65 | TIM-531 item 6, TIM-537 follow-up rule 1, kept by TIM-555 | Architect (Tim has not read) | run | TIM-549, TIM-555 | `rule` | `skills-mcp` |
| MCP-66 | TIM-537 follow-up rule 1, kept by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-67 | TIM-537 follow-up rule 1, TIM-555 item 2 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-68 | TIM-537 follow-up rule 7, TIM-555 prototype | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-69 | TIM-537 follow-up rule 2, amended by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-70 | TIM-537 follow-up rule 2, amended by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-71 | TIM-537 follow-up rule 2, amended by TIM-555 item 5 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-72 | TIM-555 item 5 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-73 | TIM-537 follow-up rule 2, kept by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-74 | TIM-555 finding 4, TIM-553 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-75 | TIM-537 follow-up rules 2 and 3, TIM-555 finding 3 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-76 | TIM-555 item 8 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-77 | TIM-537 follow-up rule 3, amended by TIM-555 item 3 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-78 | TIM-537 follow-up rule 3, amended by TIM-555 item 3 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-79 | TIM-555 item 3 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-80 | TIM-555 items 3 and 4 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-81 | TIM-537 follow-up rule 4, amended by TIM-555 item 4 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-82 | TIM-537 follow-up rule 4, amended by TIM-555 item 4 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-83 | TIM-537 follow-up rule 4, amended by TIM-555 item 4 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-84 | TIM-537 item 13, TIM-555 item 4 | Tim; the wording Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-85 | TIM-537 follow-up rule 4, kept by TIM-555 | Architect (Tim has not read) | run |  | `fact` | `skills-mcp` |
| MCP-86 | TIM-537 follow-up rule 7, kept by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-87 | TIM-555 item 6 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-88 | TIM-555 item 6 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-89 | TIM-537 follow-up rule 6, amended by TIM-555 item 1 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-90 | TIM-555 item 2 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-91 | TIM-555 item 2 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-92 | TIM-555 item 2 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-93 | TIM-549 item 28 (TIM-537 follow-up rule 5), kept by TIM-555 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-94 | TIM-555 item 7, TIM-553 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-95 | TIM-555 item 7 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-96 | TIM-555 item 7 | Architect (Tim has not read) | run |  | `rule` | `skills-mcp` |
| MCP-97 | TIM-553 item 8, as recorded on TIM-555, TIM-557 item 41, TIM-559 round 2 R4 and R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | run; no notice not run |  | `rule` | `skills-mcp` |
| MCP-98 | TIM-557 items 36 and 40 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-99 | TIM-558 item 33 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-100 | TIM-558 item 17, amended by TIM-559 ruling on MCP-G20 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-101 | TIM-558 item 52, withdrawn by TIM-559 ruling on OV-G1 | Architect (Tim has not read) | not run |  | `rule` | - |
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
| MCP-115 | TIM-559 ruling on MCP-G1 | Architect (Tim has not read) | read |  | `rule` | `skills-mcp` |
| MCP-116 | TIM-559 ruling on MCP-G8, TIM-559 round 3 L3 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-117 | TIM-559 ruling on MCP-G8 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-118 | TIM-559 ruling on MCP-G5 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-119 | TIM-559 ruling on MCP-G5 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-120 | TIM-559 ruling on MCP-G5 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-121 | TIM-559 ruling on MCP-G5 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-122 | TIM-559 ruling on MCP-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-123 | TIM-559 ruling on MCP-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-124 | TIM-559 ruling on MCP-G4 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-125 | TIM-559 ruling on MCP-G4 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-126 | TIM-559 ruling on MCP-G7 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-127 | TIM-559 ruling on MCP-G7 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-128 | TIM-559 ruling on MCP-G8 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-129 | TIM-559 ruling on MCP-G7 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-130 | TIM-559 ruling on MCP-G20 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| MCP-131 | TIM-559 ruling on MCP-G23 | Architect (Tim has not read) | not run |  | `definition` | - |
| MCP-132 | TIM-559 round 3 A1 | Architect (Tim has not read) | read |  | `fact` | `skills-mcp` |
| MCP-133 | TIM-559 round 3 A1 | Architect (Tim has not read) | read |  | `fact` | `skills-mcp` |
| MCP-134 | TIM-559 round 3 A1 | Architect (Tim has not read) | not run | TIM-559 | `definition` | - |
| MCP-135 | TIM-559 round 3 A1, TIM-559 round 4 items 7 and 8 | Architect (Tim has not read) | not run |  | `definition` | - |
| MCP-136 | TIM-559 round 3 L3 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-137 | TIM-559 round 4 item 10 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| MCP-138 | TIM-559 round 4 item 10 | Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
