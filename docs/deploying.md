# Deploying chad to a cloud server

This puts chad on one small server with what it needs next to it: asphodel for long-term memory, a headless Chromium
to browse with, and Tailscale as the only way in. The guide uses a DigitalOcean Droplet. The same files work on any
Ubuntu 24.04 or Debian server that can run Docker, and "Another host" says how.

`docs/running.md` describes the image, the volume and every command in full. This file is the short path to a
running chad.

## What you get

`deploy/install.sh` installs Docker and Tailscale on the server and starts `deploy/compose.yaml`, which runs three
containers:

- `chad`, from `ghcr.io/tim-smart/chad:main`.
- `asphodel`, from `ghcr.io/tim-smart/asphodel:latest`. The installer makes its token, gives it to chad's secret
  store and turns chad's `asphodel` plugin on.
- `chromium`, a headless Chromium from `chromedp/headless-shell`. The installer puts `agent-browser` on chad's volume
  and gives chad a `browser` skill, so chad can open pages, fill forms and take screenshots.

Tailscale runs on the server itself and not in a container, so you reach the server over SSH whatever state the
containers are in.

Nothing listens on a public address once the server is on your tailnet:

- The firewall refuses every incoming connection that does not come over Tailscale, SSH included. chad needs none: it
  connects out to Discord.
- asphodel's dashboard and Chromium's DevTools port are bound to the server's loopback. You reach them through an SSH
  port forward, and nothing else does.
- The Discord token and the model login are typed into `chad setup` over SSH and stored on chad's volume. They are
  never in the server's user data. asphodel's token is made on the server, in `/opt/chad/.env`, which only root reads.

## What you need

- A DigitalOcean account, with an SSH key added to it. The key is the way back in if Tailscale does not come up.
- A Tailscale account, with Tailscale on the computer you work from.
- A Tailscale auth key, from "Settings", "Keys", "Generate auth key" in the admin console. Leave "Reusable" and
  "Ephemeral" off and give it a short expiry. The key ends up in the Droplet's user data, which everything running on
  the Droplet can read back from DigitalOcean's metadata service, chad's own shell included. A key for one use is
  worth nothing once the server has joined.
- A Discord application with a bot and its token, a Discord server to invite it to, and your own Discord user id.
  `docs/live-checks.md`, "Before you start", says where each comes from.
- A ChatGPT account that can use Codex, for chad's model.
- For asphodel, an OpenAI-compatible API key or a ChatGPT subscription. You can also choose neither for now, and
  asphodel then stores each turn and extracts no memories.

## Create the server

1. Copy `deploy/cloud-init.yaml` and put your Tailscale auth key in place of `tskey-auth-REPLACE-ME`.
2. In DigitalOcean, create a Droplet: Ubuntu 24.04 (LTS) x64, 2 vCPUs and 4 GB of memory, your SSH key, and under
   "Advanced Options" tick "Add Initialization scripts" and paste the file. Turn on backups here if you want
   DigitalOcean's.

   With `doctl`, the same Droplet is one command:

   ```sh
   doctl compute droplet create chad \
     --image ubuntu-24-04-x64 --size s-2vcpu-4gb --region nyc3 \
     --ssh-keys <your key's fingerprint> \
     --user-data-file cloud-init.yaml
   ```

3. Wait for the machine `chad` to appear on the "Machines" page of the Tailscale admin console. The first boot
   took two minutes in a local virtual machine. Open the machine's menu there and choose "Disable key expiry".
   Without that the server drops off your tailnet when its key expires, after 180 days by default, and by then its
   public SSH port is closed.
4. Connect:

   ```sh
   ssh root@chad
   ```

   Tailscale SSH asks you to confirm in a browser the first time. It follows your tailnet's SSH policy, and the
   default policy lets you reach your own machines.

The installer writes what it did to `/var/log/cloud-init-output.log`. If the machine never appears in Tailscale, the
key was refused. The firewall is then left open on port 22, so connect with `ssh root@<the Droplet's public address>`,
run `tailscale up --ssh --hostname=chad`, and run `bash /opt/chad/install.sh` to close the public ports.

If the server later drops off your tailnet, its public ports are still closed. The console in DigitalOcean's control
panel is then the way in, and `ufw allow 22/tcp` there opens SSH again.

## Set chad up

On the server:

```sh
cd /opt/chad
docker compose exec chad chad setup
```

The wizard asks for the Discord bot token, which it never echoes, then prints the link that invites the bot to your
server. It asks for your Discord user id and your timezone, and then offers the Codex login. The login prints an
address and a code: open the address in any browser, sign in to ChatGPT and enter the code. Nothing has to reach the
server for it.

Every other chad command runs the same way, as `docker compose exec chad chad <command>` in `/opt/chad`.
`chad status` shows what is up and what is wrong.

## Set asphodel up

asphodel waits for its first-run setup, which is a page on its dashboard. From your own computer, forward the port
and open `http://127.0.0.1:7720/dashboard`:

```sh
ssh -L 7720:127.0.0.1:7720 root@chad
```

Choose the LLM asphodel extracts memories with and click "Finish setup". chad's plugin is already on and holds the
token, so memory starts with chad's next message. `chad status` shows the plugin as `plugin: asphodel`.

