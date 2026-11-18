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

The server is kept private in three ways:

- asphodel's dashboard and Chromium's DevTools port are bound to the server's loopback. You reach them through an SSH
  port forward, and nothing else does.
- The Discord token and the model login are typed into `chad setup` over SSH and stored on chad's volume. They are
  never in the server's user data. asphodel's token is made on the server, in `/opt/chad/.env`, which only root reads.
- Once you have connected over Tailscale, `install.sh lockdown` closes every public port, SSH included. chad needs
  none: it connects out to Discord. The installer itself never changes the firewall, so until you run that step the
  server's SSH port is as your provider left it.

## What you need

- A DigitalOcean account, with an SSH key added to it. The key is the way back in if Tailscale does not come up.
- A Tailscale account, with Tailscale on the computer you work from.
- A Tailscale auth key, from "Settings", "Keys", "Generate auth key" in the admin console. Leave "Reusable" and
  "Ephemeral" off and give it a short expiry. The key ends up in the Droplet's user data, which everything running on
  the Droplet can read back from DigitalOcean's metadata service, chad's own shell included. A key for one use is
  worth nothing once the server has joined, and the installer joins before it starts any container.
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
   Without that the server drops off your tailnet when its key expires, after 180 days by default.
4. Connect:

   ```sh
   ssh root@chad
   ```

   Tailscale SSH asks you to confirm in a browser the first time. It follows your tailnet's SSH policy, and the
   default policy lets you reach your own machines.

5. From that session, close the public ports:

   ```sh
   bash /opt/chad/install.sh lockdown
   ```

   It sets the firewall to refuse every incoming connection that does not come over Tailscale, SSH included. One port
   stays open on purpose: 41641/udp, which is Tailscale's own. With it two machines connect directly, and without it
   they may fall back to a slower relay.

   The step changes nothing unless both of these hold:
   - The session it runs in came in over Tailscale. A server can be on a tailnet whose SSH policy does not let you in,
     so its Tailscale address alone is not taken as proof. From a session on the public address it stops and says so.
   - No other firewall rule lets connections in. `ufw` keeps such a rule when its default changes to deny, so a rule
     that allows port 22 from anywhere would leave SSH public. The step lists each rule it finds and stops. Delete
     them, as in `ufw delete allow 22/tcp`, and run it again. To keep one, set the firewall yourself in place of
     this step.

The installer writes what it did to `/var/log/cloud-init-output.log`. If the machine never appears in Tailscale, the
join failed, and the installer stopped before it started a container. The key is still in the Droplet's user data, so
revoke it in the admin console unless it shows there as used or expired. Then connect with
`ssh root@<the Droplet's public address>`, run `tailscale up --ssh --hostname=chad`, which prints a link to sign in
with, and run `bash /opt/chad/install.sh`.

After the lockdown, a server that drops off your tailnet has no SSH port to reach. The console in DigitalOcean's
control panel is then the way in, and `ufw allow 22/tcp` there opens SSH again.

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
copies of your own, pull chad's tar, asphodel's store and asphodel's settings to your computer:

```sh
save() {
  tmp=$(mktemp "$1.XXXXXX") &&
    { ssh root@chad "cd /opt/chad && $2" > "$tmp" && mv -f "$tmp" "$1" ||
      { rc=$?; rm -f "$tmp"; (exit "$rc"); }; }
}
save "chad-$(date +%F).tar" 'docker compose exec -T chad chad backup -'
save "asphodel-$(date +%F).db" 'docker compose exec -T asphodel asphodel backup --out -'
save asphodel.toml 'docker compose exec -T asphodel cat /data/asphodel.toml'
save secrets.toml 'docker compose exec -T asphodel cat /data/secrets.toml'
```

Each copy is written to a new file, which `mktemp` makes readable by you alone, and takes its name only once the
command on the server has succeeded. A backup that fails, or a connection that drops, removes the new file and leaves
an earlier copy of the same name as it was. `docs/running.md`, "Backup", uses the same pattern.

- chad's tar holds the Discord token, the model login, every saved secret and `agent-browser`.
- asphodel's backup holds its store and nothing else. `asphodel.toml` is the settings its setup wrote. Without it a
  new asphodel waits for setup and does not open a restored store.
- `secrets.toml` holds the LLM's API key, when you gave setup one. When there is none the last line fails with
  `No such file` and writes nothing. A ChatGPT login is in none of the files, so on a new server you log in again.
