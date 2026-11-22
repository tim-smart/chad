---
name: self-edit
description: Read before changing chad itself. Covers adding or fixing a plugin (tool, prompt chunk, hook, background job), skill, MCP server, plugin setting, secret, or persona, and reverting a bad change.
---

# Changing chad

Your plugins, skills, MCP servers, settings, and persona all live in one git repo on the data volume. Edit files there and apply them with the `chad` CLI. Nothing takes effect until you apply it; until then it's just a draft.

## Directory layout

```text
/data/repo/work/              the working checkout you edit
  plugins/<name>.ts           a plugin (or plugins/<name>/index.ts)
  skills/<name>/SKILL.md      a skill
  mcp.json                    MCP servers
  chad.json                   plugin settings and enable/disable flags
  package.json                npm packages for plugins and CLI tools, with package-lock.json
  persona.md                  who you are for the owner
/data/repo/live               the currently applied tree (never edit this)
/data/repo/node_modules/      chad, effect, and chad's other packages, with types and docs
/data/repo/examples/          source of chad's bundled plugins, for reference
/data/logs/chad.log           the daemon log
/data/home                    $HOME
/mnt/<name>                   directories mounted by the owner
```

- Put skills in `work/skills/` and nowhere else. Never create `.agents/skills` or `.kiro/skills` in the repo, and don't put skills in dot-directories under `$HOME`. Skills placed in those repo directories get picked up without an apply, bypassing checks and reverts, so `chad check` and `chad apply` refuse both.
- Never add an `AGENTS.md` to the repo. One under `work/` gets loaded without an apply, so `chad check` and `chad apply` refuse it. See "Where knowledge belongs" below for where to put that content instead.
- Directories under `/mnt` live outside the repo and have no commits or revert history.
- `/data/repo/examples/` contains the source of the bundled plugins for the running version of chad. Read it for reference, never edit it, and don't copy a bundled plugin into `work/plugins/` under the same name. Leave `/data/repo/examples`, `/data/repo/node_modules`, and chad's own packages under `/data/repo/` untouched.

## Where knowledge belongs

`persona.md` and every prompt chunk are sent in full on every turn of every session. A skill only puts its description into the prompt and is read on demand when a task needs it.

- **System prompt (`persona.md`)**: things every turn needs, like who you are for the owner, your tone, and global rules.
- **Skill**: anything only some tasks need, like how a tool or service works, a procedure, project conventions, or account details.
- When the owner mounts a directory, write a skill whose description names its path under `/mnt` and what it contains, then apply.
- When the owner asks you to remember something without naming a place, write a skill and mention in your reply that you did, with a quick note on why.
- When the owner asks to put reference material into the persona or prompt, mention once that a skill would load on demand instead, ask which they prefer, and follow their choice.

## Workflow

1. Edit files under `/data/repo/work`. `chad plugin new <name>` and `chad skill new <name>` scaffold a starter file and nothing else.
2. Run `chad check`. It runs every check that `chad apply` runs without committing anything. Fix whatever it reports and re-run until clean.
3. If you added or edited plugin code, have a sub-agent review it before applying (see "Reviewing a plugin" at the end of `plugin.md`). Fix every valid finding and re-run `chad check`. Don't apply a plugin while a valid finding is still open.
4. Run `chad apply -m "<why>"`.
5. Check `chad status` to see what loaded, what was skipped and why, and the installed chad and effect versions.

## Important rules and gotchas

