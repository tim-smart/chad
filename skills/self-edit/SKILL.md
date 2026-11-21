---
name: self-edit
description: Read before changing chad itself. Covers adding or fixing a plugin (a tool, a prompt chunk, a hook, a background job), a skill, an MCP server, a plugin setting, a secret or the persona, and undoing a change that went wrong.
---

# Changing chad

Your plugins, skills, MCP servers, settings and persona are files in one git repo on the data volume. You change yourself by editing those files and applying them with the `chad` CLI. Nothing you edit takes effect until an apply: until then an edit is a draft.

## Where things are

```text
/data/repo/work/              the checkout you edit
  plugins/<name>.ts           a plugin (or plugins/<name>/index.ts)
  skills/<name>/SKILL.md      a skill
  mcp.json                    MCP servers
  chad.json                   plugin settings and on/off switches
  package.json                the npm packages plugins import and the tools you keep, with package-lock.json
  persona.md                  who you are for the owner
/data/repo/live               what is loaded now. Never edit it.
/data/repo/node_modules/      chad, effect and chad's other packages, with their declarations and docs
/data/repo/examples/          the source of the plugins chad ships, to read as examples
/data/logs/chad.log           the daemon's log
/data/home                    $HOME
/mnt/<name>                   a directory the owner mounted
```

- Your skills go in `work/skills/` and nowhere else. Never create a `.agents/skills` or `.kiro/skills` directory in the repo, and do not put skills in dot-directories under `$HOME`. A skill in one of those two directories in the repo is announced to you with no apply, so no check ran on it and no revert covers it. `chad check` and `chad apply` refuse both directories.
- Never write an `AGENTS.md` in the repo. One under `work/` reaches you with no apply, and `chad check` and `chad apply` refuse it. "Where what you know goes" below says where to put what it would hold.
- A directory under `/mnt` is outside the repo. It has no commits and no revert.
- `/data/repo/examples/` is the source of the bundled plugins for the version that is running. Read it, do not edit it, and do not copy a bundled plugin into `work/plugins/` under its own name. Do not put anything at `/data/repo/examples` or `/data/repo/node_modules`, and leave the packages chad installs under `/data/repo/` alone.

## Where what you know goes

`persona.md` and every prompt chunk are sent whole in every turn of every session. A skill puts only its description there, and the rest is read when a task needs it.

- The prompt is for what every turn needs: who you are for the owner, your tone, a rule that covers everything you do.
- Anything only some tasks need is a skill: how a tool or a service works, a procedure, a project's conventions, account details.
- When the owner mounts a directory, write a skill whose description names its path under `/mnt` and what it holds, then apply.
- When the owner asks you to remember or always know something and names no place, write a skill. Say so in your answer, with one line on why.
- When the owner names the persona or the prompt and the content is reference material, say once that a skill would be read on demand, and ask which they want. Then do what they pick.

## The loop

1. Edit files under `/data/repo/work`. `chad plugin new <name>` and `chad skill new <name>` write a starting file and do nothing else.
2. `chad check`. It runs everything an apply runs and commits nothing. Fix what it reports and run it again.
3. If the change adds or edits plugin code, a sub-agent reviews it before you apply, as the review section at the end of `plugin.md` says. Fix every valid finding and run `chad check` again. A plugin is not finished while a valid finding is open, and you do not apply it.
4. `chad apply -m "<why>"`.
5. `chad status` shows what is loaded, what was skipped and why, and the chad and effect versions.

## Rules that are easy to get wrong

- `chad check` and `chad apply` first format every `.ts` file under `work/plugins/` with Prettier, in place, and name the files they rewrote. The style is chad's own (no semicolons) unless a Prettier config in `work/`, such as `.prettierrc.json`, says otherwise. Read a file again before you edit it after a check. A file that does not parse is left as it is and the type-check reports it.

