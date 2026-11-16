# Live checks

These checks run chad against a real Discord, a real Codex login and a real deployment. No test in the repository does
any of them, because no job holds a Discord token, a Codex login or access to your server. Do each one by hand, once,
on the image you run, in the order given. Each step says what you should see. You need nothing outside this file and
`docs/running.md`.

Record what you saw in the Result column below, or in a comment on the pull request that ships the image you ran.
A check with no recorded result has not run.

## Status

| Check                                                        | What it confirms                                                                                                                 | Result  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1. `chad setup` on a real bot                                | Setup turns the message content intent on, or says where to click. The invite gives the bot what it needs in a server.           | not run |
| 2. Codex login in a thread                                   | The first direct message posts a login code, and its turn finishes once you approve the code.                                    | not run |
| 3. A direct message                                          | chad answers a direct message on the login from check 2.                                                                         | not run |
| 4. Stop                                                      | The Stop button on the status message stops a turn.                                                                              | not run |
| 5. A mention in a server channel, then a message without one | A mention opens a thread, and chad reads a message in that thread that does not mention it.                                      | not run |
| 6. The other Codex models (optional)                         | The sub-agent runs on `gpt-6.1-sol`, `gpt-6.1-terra` or `gpt-6-luna` on your login.                                              | not run |
| D1. Publish the image                                        | The image builds and pushes to `ghcr.io/tim-smart/chad`.                                                                         | not run |
| D2. The volume's filesystem                                  | The volume's filesystem is one chad's lock and SQLite are safe on.                                                               | not run |
| D3. asphodel for real                                        | The asphodel plugin talks to a real asphodel daemon with its token.                                                              | not run |
| D4. Backup and restore                                       | chad's tar and asphodel's backup restore onto two fresh volumes, and the restored pair recalls a memory saved before the backup. | not run |

Checks 1 to 6 are the hand checks and the Codex check. D1 to D4 are deployment checks. None of them has been run
yet, and the automated suite only runs fakes of Discord, Codex and asphodel.

## Before you start

For checks 1 to 6:

- A running chad from `docs/running.md`, "Docker", on a fresh volume. Commands below are written `chad <command>`, so
  run each one as `docker exec -it chad chad <command>`.
- No `CHAD_OPENAI_API_KEY` in the container's environment, and no model change, so chad runs on the default
  `openai/gpt-6-astra/medium` through a Codex login. With the key set, chad uses the OpenAI API and check 2 shows no
  code.
- A ChatGPT account that can use Codex.
- A Discord application with a bot, made at https://discord.com/developers/applications, and its bot token. Leave
  "Message Content Intent" off for now, so check 1 can show what setup does about it.
- A Discord server you own, with one ordinary text channel.
- Your own Discord user id. Turn on Developer Mode in Discord's settings, then right-click your name and pick "Copy User
  ID".

For D1 to D4, as well:

- A checkout of chad's repository at the commit the image was built from, on the host that runs Docker. The commands
  run from its root.
- For D3 and D4, asphodel set up as in "D3. asphodel for real", with an LLM chosen in its first-run setup. With "none
  for now" asphodel ingests turns but extracts no memories, and D4 has nothing to recall.

## 1. `chad setup` on a real bot

1. Run `chad setup`. Paste the bot token, give your user id and your timezone, and answer no to "Log chad in to Codex
   now?", so check 2 can run the login from a thread.
2. Setup prints `The token is the bot <name>'s.` with your bot's name, and an `invite: <url>` line.
3. It then prints one of these:
   - `Message Content Intent turned on for the bot.`
   - `Message Content Intent is on for the bot.`
   - `Turn on Message Content Intent under Privileged Gateway Intents at <link> ...`. Open the link, turn it on and
     save.
4. Open the invite URL and add the bot to your server.

Passes when the developer portal shows Message Content Intent on, and the bot is in your server. Record which of the
three lines setup printed. The third is the expected one if Discord does not let a bot change its own intents.

