<p align="center">
  <img src="./assets/chad.svg" width="200" alt="chad: a black-and-white portrait of a bearded, square-jawed man in three-quarter view with a slight grin" />
</p>

<h1 align="center">chad</h1>

<p align="center">
  A Discord assistant that writes its own missing features in TypeScript.
</p>

Most self-hosted agents want half a home lab before they answer "hello." chad is a lighter alternative to Hermes: one process, one Docker image (`ghcr.io/tim-smart/chad`), and one `/data` volume. It is built on `effect/chat`, `clanka`, and `dfx`.

Tell it in Discord what you need, and it writes the plugin and hot-swaps it on the next turn.

## It edits itself

Everything you customize lives in one git repo at `/data/repo/work`:

```text
/data/repo/work/
  plugins/      TypeScript plugins
  skills/       Markdown skills, read on demand
  mcp.json      MCP servers
  chad.json     plugin settings
  package.json  npm packages for plugins
  persona.md    the persona in the system prompt
```

Plugins can add tools, Discord buttons and forms, prompts, hooks, and background jobs. Changes stay a draft until `chad apply`, which formats, type-checks, bundles, and validates them before it commits. Broken code is rejected while the live daemon keeps running, and passing changes hot-swap on the next turn with no restart. [`skills/self-edit/SKILL.md`](./skills/self-edit/SKILL.md) has the details.

If chad still paints itself into a corner, `chad revert` rolls back to any earlier apply, and `/safe on` loads nothing from the repo so you can fix things from Discord or the shell.

## Access and secrets

chad answers its owners and no one else. Each chat connection keeps an allowlist of Discord user IDs ([`docs/owners.md`](./docs/owners.md)); messages and button clicks from anyone else are silently ignored, and the messages are never stored.

It also doesn't ask for passwords in chat. When it needs a key or a one-off code, it posts a button that opens a Discord form, and for an MCP server it posts a sign-in link. API keys go straight to the secret store and MCP sign-in tokens are kept by chad, neither passing through the model. A one-off code reaches only the script that asked for it, and chad masks that exact value in logs and script output. A password you paste into a message anyway stays in the history like any other message, so change it. [`skills/credentials/SKILL.md`](./skills/credentials/SKILL.md) covers each kind.

## In the box

In DMs, just message chad. In server channels, an `@mention` opens an auto-titled thread where follow-ups need no mention (use `/mention off` for mention-free channels). Running turns post a live status message with a **Stop** button, and new messages steer an active turn. Built-in slash commands: `/new`, `/stop`, `/status`, `/model`, `/safe`, and `/mention`.

- **Plugins:** `cron`, `send-file`, `send-message`, `request-secret`, `request-mcp-login`, and `asphodel` (optional long-term memory, off by default). They use the public plugin API, and their source is in `/data/repo/examples/`.
- **Models:** `/model` switches live after a trial request. chad runs on a ChatGPT Codex login by default, or on the OpenAI API, an OpenAI-compatible endpoint, or [Google Antigravity](./docs/running.md#antigravity).
- **Tools:** git, gh, ripgrep, pandoc, typst, ImageMagick, ffmpeg, and [the rest of the image](./docs/running.md#the-image), plus starter skills that teach the model to use them.

## Deploy to a cloud server

[`docs/deploying.md`](./docs/deploying.md) puts chad on one DigitalOcean Droplet with `asphodel` for long-term memory and a live Chromium instance via the `browse` MCP. After lockdown, Tailscale is the only way in.

1. [Create a Droplet](https://cloud.digitalocean.com/droplets/new?image=ubuntu-24-04-x64&size=s-2vcpu-4gb&region=nyc3) (Ubuntu 24.04, 2 vCPUs, 4 GB memory). Select your SSH key and paste [`deploy/cloud-init.yaml`](./deploy/cloud-init.yaml) under "Startup scripts".
2. Run `ssh root@<the Droplet's IP address>`, then `cloud-init status --wait` so the first boot has finished, then `bash /opt/chad/install.sh`, and sign in to Tailscale at the link it prints.
3. In the Tailscale admin console, open **Machines**, find `chad`, and choose **Disable key expiry**. Otherwise the server drops off your tailnet when its key expires, after 180 days by default, and lockdown has already closed public SSH.
4. Run `ssh root@chad`, then `bash /opt/chad/install.sh lockdown` to close every public port except 41641/udp, which Tailscale uses.
5. In `/opt/chad`, run `docker compose exec chad chad setup` to connect Discord and log chad in to its model.

The guide covers each step in full, including asphodel setup, the browser, backups, and updating. The same installer runs on any Ubuntu 24.04 or Debian server.

## Run with Docker

```sh
docker volume create chad-data
docker run -d --name chad --restart unless-stopped --stop-timeout 90 \
  -v chad-data:/data \
  ghcr.io/tim-smart/chad:main
docker exec -it chad chad setup
```

`chad setup` connects Discord, sets the owner and the timezone, and offers to log chad in to Codex. [`docs/running.md`](./docs/running.md) covers image tags, Kubernetes, extra mounts, and backup and restore.

## Docs

- [`docs/running.md`](./docs/running.md): running, backing up, and restoring the image.
- [`docs/deploying.md`](./docs/deploying.md): chad, asphodel, Chromium, and Tailscale on one cloud server.
- [`docs/owners.md`](./docs/owners.md): who chad answers.
- [`docs/live-checks.md`](./docs/live-checks.md): manual checks run against a real Discord, Codex login, and deployment.
- [`docs/codex-capture.md`](./docs/codex-capture.md): how the recorded Codex frames replayed by the tests are made.
- [`skills/`](./skills/): bundled skills chad ships with.
- [`starter-skills/`](./starter-skills/): starter skills copied into a new repo for images, PDFs, documents, video, and dev tools.
- [`AGENTS.md`](./AGENTS.md): the contract for anyone changing chad.

The `prototypes` branch holds throwaway prototypes from before the build. It is never merged.
