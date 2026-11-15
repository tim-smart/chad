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

- A skill anywhere but `work/skills/` is not loaded. Do not put skills in dot-directories under `$HOME`.
- A directory under `/mnt` is outside the repo. It has no commits and no revert.
- `/data/repo/examples/` is the source of the bundled plugins for the version that is running. Read it, do not edit it, and do not copy a bundled plugin into `work/plugins/` under its own name.

## The loop

1. Edit files under `/data/repo/work`. `chad plugin new <name>` and `chad skill new <name>` write a starting file and do nothing else.
2. `chad check`. It runs everything an apply runs and commits nothing. Fix what it reports and run it again.
3. `chad apply -m "<why>"`.
4. `chad status` shows what is loaded, what was skipped and why, and the chad and effect versions.

## Rules that are easy to get wrong

- An apply takes the whole of `work/`, drafts from another session included. Read the list of changed files that `chad check` prints. If a file there is not yours, stop and tell the owner.
- A change reaches a session on its next turn. In the turn that applied it you keep the tools you had. A tool whose plugin's code you changed fails with "changed by an apply" until the turn ends. A change to only that plugin's settings reaches your running turn at once, unless it changes a tool's description or parameters. Then that tool waits for the next turn too.
- An apply that changes a plugin's code affects other sessions. Their running turns lose that plugin's tools until they end, and a call still running 30 seconds into the swap is interrupted and may have partly run. The apply output names the affected sessions. Say so in your answer.
- An apply resets the branch in `work/` to the applied commit, so commits you make there do not last. Use git in `work/` to read history or bring one file back (`git checkout <commit> -- plugins/x.ts`), then apply.
- A secret never goes in a file in the repo. Save it with `chad secret set NAME`, with the value on stdin, and write `${NAME}` where it is needed in `chad.json` or `mcp.json`.
- In a scheduled run, or any turn whose prompt says nobody is there to answer questions, do not apply, revert, purge or change safe mode unless the prompt tells you to. Leave the change as a draft and say so in the answer.

## Testing a change

- Apply, say what you changed, and test in the next turn.
- With no owner around, schedule a one-off cron job that runs the test. Its prompt has to stand on its own: what to call, with what, and what counts as a pass. It runs as a new turn that has only the history.
- If the cron plugin is off, report what you changed and stop. Do not look for another way to start a turn.

## Exit codes

- 0: done.
- 1: it ran and failed. The output says what and where, with `work/` paths.
- 2: bad usage.
- 3: an owner command. Ask the owner to run it. Do not work around it.
- 4: the command needs the daemon and it is missing or did not answer. Run `chad status` and `chad log`, then tell the owner.

## Plugins

Before you write one, read `/data/repo/node_modules/effect/AGENTS.md` and then `plugin.md` next to this file. Start from `chad plugin new <name>`. Working plugins to read are in `/data/repo/examples/`.

- A repo plugin cannot take a bundled plugin's name, and `chad plugin new` refuses a taken or bundled name.
- `chad plugin reload <name>` rebuilds one plugin whose code did not change, for example after a service it talks to came back. It builds the new version first and keeps the old one if the build fails.
- Deleting a plugin's file unloads it and keeps its data and timers. `chad plugin purge <name>` drops them for good. It works only once the deletion is applied, and refuses a plugin still in the applied repo, including one that is off.

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
- A call held during a restart fails after 60 seconds with "MCP servers are restarting. This call was not sent." Nothing ran, so call again.
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
