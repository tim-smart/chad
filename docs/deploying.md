# Deploying chad to a cloud server

This puts chad on one small server with what it needs next to it: asphodel for long-term memory, a Chromium to browse
with that you can open in your own browser, and Tailscale as the only way in. The guide uses a DigitalOcean Droplet.
The same files work on any Ubuntu 24.04 or Debian server that can run Docker, and "Another host" says how.

`docs/running.md` describes the image, the volume and every command in full. This file is the short path to a
running chad.

## What you get

`deploy/install.sh` installs Docker and Tailscale on the server and starts `deploy/compose.yaml`, which runs three
containers:

- `chad`, from `ghcr.io/tim-smart/chad:main`.
- `asphodel`, from `ghcr.io/tim-smart/asphodel:latest`. The installer makes its token, gives it to chad's secret
  store and turns chad's `asphodel` plugin on.
- `chromium`, from `lscr.io/linuxserver/chromium`: Chromium on a desktop that a web page shows. chad drives it with
  `agent-browser`, and you watch and use the same browser from your own. The installer puts `agent-browser` on chad's
  volume and gives chad a `browser` skill, so chad can open pages, fill forms and take screenshots.

Tailscale runs on the server itself and not in a container, so you reach the server over SSH whatever state the
containers are in.

The server is kept private in four ways:

- `deploy/cloud-init.yaml` holds no secret. The server joins your tailnet when you sign in at a link the installer
  prints, so no Tailscale key is in the Droplet's user data, which everything running on a Droplet can read back.
- asphodel's dashboard and the browser's desktop are bound to the server's loopback. You reach the dashboard through
  an SSH port forward. The desktop is served on your tailnet by Tailscale and on no public address.
- The Discord token and the model login are typed into `chad setup` over SSH and stored on chad's volume. asphodel's
  token is made on the server, in `/opt/chad/.env`, which only root reads.
- Once you have connected over Tailscale, `install.sh lockdown` closes every public port, SSH included. chad needs
  none: it connects out to Discord. The installer itself never changes the firewall, so until you run that step the
  server's SSH port is as your provider left it.

## What you need

- A DigitalOcean account, and an SSH key on your computer. The key is how you first connect, and the way back in if
  Tailscale does not come up. Everything is done in DigitalOcean's control panel, so its command line, `doctl`, is
  not needed.
- A Tailscale account, with Tailscale on the computer you work from.
- MagicDNS and HTTPS certificates turned on for your tailnet, on the "DNS" page of the Tailscale admin console. The
  browser's desktop is served with them. Tailscale warns there that a machine's name then shows in a public log of
  certificates. Without them everything else works, and "Troubleshooting" gives another way to the desktop.
- A Discord application with a bot, made at https://discord.com/developers/applications, and its bot token.
- A Discord server to invite the bot to, and your own Discord user id. To get the id, turn on Developer Mode in
  Discord's settings, then right-click your name and pick "Copy User ID".
- A ChatGPT account that can use Codex, for chad's model.
- For asphodel, an OpenAI-compatible API key or a ChatGPT subscription. You can also choose neither for now, and
  asphodel then stores each turn and extracts no memories.

## Create the server