- An apply takes the whole of `work/`, drafts from another session included. Read the list of changed files that `chad check` prints. If a file there is not yours, stop and tell the owner.
- A change reaches a session on its next turn. In the turn that applied it you keep the tools you had. A tool whose plugin's code or settings you changed fails with "<tool> was changed by an apply. The new version is in your next turn." until the turn ends, in every session.
- An apply that changes a plugin's code or its settings affects other sessions. Their running turns lose that plugin's tools until they end, and a call still running 30 seconds into the swap is interrupted and may have partly run. The apply output names the affected sessions. Say so in your answer.
- An apply resets the branch in `work/` to the applied commit, so commits you make there do not last. Use git in `work/` to read history or bring one file back (`git checkout <commit> -- plugins/x.ts`), then apply.
- A secret never goes in a file in the repo. It is saved with `chad secret set NAME`, which reads the value from stdin, and `chad.json` or `mcp.json` names it as `${NAME}`. The `credentials` skill says who saves it and how.
- A script you write never prompts at a terminal for something the owner has to supply, such as a code or the address a browser ended on. It takes the value as an argument or on stdin from the script that calls it. That script gets a one-off value with `requestOnce`. A value that stays valid is a secret: the owner saves it through `requestSecret`, which gives back no value, and the command gets it by name from `chad secret run`. Asking the owner to run a command in a shell on the server is the last resort, for when no tool covers it. The `credentials` skill has a recipe for a sign-in that ends on an address.
- In a scheduled run, or any turn whose prompt says nobody is there to answer questions, do not apply, revert, purge or change safe mode unless the prompt tells you to. Leave the change as a draft and say so in the answer.

## Testing a change

- Apply, say what you changed, and test in the next turn.
- While your turn has a background sub-agent running, the next turn cannot start. A message the owner sends then is steered into that turn and runs on the old Agent, so the new version is not there yet. The refusal says so: "The new version is in your next turn, which cannot start while this turn has a sub-agent running."
- With no owner around, schedule a one-off cron job that runs the test. Its prompt has to stand on its own: what to call, with what, and what counts as a pass. It runs as a new turn that has only the history.
- If the cron plugin is off, report what you changed and stop. Do not look for another way to start a turn.

## Exit codes

- 0: done.
- 1: it ran and failed. The output says what and where, with `work/` paths.
- 2: bad usage.
- 3: an owner command. Ask the owner to run it. Do not work around it.
- 4: the command needs the daemon and it is missing or did not answer. Run `chad status` and `chad logs`, then tell the owner.

## Plugins

Before you write one, **YOU MUST READ IN FULL** `/data/repo/node_modules/effect/AGENTS.md` and then `plugin.md` next to this file. Start from `chad plugin new <name>`. Working plugins to read are in `/data/repo/examples/`.

`/data/repo/node_modules/effect/AGENTS.md` MUST BE FOLLOWED when writing effect
plugins.

A plugin is done only when `chad check` passes and a sub-agent's review has no valid finding left. The review section at the end of `plugin.md` says how to run the review and what to do with what it finds.

- A repo plugin cannot take a bundled plugin's name, and `chad plugin new` refuses a taken or bundled name.
- A plugin can use npm packages, which `work/package.json` names. Add one with `npm install --package-lock-only --ignore-scripts <name>` in `work/`, never a plain `npm install`. `plugin.md` says what an install does and which packages do not work.
- `chad plugin reload <name>` rebuilds one plugin whose code did not change, for example after a service it talks to came back. It builds the new version first and keeps the old one if the build fails.
- Deleting a plugin's file unloads it and keeps its data and timers. `chad plugin purge <name>` drops them for good. It works only once the deletion is applied, and refuses a plugin still in the applied repo, including one that is off. A bundled plugin cannot be deleted, so it can be purged while it is turned off and not while it is on.

## Skills

A skill is `skills/<name>/SKILL.md` with `name` and `description` in its front matter. The name has to match the directory. The description is all a session sees until it reads the skill, so write it as the situation in which to read the skill. Put longer material in files next to it and name them in the skill.

- A check or an apply fails on a skill with no front matter, a missing or empty `name` or `description`, a name that differs from its directory, or two skills in the repo with one name.
- A skill with a bundled skill's name replaces the bundled one, and that includes this skill. Do not copy this skill to change it. Write the owner's conventions as a separate skill.
- The repo started with the skills `images`, `pdfs`, `documents`, `video` and `dev-tools`, copied from `/opt/chad/starter-skills`. They are repo skills like any other: change them to fit the owner, and add what you learn about a tool. A later image does not update them. To bring one back, or to add one to a repo made before they existed, run `mkdir -p /data/repo/work/skills` and then `mkdir /data/repo/work/skills/<name> && cp -R /opt/chad/starter-skills/<name>/. /data/repo/work/skills/<name>/`. The second `mkdir` fails when a skill of that name is there, so the copy never replaces one. Then apply.

## Command line tools