- `chad check` and `chad apply` format every `.ts` file under `work/plugins/` in place with Prettier and list any files they rewrote. Formatting uses chad's style (no semicolons) unless a Prettier config in `work/` (like `.prettierrc.json`) overrides it. Re-read a file before editing it again after running a check. Files that don't parse are left untouched and reported by the type-checker.
- `chad apply` publishes the entire `work/` tree, including drafts from other sessions. Check the changed-file list printed by `chad check`; if you see files that aren't yours, stop and tell the owner.
- `chad apply -m "<why>" --expect <tree>` only applies if `work/` matches that git tree, otherwise it does nothing and exits 1. Scripts that computed the expected tree use this to avoid accidentally publishing concurrent drafts.
- Applied changes take effect on the next turn. For the rest of the current turn, you keep your old tools. Calling a tool whose plugin code or settings just changed fails in every active session with: `"<tool> was changed by an apply. The new version is in your next turn."`
- Applying changes to a plugin's code or settings affects other active sessions too. Their running turns lose that plugin's tools until the turn finishes, and any call still running 30 seconds into the swap is interrupted and may have partly run. The apply output lists affected sessions; mention them in your reply.
- `chad apply` resets the branch in `work/` to the applied commit, so manual git commits in `work/` won't stick. You can still use git in `work/` to inspect history or restore a single file (`git checkout <commit> -- plugins/x.ts`), then apply.
- Never put a secret in a repo file. Store it with `chad secret set NAME` (which reads from stdin) and reference it as `${NAME}` in `chad.json` or `mcp.json`. See the `credentials` skill for who saves secrets and how.
- Scripts you write must never prompt on a terminal for owner input (like an OTP code or an OAuth callback URL). Pass the value as an argument or on stdin from the calling script instead. Get one-off values with `requestOnce`, and lasting secrets with `requestSecret` plus `chad secret run`. Asking the owner to run a shell command on the server is a last resort when no tool covers it. The `credentials` skill has a full example for OAuth callback sign-ins.
- In a scheduled run, or any turn whose prompt says nobody is around to answer questions, don't apply, revert, purge, or toggle safe mode unless the prompt explicitly asks you to. Leave changes as a draft and report that in your reply.

## Testing a change

- Apply, summarize what you changed, and test in the next turn.
- While a background sub-agent is running in your turn, the next turn can't start. Any message the owner sends gets steered into the current turn on the old agent, so the new version won't be active yet. Calling a changed tool then fails with: `"The new version is in your next turn, which cannot start while this turn has a sub-agent running."`
- When no owner is around, schedule a one-off cron job to run the test. Its prompt must be self-contained (what to call, with what arguments, and what counts as a pass), since it runs as a new turn with only the history.
- If the cron plugin is disabled, report what you changed and stop. Don't try to trigger a new turn another way.

## Exit codes

- 0: success.
- 1: command ran and failed. The output explains what went wrong using `work/` paths.
- 2: bad usage.
- 3: owner-only command. Ask the owner to run it; don't work around it.
- 4: the daemon is required but isn't running or didn't respond. Run `chad status` and `chad logs`, then tell the owner.

## Plugins

Before writing a plugin, **READ IN FULL** `/data/repo/node_modules/effect/AGENTS.md` and `plugin.md` next to this file. Start from `chad plugin new <name>`, and use `/data/repo/examples/` as working examples.

Follow `/data/repo/node_modules/effect/AGENTS.md` strictly when writing Effect plugins.

A plugin isn't done until `chad check` passes and a sub-agent review has no open valid findings. See "Reviewing a plugin" in `plugin.md` for the review prompt and rules.

- Repo plugins can't reuse a bundled plugin's name, and `chad plugin new` rejects taken or bundled names.
- Plugins can use npm packages listed in `work/package.json`. Add them with `npm install --package-lock-only --ignore-scripts <name>` in `work/`, never plain `npm install`. See `plugin.md` for how installation works and which packages aren't supported.
- `chad plugin reload <name>` rebuilds a plugin whose code hasn't changed (for example, after an upstream service comes back online). It builds the new instance first and keeps the old one if the build fails.
- Deleting a plugin's file unloads it while keeping its stored data and timers. `chad plugin purge <name>` permanently deletes that data and those timers. It only works after the deletion is applied, and refuses any plugin still in the applied repo (even if disabled). Bundled plugins can't be deleted, so they can be purged while disabled, not while enabled.

## Skills

A skill is `skills/<name>/SKILL.md` with `name` and `description` in its YAML front matter. `name` must match the directory name. Because `description` is all a session sees before opening the skill, write it as the trigger condition for when to read the skill. Put longer reference material in sibling files and link to them from `SKILL.md`.

- `chad check` and `chad apply` fail if a skill is missing front matter, has a missing or empty `name` or `description`, has a `name` that doesn't match its directory, or collides with another repo skill's name.
- A repo skill with the same name as a bundled skill replaces the bundled one, including `self-edit`. Don't copy this skill to customize it; put the owner's conventions in a separate skill instead.
- New repos come seeded with `images`, `pdfs`, `documents`, `video`, and `dev-tools` from `/opt/chad/starter-skills`. They're normal repo skills that you can edit for the owner, and future image updates won't overwrite them. To restore one or add one to an older repo, run `mkdir -p /data/repo/work/skills` followed by `mkdir /data/repo/work/skills/<name> && cp -R /opt/chad/starter-skills/<name>/. /data/repo/work/skills/<name>/`, then apply. The second `mkdir` fails if the skill already exists, so it won't clobber an existing one.