## 2. Codex login in a thread

chad is not logged in yet, so the first message that reaches the model asks for a login.

1. Send the bot a direct message, such as "what time is it?".
2. The DM gets `To log chad in to Codex, open <url> and enter the code <code>. The code is good for 15 minutes.`
3. Open the URL, sign in with your ChatGPT account and enter the code.

Passes when the answer to your message arrives in the same DM, with no second message from you. `chad login` then
prints `chad is already logged in to Codex. ...`.

If no code arrives and chad answers straight away, chad was already logged in or has an API key: run `chad logout`,
check the environment, and send another message. If you ever hit a usage limit on your login, keep the turn's
`chad logs` lines. Nobody has seen a real usage-limit frame yet, and that log shows what the service sends.

If the login or its turn fails, these show where it stopped. `--since 30m` keeps the log short, and `--json` prints the
stored lines in full.

```sh
chad logs --since 30m --level warn
chad logs --since 30m --event turn
chad status
```

| What you see                                                    | Where to look                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No reply and no code at all                                     | `--event message` for `message.ignored`. Its reason `not-owner` means the author id is not on the owner list. `--event chat` for `chat.connected`, or for `chat.refused`, which names a missing privileged intent. |
| `chad is not logged in to Codex.` in the DM                     | chad could not post a code there. Check the status line and `--event turn`.                                                                                                                                        |
| The code, then "Login timed out. Send a message to try again."  | The code was not entered within 15 minutes. Send another message.                                                                                                                                                  |
| The code, then "Login failed (…). Send a message to try again." | `--event turn` for the `turn.failed` line and its reason.                                                                                                                                                          |
| You approved the code, but the turn fails or never answers      | `--event turn` for `turn.login-wait`, `turn.retry` and `turn.failed`. `chad logs --turn <id> --json` gives the whole turn, and the `turn.failed` line carries the cause the call ended with.                       |
| A model warning at start                                        | `--event model` for `model.check-failed`.                                                                                                                                                                          |

## 3. A direct message

Send the bot another direct message, such as "what's 2+2?".

Passes when chad answers in the DM with no login code. While it works, a status message shows the turn's actions and a
Stop button.

## 4. Stop

Send a message that takes a while, such as "count slowly to 60 in a script, printing each number". While the status
message is up, click Stop.

Passes when the turn ends with a `Stopped after <time>.` line, and chad answers your next message as usual.

## 5. A mention in a server channel, then a message without one

1. In the text channel, send a message that mentions the bot, such as "@chad what's 2+2?".
2. chad opens a thread on that message and answers in it.
3. In that thread, send a message with no mention, such as "and times 3?".

Passes when chad answers the second message in the thread. If it answers the first and ignores the second, the message
content intent is off. If no thread opens, the bot lacks Create Public Threads in that channel. The invite asks for
View Channel, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History and Attach Files.

## 6. The other Codex models (optional)

1. Run `chad model --subagent openai/gpt-6.1-sol/medium`.
2. Ask chad for something it hands to a sub-agent, such as "use a sub-agent to list three facts about Wellington".
3. Run `chad model --subagent none` afterwards, or keep it.

Passes when the turn answers with no model error. `gpt-6.1-terra` and `gpt-6-luna` can be tried the same way, at
efforts `low` and `medium`. A refused model fails the turn with `model_not_found`.

## D1. Publish the image

Build and push from the root of the repository, as `docs/running.md` says under "The image". Passes when `docker pull
ghcr.io/tim-smart/chad:<version>` works on your server and `chad status` in the container prints that version.

## D2. The volume's filesystem

chad's lock and SQLite's write-ahead log were only run on ext4 and tmpfs. On the host that holds the volume, run
`stat -f -c %T <the volume's directory>`, for example `/var/lib/docker/volumes` or, on k3s,
`/var/local-path-provisioner`.