- The image has the usual development tools, `nvim` among them. For documents and images it has `pandoc`, `typst`, poppler's commands such as `pdftotext` and `pdftoppm`, `qpdf`, ImageMagick's `magick`, `rsvg-convert`, `pngquant`, `jpegoptim` and `gifsicle`. pandoc makes a PDF with `--pdf-engine=typst`. For video and audio it has `ffmpeg` and `ffprobe`. `yt-dlp` is not in the image: the `video` skill says how to install and use it, and a repo without that skill can read it at `/opt/chad/starter-skills/video/SKILL.md`. Run `command -v` on a tool before you install it.
- A package in `work/package.json` can be a command line tool. Once the change is applied, its commands are on PATH and run by name in every session's next command. A revert that takes the package out takes its commands off PATH. Neither needs a restart.
- This is the way to add a tool the owner wants kept: it is committed, checked and reverted with the rest of the repo. Add it as any package, `npm install --package-lock-only --ignore-scripts --save-exact <name>@<version>` in `work/`, then `chad check` and `chad apply`.
- Install scripts never run, so a tool that needs its install script does not work. A tool that ships its binary as an optional dependency for each platform does.
- These commands come last on PATH, after what you install with `npm install -g`, `uv tool install` or into `~/.local/bin`, so none of them can replace one of the image's tools or one of yours. A command of chad's own packages, such as `tsc` or `semver`, is not there.
- A stdio server in `mcp.json` can run one of these commands by name, added in the same apply as its package.
- Safe mode installs nothing when it starts. The commands of the applied tree stay on PATH while its install is on disk, and are missing after a safe-mode start that found it gone, until safe mode goes off.

## MCP servers

Edit `mcp.json` and apply. There is no command that adds one.

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/data/home/notes"
      ]
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  }
}
```

- stdio servers run with `npx`, `uvx` or `node`, which are in the image. The image has `python3` with no packages and no pip, no apt and no sudo. What you install with `npm install -g`, `uv tool install` or into `~/.local/bin` stays on the volume and sits last on PATH, so it cannot replace the image's own tools. A command of a package in `work/package.json` works too, by name.
- `chad check` reads `mcp.json`, checks that every `${NAME}` resolves and prints which servers an apply would add, remove or change. It connects nothing. A malformed `mcp.json` fails the apply.
- A server that cannot connect does not fail the apply. The apply prints each server's status and tool count.
- Any MCP restart interrupts the MCP calls that are running, and a stdio server loses what it held in memory. An apply that changes `mcp.json` or `package-lock.json`, `chad mcp restart` and a change to a secret that `mcp.json` names all restart every server. A call that was running fails with "mcp.<server>.<tool> was interrupted by an MCP restart. It may have run in part or in full."
- A call made during a restart fails at once with "MCP servers are restarting. This call was not sent." Nothing ran, so call again when the servers are back.
- After a restart a tool's parameters may have changed. When a call fails validation, check it against the tool's current declaration.
- An HTTP server that takes a key signs in with a header. Write the token in `headers` as `${NAME}`.
- `chad mcp restart` rebuilds every MCP server. It does not reconnect one. Run it when a server dropped. Nothing restarts one by itself.

### OAuth

An HTTP server that signs in with OAuth needs an `oauth` key. Without the key chad sends no OAuth request, and a server that answers 401 is listed as unavailable with an error that says to add it.

```json
{
  "mcpServers": {
    "linear": { "url": "https://mcp.linear.app/mcp", "oauth": {} },
    "slack": {
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "${SLACK_CLIENT_ID}",
        "clientSecret": "${SLACK_CLIENT_SECRET}",
        "redirectUrl": "https://chad.example.com/oauth/callback",
        "scopes": ["channels:read", "chat:write"]
      }
    }
  }
}
```

- `"oauth": {}` is enough for a server whose authorization server registers clients by itself. chad registers on the first sign-in and keeps the client it is given.
- `clientId` names a client the owner registered with the server. chad then uses that client and never registers one. With `clientSecret` it is a confidential client, and `clientSecret` needs `clientId`. Keep the secret in the secret store and write it as `${NAME}`.
- `redirectUrl` is sent as the redirect URI exactly as written, so it has to match what the client was registered with. The default is `http://localhost/oauth/callback`. Nothing listens at either: the owner copies the address the browser ends on.
- `scopes` are the scopes chad asks for. Without it chad asks for what the server names.
- Only an HTTP server takes `oauth`. Every string in it takes `${NAME}`.
- A server with no usable sign-in is listed as "needs login": in what an apply and `chad mcp restart` print, in `chad status`, and in your prompt. Nothing starts a sign-in by itself, at a boot, an apply, a restart or a secret change, and the other servers connect as usual.
- Only the owner signs in. You cannot, and no command you run does. Call `await requestMcpLogin({ server: "linear" })`, which posts a button in the thread, and end your turn. The owner presses it, opens the link chad posts, approves, and puts the address the browser ended on into a form. Where that tool is not there, ask the owner to run `chad mcp login linear` in a shell on the server. `chad mcp logout linear` drops the tokens and the registered client, and ends a sign-in that is under way. When it cannot write the volume it says so and chad stays signed in.
- A link too long for a message is not posted. chad then tells the owner in the thread to run `chad mcp login <name>`, which prints the link.
- Never ask the owner to paste that address or a token as a chat message. The address carries the code of the sign-in.
- A sign-in the authorization server refuses fails with the OAuth error code it gave, such as `invalid_grant`. chad repeats nothing else of the answer, which may quote the code or the client secret.
- A sign-in that finished, and a sign-out, restart every MCP server, as a secret change does. Calls in flight are interrupted.
- chad refreshes the token by itself and keeps the new one across restarts. When the server refuses the refresh, or still answers 401 to the token a refresh gave, a call fails with "MCP server "<name>" needs the owner to sign in", and the server shows as "needs login". Ask the owner to sign in again. Do not retry the call.
- A changed `url` or `oauth` block makes the server need a new sign-in. The old tokens are not sent to it.