1. Create the Droplet in DigitalOcean's control panel. Open
   [the create page](https://cloud.digitalocean.com/droplets/new?image=ubuntu-24-04-x64&size=s-2vcpu-4gb&region=nyc3),
   which chooses Ubuntu 24.04 (LTS) x64 and 2 vCPUs with 4 GB of memory. Then, on that page:
   - Choose the datacenter region nearest to you.
   - Under "Choose Authentication Method", choose "SSH Key" and select your key. If your account has no key yet, click
     "Add SSH Key" and paste your public key, which is the content of a file such as `~/.ssh/id_ed25519.pub`. If
     you have no key at all, `ssh-keygen -t ed25519` on your computer makes one.
   - Expand "Additional Options", turn on "Startup scripts", and paste `deploy/cloud-init.yaml` into the box as it
     is. Without a copy of this repository, the file is at
     `https://raw.githubusercontent.com/tim-smart/chad/main/deploy/cloud-init.yaml`.
   - Turn on backups if you want DigitalOcean's.
   - Under "Finalize Details", give the Droplet a hostname, for example `chad`, and click "Create Droplet".

   When the Droplet is ready, the control panel shows its IP address. Copy it. It is the public address the next
   step connects to.

   The first boot installs Docker and Tailscale and fetches the files into `/opt/chad`. It joins nothing and starts
   no container.

2. Connect to the Droplet's public address with your SSH key, wait for the first boot to end, and run the installer:

   ```sh
   ssh root@<the Droplet's public address>
   cloud-init status --wait
   bash /opt/chad/install.sh
   ```

   The installer prints a link. Open it and sign in to Tailscale, and the server joins your tailnet as `chad`. Only
   then does it start the containers. It waits ten minutes for you, and starts nothing if the server has not joined.
   At the end it puts the browser's desktop on your tailnet and prints its address.

3. On the "Machines" page of the Tailscale admin console, open the menu of the machine `chad` and choose "Disable
   key expiry". Without that the server drops off your tailnet when its key expires, after 180 days by default.
4. Connect again, over Tailscale this time:

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
     this step. It also stops when `ufw` cannot list its rules.

### Optional: doctl in place of the control panel

`doctl` is DigitalOcean's command line, and step 1 above needs none of it. To use it, install it and sign it in to
your account with an API token, as
[DigitalOcean's guide](https://docs.digitalocean.com/reference/doctl/how-to/install/) says, and add your SSH key to
your DigitalOcean account. Then these three commands, run from a copy of this repository, stand in for step 1. The
first lists your keys with their fingerprints, the second makes the Droplet, and the third prints its public address.

```sh
doctl compute ssh-key list
doctl compute droplet create chad \
  --image ubuntu-24-04-x64 --size s-2vcpu-4gb --region nyc3 \
  --ssh-keys <your key's fingerprint> \
  --user-data-file deploy/cloud-init.yaml --wait
doctl compute droplet list --format Name,PublicIPv4
```

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

chad drives Chromium with `agent-browser`, which the installer put on chad's volume. Compose sets
`AGENT_BROWSER_CDP` in chad's container, and every command a session runs has it, so `agent-browser` attaches to
this Chromium with no flag and no connect step. The `browser` skill, which the installer added to chad's repo as
`work/skills/browser/SKILL.md`, tells the model how. Ask chad to open a page to try it.

To watch a page, or to sign in to a site by hand, open the desktop from a computer on your tailnet:

```
https://chad.<your tailnet's name>.ts.net:8443/
```

The installer prints the address in full, and `tailscale serve status` on the server prints it again. The page shows
the one Chromium there is. A tab chad opens appears in it as chad works, a tab you open is one chad can use, and a
site you sign in to is signed in for chad.

If the installer said the desktop is not on the tailnet, see "Troubleshooting".

- The desktop has no password. Anyone your tailnet's access rules let reach port 8443 of the server uses the browser
  and every site it is signed in to. On a tailnet of your own that is you. `tailscale serve --https=8443 off` on the
  server takes it off the tailnet, and the next run of the installer puts it back.
- Chromium keeps its profile on a volume, so a site chad signed in to stays signed in across restarts. There is one
  profile, and every session shares it. Chromium writes cookies to the disk a little after they are set, so a sign-in
  made just before a restart can be lost.
- Closing Chromium's window does not leave chad without a browser. It starts again in a moment.
- Chromium and the desktop run in their own container as an ordinary user that cannot become root. Chromium has no
  sandbox of its own, because a container cannot give it one without more privileges. The desktop's menu has a
  terminal, which is a shell in that container.
- A file Chromium downloads stays on its volume, and it cannot upload a file from chad's.
- Chromium's DevTools port, which `agent-browser` uses, is open to the other two containers and to nothing else.

## What is kept, and backups

Everything lives in three Docker volumes on the Droplet's own disk, under `/var/lib/docker/volumes`:

- `chad_chad-data`: chad's database, repo, secrets, logins and home directory.
- `chad_asphodel-data`: asphodel's store and its settings.
- `chad_chromium-profile`: Chromium's cookies and site data, and its desktop's settings.

They outlive a restart, a reboot, a new image and another run of the installer. Destroying the Droplet destroys them,
and so does `docker compose down -v`.

DigitalOcean's backups copy the whole disk once a week or once a day, for a fee, and are the least work. To keep
copies of your own, pull chad's tar, asphodel's store and asphodel's settings to your computer. Each backup goes in a
directory of its own:

```sh
dir=$(mktemp -d "chad-backup-$(date +%F).XXXXXX")
save() {
  tmp=$(mktemp "${dir:?}/$1.XXXXXX") &&
    { ssh root@chad "cd /opt/chad && $2" > "$tmp" && mv -f "$tmp" "$dir/$1" ||
      { rc=$?; rm -f "$tmp"; (exit "$rc"); }; }
}
save chad.tar 'docker compose exec -T chad chad backup -'
save asphodel.db 'docker compose exec -T asphodel asphodel backup --out -'
save asphodel.toml 'docker compose exec -T asphodel cat /data/asphodel.toml'
save secrets.toml 'docker compose exec -T asphodel cat /data/secrets.toml'
```

`mktemp` makes the directory and each file in it readable by you alone. A file takes its name only once the command
on the server has succeeded, so a backup that fails, or a connection that drops, leaves no file of that name. The
directory is new each time, so what is in it was all taken together: asphodel's settings belong to the store beside
them, and a `secrets.toml` from an earlier day is never mistaken for today's.

- `chad.tar` holds the Discord token, the model login, every saved secret and `agent-browser`.
- `asphodel.db` holds asphodel's store and nothing else. `asphodel.toml` is the settings its setup wrote. Without it a
  new asphodel waits for setup and does not open a restored store.
- `secrets.toml` holds the LLM's API key, when you gave setup one. When there is none the last line fails with
  `No such file` and the directory has no `secrets.toml`. A ChatGPT login is in none of the files, so on a new server
  you log in again.
- Nothing holds Chromium's profile, so after a restore chad signs in to its sites again.

The restores below read one backup's directory, copied to the server as `/root/backup`:

```sh
scp -r chad-backup-2026-11-18.Xk3f9a root@chad:/root/backup
```

Remove `/root/backup` from the server once you are done with it.

### Restoring chad

A restore goes onto a new volume, and the volume chad has now is kept until you have seen the restored chad work. On
a server the installer has run on:

```sh
cd /opt/chad
docker compose stop chad
echo 'CHAD_VOLUME=chad-restored' >> .env
docker compose run --rm -T chad restore - < /root/backup/chad.tar
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
deletes nothing. So it goes onto the volume asphodel already has:

```sh
cd /opt/chad
docker compose stop asphodel
docker compose run --rm -T --entrypoint /bin/sh asphodel -c 'cat > /data/restore.db' < /root/backup/asphodel.db
docker compose run --rm asphodel restore /data/restore.db --data-dir /data
docker compose run --rm --entrypoint /bin/sh asphodel -c 'rm /data/restore.db'
```

On a new server the volume has no settings yet, so put back the two files you saved. Leave the second line out if the
backup has no `secrets.toml`. On the server the backup came from, the volume still has both, so skip these lines:

```sh
docker compose run --rm -T --entrypoint /bin/sh asphodel -c 'cat > /data/asphodel.toml' < /root/backup/asphodel.toml
docker compose run --rm -T --entrypoint /bin/sh asphodel -c 'umask 077 && cat > /data/secrets.toml' \
  < /root/backup/secrets.toml
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
sudo bash install-chad.sh
```

It prints a link to sign in to Tailscale at, joins the tailnet, and only then starts the containers. On a server
that is already on a tailnet it goes straight on. The firewall is as it was until you run `install.sh lockdown` from
a session that came in over Tailscale.

To join with nobody at the terminal, give it a Tailscale auth key in `TS_AUTHKEY`. Make the key for one use, and
keep it out of your shell's history:

```sh
printf 'Tailscale auth key: ' && read -rs TS_AUTHKEY && export TS_AUTHKEY
sudo --preserve-env=TS_AUTHKEY bash install-chad.sh
unset TS_AUTHKEY
```

When the join fails the installer starts nothing. It also starts nothing when it is given a key on a server that is
already on a tailnet, because the key would be left usable. Revoke that key and run the installer without one.

`deploy/compose.yaml` also runs by itself on a machine that has Docker already. It needs `ASPHODEL_TOKEN` in a
`.env` file next to it, and `docs/running.md`, "asphodel", says how to give chad the token and turn the plugin on.

This path needs one host that runs Docker Compose with Tailscale beside it, which is a virtual machine. fly.io is
not that, and this guide does not cover it.

## Troubleshooting

- If `/opt/chad/install.sh` is not on the server, the first boot failed or the Droplet was made without the script.
  `/var/log/cloud-init-output.log` has what the first boot did. The two commands under "Another host" do the whole
  install.
- If the installer stopped while it waited for you to sign in to Tailscale, it started nothing. Run it again for a new
  link.
- If the installer exits non-zero, its last lines say why. Run it again once that is fixed, until it prints "Done".
  `docker compose ps` and `docker compose logs chad` in `/opt/chad` show a container that did not come up, and
  `docker compose exec chad chad status` shows what chad itself finds wrong.
- If the installer said the desktop is not on the tailnet, `tailscale serve` failed or did not answer within a
  minute. What it printed is just above that line. HTTPS certificates that are off for your tailnet are one cause.
  Fix what it names and run the installer again. Until then, forward the port from your own computer and open
  `http://localhost:3000`:

  ```sh
  ssh -L 3000:127.0.0.1:3000 root@chad
  ```

- If `ssh root@chad` does not connect, check that Tailscale is running on your computer and that the machine `chad`
  is on the "Machines" page of the Tailscale admin console. Until the lockdown, the Droplet's public address still
  takes SSH.
- If the server drops off your tailnet after the lockdown, it has no SSH port to reach. Open the Droplet's console in
  DigitalOcean's control panel and run `ufw allow 22/tcp` there to open SSH again.