Passes when it prints `ext2/ext3` (which is what ext4 shows as), `xfs` or `btrfs`. `nfs`, `cifs`, `fuse` or
`ceph` are not supported. `chad status` also warns when the volume is on NFS, CephFS, SMB, FUSE, tmpfs or the
container's own layer.

## D3. asphodel for real

The asphodel plugin is not in the image. The repository holds a working copy as a test fixture,
`test/fixtures/asphodel/asphodel.ts`, and porting the real plugin belongs to asphodel's repository. Until that lands,
this check uses the fixture.

1. Start asphodel and save its token in chad as `docs/running.md` says under "asphodel". Then open
   `http://127.0.0.1:7720/dashboard` on the host, choose an LLM (an OpenAI-compatible endpoint with its key, or a
   ChatGPT subscription and its login) and click Finish setup.
2. Copy the fixture into chad's working tree, from the root of the checkout:

   ```sh
   docker exec -i chad sh -c 'mkdir -p /data/repo/work/plugins && cat > /data/repo/work/plugins/asphodel.ts' \
     < test/fixtures/asphodel/asphodel.ts
   ```

3. Add the plugin to `/data/repo/work/chad.json`. On a fresh volume the file is `{ "plugins": {} }`, and
   `docker exec chad cat /data/repo/work/chad.json` shows what it holds now. Keep any plugin already in it, and add
   `asphodel` under `plugins`:

   ```json
   {
     "plugins": {
       "asphodel": {
         "settings": {
           "url": "http://asphodel:7720",
           "token": "${ASPHODEL_TOKEN}",
           "ownerName": "Tim"
         }
       }
     }
   }
   ```

   One way to write it is `docker exec -i chad sh -c 'cat > /data/repo/work/chad.json' < chad.json` from a file on
   the host.

4. Run `chad apply -m "Try the asphodel fixture"`. It prints `Applied <commit>.`, a settings line that ends with
   `token (${ASPHODEL_TOKEN} from the secret store)`, and `Rebuilt: asphodel.`, and `chad log` lists the commit.
5. Send chad two direct messages, then ask "what do you remember about me?".
6. Run `chad logs` and look for lines from the plugin `asphodel`.
7. Run `docker exec asphodel asphodel bank list`.

Passes when the apply loads the plugin, `chad logs` shows no `asphodel` error, and the bank list shows the bank
`chad` with your turns. A `401` in chad's log means the token chad holds is not asphodel's. A line `asphodel: memory is off until the daemon is back` means chad
cannot reach `http://asphodel:7720`: check that both containers are on the network `chad`.

The asphodel image tag in `docs/running.md` is `latest`. Pin it to the version you tested once this passes.

## D4. Backup and restore

This restores chad and asphodel onto two new volumes and checks that the restored pair still knows something said
before the backup. The old containers are renamed and the old volumes are kept, so you can go back until the check
passes. Run it from an empty directory on the host, and run steps 2 to 7 in one shell, since step 5 uses the `token`
variable from step 2. The `restore-check` directory will hold chad's Discord token, its Codex login and every saved
secret, so step 2 makes it readable by you alone before anything is written to it, and the end deletes it.

asphodel's backup holds its store only. Its tuning file `asphodel.toml`, its `secrets.toml` (the token and the LLM
key, when setup kept them) and a ChatGPT login stay in the old volume, so the steps carry the first two over and log
in again. Without `asphodel.toml` a fresh asphodel waits for setup and does not open the restored store.

1. Leave something to recall. Send chad a direct message such as "Remember for the restore check: my locker code is
   4817." Then run this until it lists a memory, which can take a minute while asphodel extracts it, and note the
   memory's id:

   ```sh
   docker exec asphodel asphodel recall --bank chad "locker code"
   ```