- Nothing holds Chromium's profile, so after a restore chad signs in to its sites again.

### Restoring chad

A restore goes onto a new volume, and the volume chad has now is kept until you have seen the restored chad work. On
a server the installer has run on, with the tar copied to it:

```sh
cd /opt/chad
docker compose stop chad
echo 'CHAD_VOLUME=chad-restored' >> .env
docker compose run --rm -T chad restore - < chad-2026-11-18.tar
docker compose up -d
docker compose exec chad chad status
```

`CHAD_VOLUME` names the volume chad's data is on, so from that line on chad runs on the new one. `chad restore`
refuses a volume that already holds a chad, so pick a name no volume has, which `docker volume ls` shows. If `.env`
has a `CHAD_VOLUME` line from an earlier restore, change that line and add none.

When `chad status` shows no problem and chad answers a message, remove the old volume with
`docker volume rm chad_chad-data`. To go back to it, take the `CHAD_VOLUME` line out of `.env` and run
`docker compose up -d`.

The tar brings chad's copy of asphodel's token with it. On a new server the installer made a different one, so give
chad the new server's:

```sh
sed -n 's/^ASPHODEL_TOKEN=//p' .env | tr -d '\n' | docker compose exec -T chad chad secret set ASPHODEL_TOKEN
```

### Restoring asphodel

`asphodel restore` moves the store it finds aside, as `asphodel.db.before-restore-<time>` on the same volume, and
deletes nothing. So it goes onto the volume asphodel already has. With the files copied to the server:

```sh
cd /opt/chad
docker compose stop asphodel
docker compose run --rm -T --entrypoint /bin/sh asphodel -c 'cat > /data/restore.db' < asphodel-2026-11-18.db
docker compose run --rm asphodel restore /data/restore.db --data-dir /data
docker compose run --rm --entrypoint /bin/sh asphodel -c 'rm /data/restore.db'
```

On a new server the volume has no settings yet, so put back the two files you saved. Leave the second line out if you
saved no `secrets.toml`. On the server the backup came from, the volume still has both, so skip these lines:

```sh
docker compose run --rm -T --entrypoint /bin/sh asphodel -c 'cat > /data/asphodel.toml' < asphodel.toml
docker compose run --rm -T --entrypoint /bin/sh asphodel -c 'umask 077 && cat > /data/secrets.toml' < secrets.toml
```

Then start it and check it:

```sh
docker compose up -d
docker compose exec asphodel asphodel status
```

`asphodel status` exits non-zero when something needs attention. If asphodel's LLM is a ChatGPT subscription and the
server is new, log in again with `docker compose exec asphodel asphodel llm login --data-dir /data`. Until then
asphodel stores each turn and extracts no memories.

## Updating

Run the installer again:

```sh
bash /opt/chad/install.sh
```

It fetches `deploy/` again, pulls the three images and restarts the containers whose image changed. chad waits up to
a minute for a turn to finish before it stops. The volumes, `/opt/chad/.env`, the firewall and whatever you changed
in chad's repo stay as they are.

The installer gives a chad volume asphodel and the browser once, and then marks the volume with the file
`/data/home/.deploy-seeded`. A volume with the mark is left alone. A new volume has none, and neither has one whose
first run was cut short, so the next run finishes those. The installer exits non-zero when chad does not come up or
when any part of that fails. Run it again until it prints "Done".

To hold chad at one image, add a line such as `CHAD_IMAGE=ghcr.io/tim-smart/chad:sha-4d3d587` to `/opt/chad/.env`.

## Another host

The installer needs root and `apt-get`, and nothing of DigitalOcean. On any Ubuntu 24.04 or Debian server:

```sh
curl -fsSL -o install-chad.sh https://raw.githubusercontent.com/tim-smart/chad/main/deploy/install.sh
printf 'Tailscale auth key: ' && read -rs TS_AUTHKEY && export TS_AUTHKEY
sudo --preserve-env=TS_AUTHKEY bash install-chad.sh
unset TS_AUTHKEY
```

`read -rs` takes the key without showing it, so it is not in your shell's history. The installer joins the tailnet
first, and when the join fails it starts nothing.

Without `TS_AUTHKEY` it starts the containers and joins nothing. Run `tailscale up --ssh` yourself, or keep the
server's own SSH and skip Tailscale. Either way the firewall is as it was until you run `install.sh lockdown` from a
session that came in over Tailscale.

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