## Settings and secrets

`chad.json` holds each plugin's settings and its on/off switch.

```json
{
  "plugins": {
    "weather": {
      "enabled": true,
      "settings": { "latitude": -36.85, "token": "${WEATHER_TOKEN}" }
    },
    "cron": { "enabled": false }
  }
}
```

- `"enabled": false` turns a plugin off and keeps its data and timers, which are held. This works for bundled plugins too. Turning a plugin back on fires each overdue held timer once, and the apply says how many.
- The bundled plugin `asphodel`, chad's long-term memory, is off until its entry says `"enabled": true`. Its `settings` are the asphodel daemon's `url` and `"token": "${ASPHODEL_TOKEN}"`, with the token saved as the secret `ASPHODEL_TOKEN`.
- The bundled plugin `stale-tabs` is also off until its entry says `"enabled": true`. It closes the tabs of the shared Chromium whose URL has not changed for `maxAge` (default `"1 hour"`), and always leaves one open. Its `url` setting is Chromium's DevTools address, `http://172.30.72.10:9223` in the Compose deploy.
- An unknown key or an entry that names no plugin fails the apply.
- An empty string reads as missing. A `${NAME}` found nowhere fails the plugin's load with an error that names it.
- `${NAME:-default}` gives a default. To write a literal `${X}`, write `${CHAD_DOLLAR:-$}{X}`.
- `chad check` and `chad apply` list the keys each plugin read and warn about keys in the file it did not read.
- `chad status` lists the settings each loaded plugin read and where each came from. It is the only place a bundled plugin's settings are listed.
- `chad secret list` lists the stored names. There is no way to read a value back. Changing a secret reloads what names it. If a plugin fails to load with the new value, it keeps its old instance, the command exits 1 and the secret stays stored. `chad status` marks it as running with the previous secret.
- For a password or a token that a tool signs in with, read the `credentials` skill.

## The persona

`persona.md` is who you are for the owner. It is plain Markdown and goes into your system prompt.

- Edit it only when the owner asks you to. "Where what you know goes" says what belongs in it and what belongs in a skill.

## Undoing

- `chad log` lists the applies. `chad revert` goes back one, `chad revert <commit>` further. A revert covers the whole repo and saves what was in `work/` to a git ref it prints.
- To undo one file, restore it with git in `work/` and apply.

## Safe mode

- In safe mode nothing from the repo is loaded. An apply still runs every check and commits, and its change loads when safe mode goes off (`chad safe off` or `/safe off`). Turning a bundled plugin on or off in `chad.json` takes effect at once.
- Turn safe mode off only when the owner asked you to fix the problem and your fix is applied.
- Never turn safe mode on unless the owner asks.

## When something fails

To find out why a turn, a hook or a plugin failed, read the `diagnose` skill. It reads the log with `chad logs` and the `turns` table with `chad db query`.

Most errors from a check or an apply say what to fix. These do not:

| What you see                                       | What it means                                                                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Plugin.make` does not compile and names a service | A contribution still needs one of your own Layers. Add `Layer.provide(YourService.layer)` to it.                                                                                               |
| A setting is missing, and it is in `chad.json`     | Its value is an empty string, which reads as missing.                                                                                                                                          |
| The apply worked and the tool is not there         | It arrives next turn.                                                                                                                                                                          |
| A hook does nothing                                | A hook that fails or runs past its budget is logged and skipped. Read its entries with `chad logs --plugin <name>`. After three failures in a row of the same hook, chad tells the owner once. |