2. Save what the asphodel backup leaves out. `secrets.toml` may not exist, when the token comes from the environment
   and the LLM needs no key. If `mkdir` says `restore-check` exists, stop and remove it first, because an existing
   directory keeps its old mode.

   ```sh
   umask 077
   mkdir -m 700 restore-check
   ls -ld restore-check   # drwx------
   docker cp asphodel:/data/asphodel.toml restore-check/asphodel.toml
   docker cp asphodel:/data/secrets.toml restore-check/secrets.toml || echo "no secrets.toml"
   token=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' asphodel |
     sed -n 's/^ASPHODEL_TOKEN=//p')
   ```

3. Take both backups into the directory. The `umask` from step 2 makes the tar owner-only.
   `docker cp` keeps each file's mode from the container, so the last line makes the copies owner-only too:

   ```sh
   docker exec chad chad backup - > restore-check/chad.tar
   docker exec asphodel asphodel backup --out=/data/backup.db
   docker cp asphodel:/data/backup.db restore-check/asphodel.db
   chmod 600 restore-check/*
   ```

4. Stop both and keep them under other names:

   ```sh
   docker stop chad asphodel
   docker rename chad chad-old
   docker rename asphodel asphodel-old
   ```

5. Restore asphodel onto a new volume and start it. The first command, as root, puts the saved files on the volume and
   gives it to asphodel's uid. The second is asphodel's offline restore. The third starts it under the old name, so
   chad's `http://asphodel:7720` reaches it.

   ```sh
   docker volume create asphodel-restored
   docker run --rm --user 0:0 --entrypoint /bin/sh \
     -v asphodel-restored:/data -v "$PWD/restore-check:/backup:ro" ghcr.io/tim-smart/asphodel:latest -c '
       cp /backup/asphodel.toml /data/ &&
       cp /backup/asphodel.db /data/asphodel-backup.db &&
       if [ -f /backup/secrets.toml ]; then cp /backup/secrets.toml /data/ && chmod 600 /data/secrets.toml; fi &&
       chown -R 65532:65532 /data'
   docker run --rm -v asphodel-restored:/data ghcr.io/tim-smart/asphodel:latest \
     restore /data/asphodel-backup.db --data-dir /data
   docker run -d --name asphodel --restart unless-stopped --network chad \
     -p 127.0.0.1:7720:7720 \
     -e ASPHODEL_TOKEN="$token" \
     -v asphodel-restored:/data \
     ghcr.io/tim-smart/asphodel:latest \
     serve --listen 0.0.0.0:7720 --data-dir /data
   ```

   If asphodel's LLM is a ChatGPT subscription, log it in again:
   `docker exec -it asphodel asphodel llm login --data-dir /data`.

6. Restore chad onto a new volume and start it on the same network. The tar holds chad's secrets, `ASPHODEL_TOKEN`
   included, and the repo with the plugin.

   ```sh
   docker volume create chad-restored
   docker run --rm -i -v chad-restored:/data ghcr.io/tim-smart/chad:0.0.0 restore - < restore-check/chad.tar
   docker run -d --name chad --restart unless-stopped --stop-timeout 90 --network chad \
     -v chad-restored:/data \
     ghcr.io/tim-smart/chad:0.0.0
   ```

7. Check the pair:
   - `docker exec asphodel asphodel status` exits 0, with no purge pause.
   - `docker exec asphodel asphodel recall --bank chad "locker code"` lists the memory from step 1, with the same id.
   - `chad connection list` shows your connection and your owner id, and `chad secret list` shows the secrets you had,
     `ASPHODEL_TOKEN` among them.
   - In the DM, send `/new`, then ask "what's my locker code?". The new session has no history, so the answer comes
     from asphodel.
   - `chad logs` shows no `asphodel` error.

Passes when every item in step 7 holds. Then remove the old pair and the directory:

```sh
docker rm chad-old asphodel-old
docker volume rm chad-data asphodel-data
rm -r restore-check
```

From then on the volumes are `chad-restored` and `asphodel-restored`. To go back instead, put the old pair back:

```sh
docker rm -f chad asphodel
docker rename chad-old chad
docker rename asphodel-old asphodel
docker start asphodel chad
```