`docs/running.md`, "asphodel", lists the plugin's other settings, such as `ownerName`. They go in
`/data/repo/work/chad.json` in chad's container, followed by `chad apply`.

## The browser

chad drives Chromium with `agent-browser`, which the installer put on chad's volume. The `browser` skill, which the
installer added to chad's repo as `work/skills/browser/SKILL.md`, tells the model how. Ask chad to open a page to try
it.

- Chromium keeps its profile on a volume, so a site chad signed in to stays signed in across restarts. There is one
  profile, and every session shares it.
- Chromium runs in its own container as an ordinary user. It has no sandbox of its own, because a container cannot
  give it one without more privileges.
- The image has the DejaVu fonts and no others, so a screenshot of a page in Chinese, Japanese or Korean, or of emoji,
  shows boxes.
- A file Chromium downloads stays in its container, and it cannot upload a file from chad's.

To watch a page, or to sign in to a site by hand, forward the DevTools port from your own computer:

```sh
ssh -L 9222:127.0.0.1:9222 root@chad
```

Then open `chrome://inspect` in Chrome on your computer, click "Configure", add `localhost:9222`, and click "inspect"
under a tab. The DevTools port has no password. Whoever reaches it controls the browser and every site it is signed
in to, which is why it is bound to loopback.

## What is kept, and backups

Everything lives in three Docker volumes on the Droplet's own disk, under `/var/lib/docker/volumes`:

- `chad_chad-data`: chad's database, repo, secrets, logins and home directory.
- `chad_asphodel-data`: asphodel's store and its settings.
- `chad_chromium-profile`: Chromium's cookies and site data.

They outlive a restart, a reboot, a new image and another run of the installer. Destroying the Droplet destroys them,
and so does `docker compose down -v`.

DigitalOcean's backups copy the whole disk once a week or once a day, for a fee, and are the least work. To keep
copies of your own, pull chad's tar and asphodel's store to your computer. Both hold secrets, so the `umask` makes
them readable by you alone:

```sh
umask 077
ssh root@chad 'cd /opt/chad && docker compose exec -T chad chad backup -' > "chad-$(date +%F).tar"
ssh root@chad 'cd /opt/chad && docker compose exec -T asphodel asphodel backup --out -' > "asphodel-$(date +%F).db"
```

chad's tar holds the Discord token, the model login, every saved secret and `agent-browser`. Neither file holds
Chromium's profile, so after a restore chad signs in to its sites again.

To restore chad, on a server the installer has run on, replace chad's volume with the tar and start it:

```sh
cd /opt/chad
docker compose rm -sf chad
docker volume rm chad_chad-data
docker compose run --rm -T chad restore - < chad-2026-11-18.tar
docker compose up -d
```

The tar brings chad's copy of asphodel's token with it. On a new server the installer made a different one, so give
chad the new server's:

```sh
sed -n 's/^ASPHODEL_TOKEN=//p' .env | tr -d '\n' | docker compose exec -T chad chad secret set ASPHODEL_TOKEN
```

`docs/live-checks.md`, check D4, restores asphodel's store.

## Updating

Run the installer again:

```sh
bash /opt/chad/install.sh
```

It fetches `deploy/` again, pulls the three images and restarts the containers whose image changed. chad waits up to
a minute for a turn to finish before it stops. The volumes, `/opt/chad/.env` and whatever you changed in chad's repo
stay as they are: the installer gives chad asphodel and the browser once, on a new volume, and never again.

To hold chad at one image, add a line such as `CHAD_IMAGE=ghcr.io/tim-smart/chad:sha-4d3d587` to `/opt/chad/.env`.

## Another host

The installer needs root and `apt-get`, and nothing of DigitalOcean. On any Ubuntu 24.04 or Debian server:

```sh
curl -fsSL -o install-chad.sh https://raw.githubusercontent.com/tim-smart/chad/main/deploy/install.sh
sudo TS_AUTHKEY=tskey-auth-... bash install-chad.sh
```

Without `TS_AUTHKEY` it starts the containers and leaves SSH and the firewall alone. Run `tailscale up --ssh`
yourself and then the installer again, or keep the server's own SSH and skip Tailscale.

`deploy/compose.yaml` also runs by itself on a machine that has Docker already. It needs `ASPHODEL_TOKEN` in a
`.env` file next to it, and `docs/running.md`, "asphodel", says how to give chad the token and turn the plugin on.

fly.io is not covered yet. This path wants one host that runs Docker Compose with Tailscale beside it, which is a
virtual machine.

## What has been run, and what has not

The files were run in a local virtual machine, booted from Ubuntu's 24.04 cloud image with `deploy/cloud-init.yaml` as
its user data. There the installer finished in two minutes, the three containers came up, chad opened a page through
Chromium, the asphodel plugin loaded with its token, the same firewall rules left the containers able to reach the
internet, everything came back after a reboot, both port forwards worked over SSH, Chromium kept a cookie across a
restart, a second run of the installer changed nothing, and a backup restored into a new volume. With a key that
Tailscale refused, the installer left SSH and the firewall as they were.

No part of it has run on DigitalOcean or on a real tailnet, because neither was available without paying for one or
joining someone's. `docs/live-checks.md`, check D5, is the list of what is still to see: the Droplet's first boot,
the join with an auth key, Tailscale SSH, the closed public ports, and `chrome://inspect` by hand.