## Command line tools

- The container image includes standard dev tools (including `nvim`), document and image tools (`pandoc`, `typst`, poppler tools like `pdftotext` and `pdftoppm`, `qpdf`, ImageMagick's `magick`, `rsvg-convert`, `pngquant`, `jpegoptim`, `gifsicle`), and video/audio tools (`ffmpeg`, `ffprobe`). `pandoc` generates PDFs with `--pdf-engine=typst`. `yt-dlp` isn't preinstalled; see the `video` skill (or `/opt/chad/starter-skills/video/SKILL.md`) for installing and using it. Check with `command -v` before installing anything.
- Packages in `work/package.json` can provide CLI binaries. Once applied, their commands are added to `PATH` for every session's next command, and reverting the package removes them from `PATH`, with no restart needed.
- This is the best way to install a tool the owner wants to keep, since it's committed, checked, and reverted with the repo. Add it with `npm install --package-lock-only --ignore-scripts --save-exact <name>@<version>` in `work/`, then run `chad check` and `chad apply`.
- Install scripts never run, so packages that rely on postinstall scripts won't work. Packages that ship prebuilt binaries via platform-specific optional dependencies do work.
- Repo-installed binaries sit at the end of `PATH` (after `npm install -g`, `uv tool install`, and `~/.local/bin`), so they can't shadow image tools or user-installed tools. Binaries from chad's own dependencies (like `tsc` or `semver`) aren't exposed here.
- A stdio MCP server in `mcp.json` can run one of these binaries by name in the same apply that adds its package.
- Safe mode skips package installation on startup. Applied repo binaries stay on `PATH` if already installed on disk, but will be missing after a safe-mode start on a clean install directory until safe mode is turned off.

## MCP servers

Edit `mcp.json` and apply. There is no CLI command to add a server.

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

- stdio servers can use `npx`, `uvx`, or `node`, all of which are in the image. The image has `python3` without packages or `pip`, and has no `apt` or `sudo`. Tools installed via `npm install -g`, `uv tool install`, or `~/.local/bin` persist on the volume and sit at the end of `PATH`, so they can't shadow image tools. Binaries from `work/package.json` also work by name.
- `chad check` validates `mcp.json`, confirms every `${NAME}` secret resolves, and prints which servers an apply would add, remove, or change, without connecting to them. A malformed `mcp.json` fails the apply.
- A server that fails to connect doesn't fail the apply. Apply prints each server's status and tool count.
- Restarting MCP servers interrupts all in-flight MCP calls, and stdio servers lose any in-memory state. An apply that changes `mcp.json` or `package-lock.json`, running `chad mcp restart`, or updating a secret referenced in `mcp.json` restarts every server. Interrupted calls fail with: `"mcp.<server>.<tool> was interrupted by an MCP restart. It may have run in part or in full."`
- Calls made during a restart fail immediately with: `"MCP servers are restarting. This call was not sent."` Nothing ran, so retry once the servers are back.
- A server's tool schemas can change after a restart. If a call fails validation, re-check the tool's current declaration.
- HTTP servers that take an API key authenticate via `headers`, using `${NAME}` for the secret.
- `chad mcp restart` rebuilds all MCP servers (it can't restart just one). Run it if a server drops, since chad doesn't auto-reconnect them.

### OAuth

HTTP servers that use OAuth require an `oauth` block. Without it, chad won't initiate OAuth, and a server returning 401 is shown as unavailable with an error telling you to add `oauth`.

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

- `"oauth": {}` is enough when the server supports dynamic client registration. chad registers on first sign-in and saves the client it receives.
- `clientId` specifies a pre-registered client, in which case chad uses it and skips registration. Adding `clientSecret` makes it a confidential client (requires `clientId`). Store the secret in the secret store and reference it as `${NAME}`.
- `redirectUrl` is sent verbatim as the redirect URI, so it must match the registered client's redirect URI. It defaults to `http://localhost/oauth/callback`. Nothing listens at either URL; the owner copies the final URL from their browser's address bar.
- `scopes` sets the requested OAuth scopes. If omitted, chad requests whatever the server advertises.
- Only HTTP servers support `oauth`. Every string inside `oauth` supports `${NAME}` secret expansion.
- A server without a valid login shows as `needs login` in apply output, `chad mcp restart`, `chad status`, and your prompt. chad never starts a login automatically on boot, apply, restart, or secret change, and other servers continue connecting normally.
- Only the owner can sign in. Call `await requestMcpLogin({ server: "linear" })` to post a sign-in button in the thread, then end your turn. The owner clicks it, opens the link, approves access, and pastes the final browser URL into a form. If `requestMcpLogin` isn't available, ask the owner to run `chad mcp login linear` on the server. `chad mcp logout linear` clears stored tokens and any registered client, and cancels an in-progress sign-in (if writing to the volume fails, it says so and keeps the login).
- If the authorization URL is too long for a chat message, chad doesn't post it and tells the owner to run `chad mcp login <name>` on the server to print it.
- Never ask the owner to paste the callback URL or a token into chat; the URL contains the authorization code.
- If the authorization server rejects the sign-in, chad reports only the OAuth error code (such as `invalid_grant`) and hides the rest of the response in case it echoes the code or client secret.
- Completing a sign-in or signing out restarts all MCP servers, interrupting any in-flight calls.
- chad refreshes OAuth tokens automatically and persists them across restarts. If a refresh is rejected or a refreshed token still gets 401, calls fail with `MCP server "<name>" needs the owner to sign in` and the server shows as `needs login`. Ask the owner to sign in again instead of retrying.
- Changing `url` or the `oauth` block invalidates the previous sign-in so old tokens are never sent to the updated config.

## Settings and secrets

`chad.json` stores each plugin's settings and enable/disable flag.

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

- Setting `"enabled": false` disables a plugin while preserving its stored data and pausing its timers (this works for bundled plugins too). Re-enabling it fires each overdue paused timer once and reports how many fired.
- The bundled `asphodel` plugin (chad's long-term memory) is disabled by default until you set `"enabled": true`. Its `settings` take the daemon's `url` and `"token": "${ASPHODEL_TOKEN}"`, with the token stored as `ASPHODEL_TOKEN`.
- Unknown keys or entries referencing a nonexistent plugin fail the apply.
- Empty strings are treated as missing. An unresolved `${NAME}` fails the plugin's load with an error naming it.
- Use `${NAME:-default}` for a fallback value. To write a literal `${X}`, use `${CHAD_DOLLAR:-$}{X}`.
- `chad check` and `chad apply` print which setting keys each plugin read and warn about unused keys in `chad.json`.
- `chad status` shows the settings each loaded plugin read and where each value came from. It's the only place bundled plugin settings are listed.
- `chad secret list` lists stored secret names (values can't be read back). Updating a secret reloads anything that references it. If a plugin fails to load with the new value, chad keeps the previous instance running, exits 1, keeps the new secret stored, and flags the plugin in `chad status` as running with the previous secret.
- For passwords or tokens used by tools to sign in, read the `credentials` skill.

## Persona

`persona.md` defines who you are for the owner. It's plain Markdown included in your system prompt.

Only edit it when the owner asks. See "Where knowledge belongs" for what belongs here versus in a skill.

## Undoing changes

- `chad log` lists previous applies. `chad revert` rolls back one apply, and `chad revert <commit>` rolls back to a specific commit. Reverts cover the entire repo and save anything currently in `work/` to a git ref that chad prints.
- To revert a single file, restore it with git in `work/` and apply.

## Safe mode

- In safe mode, nothing from the repo is loaded. `chad apply` still runs all checks and commits changes, which then load once safe mode is turned off (`chad safe off` or `/safe off`). Toggling a bundled plugin in `chad.json` still takes effect immediately.
- Only turn safe mode off when the owner asked you to fix the problem and your fix is applied.
- Never turn safe mode on unless the owner asks.

## Troubleshooting

To investigate why a turn, hook, or plugin failed, read the `diagnose` skill (which uses `chad logs` and `chad db query`).

Most check and apply errors explain what to fix. Here are the less obvious ones:

| Symptom                                            | Cause and fix                                                                                                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Plugin.make` fails to compile and names a service | A contribution still needs one of your own layers. Provide it with `Layer.provide(YourService.layer)`.                                                                 |
| A setting is reported missing even though it's set | Its value is an empty string, which chad treats as missing.                                                                                                            |
| Apply succeeded, but the new tool isn't available  | New tools arrive on the next turn.                                                                                                                                     |
| A hook does nothing                                | Failing or timed-out hooks are logged and skipped. Check `chad logs --plugin <name>`. After three consecutive failures of the same hook, chad notifies the owner once. |
