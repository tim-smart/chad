# Live checks

These checks run chad against a real Discord, a real Codex login and a real deployment. No test in the repository does
any of them, because no job holds a Discord token, a Codex login or access to your server. Do each one by hand, once,
on the image you run, in the order given. Each step says what you should see. You need nothing outside this file and
`docs/running.md`.

Record what you saw in the Result column below, or in a comment on the pull request that ships the image you ran.
A check with no recorded result has not run.

## Status

| Check                                                         | What it confirms                                                                                                                 | Result  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1. `chad setup` on a real bot                                 | Setup turns the message content intent on, or says where to click. The invite gives the bot what it needs in a server.           | not run |
| 2. Codex login in a thread                                    | The first direct message posts a login code, and its turn finishes once you approve the code.                                    | not run |
| 3. A direct message                                           | chad answers a direct message on the login from check 2.                                                                         | not run |
| 4. Stop                                                       | The Stop button on the status message stops a turn.                                                                              | not run |
| 5. A mention in a server channel, then a message without one  | A mention opens a thread that the model titles, chad reads a reply there with no mention, and a listed channel needs none.       | not run |
| 6. The other Codex models (optional)                          | The sub-agent runs on `gpt-6.1-sol`, `gpt-6.1-terra` or `gpt-6-luna` on your login.                                              | not run |
| 7. Fast mode (optional)                                       | The Codex login accepts the `priority` service tier, and a turn answers on it.                                                   | not run |
| 8. Slash commands                                             | Discord lists chad's slash commands, and each does what the typed command does.                                                  | not run |
| 9. A secret through a form                                    | The agent's request posts a button, the form saves the secret, and the value shows nowhere in the chat.                          | not run |
| 10. OAuth sign-in to an MCP server that registers chad itself | A server with `"oauth": {}` needs login, the owner signs in from Discord, and the sign-in outlives a restart.                    | not run |
| 11. OAuth sign-in with a client you registered                | `chad mcp login` signs in with your client id, secret, redirect URL and scopes, and registers no client.                         | not run |
| 12. A one-off value through a form                            | The agent's `requestOnce` waits in its turn, a command of that turn gets the value, and nothing keeps it.                        | not run |
| D1. Publish the image                                         | The image builds and pushes to `ghcr.io/tim-smart/chad`.                                                                         | not run |
| D2. The volume's filesystem                                   | The volume's filesystem is one chad's lock and SQLite are safe on.                                                               | not run |
| D3. asphodel for real                                         | The asphodel plugin talks to a real asphodel daemon with its token.                                                              | not run |
| D4. Backup and restore                                        | chad's tar and asphodel's backup restore onto two fresh volumes, and the restored pair recalls a memory saved before the backup. | not run |

Checks 1 to 12 are the hand checks and the Codex checks. D1 to D4 are deployment checks. None of them has been run
yet, and the automated suite only runs fakes of Discord, Codex, asphodel and an OAuth MCP server.

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
2. chad opens a thread on that message and answers in it. Within a few seconds the thread's name changes from the
   message's text to a short title the model wrote.
3. In that thread, send a message with no mention, such as "and times 3?".
4. Copy the text channel's id, run `chad channel add discord <channel-id>`, and send a message with no mention in the
   text channel. chad opens a thread on it and answers there.
5. Run `chad channel remove discord <channel-id>` and send another message with no mention in the text channel.

Passes when chad answers the second message in the thread and the message of step 4, and ignores the message of step 5.
If the thread keeps the message's text as its name, `chad logs` has a `thread.untitled` line with the reason. If it
answers the first and ignores the second, the message content intent is off. If no thread opens, the bot lacks Create
Public Threads in that channel. The invite asks for View Channel, Send Messages, Send Messages in Threads, Create
Public Threads, Read Message History and Attach Files.

## 6. The other Codex models (optional)

1. Run `chad model --subagent openai/gpt-6.1-sol/medium`.
2. Ask chad for something it hands to a sub-agent, such as "use a sub-agent to list three facts about Wellington".
3. Run `chad model --subagent none` afterwards, or keep it.

Passes when the turn answers with no model error. `gpt-6.1-terra` and `gpt-6-luna` can be tried the same way, at
efforts `low` and `medium`. A refused model fails the turn with `model_not_found`.

## 7. Fast mode (optional)

1. Run `chad model --fast on`.
2. Send chad a direct message.
3. Run `chad model --fast off` afterwards, or keep it.

Passes when step 1 prints that fast mode is on and the turn answers with no model error. A login or a model that does
not serve the tier fails step 1 with the trial's error and leaves fast mode off.

## 8. Slash commands

1. In the DM, type `/`. Discord lists `new`, `stop`, `status`, `model` and `safe` under chad's name. A list that was
   just set can take a minute to show.
2. Run `/status`. Only you see `Running /status.`, and the status follows in the DM.
3. Send a message that takes a while, as in check 4, and run `/stop` while it works.
4. Run `/new`.

Passes when the turn in step 3 ends with a `Stopped after <time>.` line and step 4 posts `New session started.`. A
command that Discord answers with "The application did not respond" failed.

## 9. A secret through a form

1. In the DM, send "Ask me for a secret named LIVE_CHECK with requestSecret, then stop".
2. chad posts a message that names `LIVE_CHECK` with an `Enter LIVE_CHECK` button. Click it.
3. A form titled "Save a secret" opens. Type `live-check-value` as the value and submit.
4. Run `chad secret list`, then `chad logs | grep live-check-value` and `chad secret rm LIVE_CHECK`.

Passes when the original request changes to `Saved LIVE_CHECK` as subtext and its button disappears, `chad secret list` lists `LIVE_CHECK`, the grep prints nothing,
and no message in the DM shows the value.

## 10. OAuth sign-in to an MCP server that registers chad itself

Use a hosted MCP server whose authorization server registers clients by itself, and on which you have an account. Linear's
is one: `https://mcp.linear.app/mcp`.

1. In `work/mcp.json` in the repo, add `"linear": { "url": "https://mcp.linear.app/mcp", "oauth": {} }` under
   `mcpServers`, and run `chad apply -m "Add linear"`. The apply prints `MCP server linear: needs login.` and does not
   wait. `chad status` shows `mcp: linear, needs login`.
2. In the DM, send "Sign me in to the linear MCP server with requestMcpLogin, then stop".
3. chad posts a `Sign in to linear` button. Click it. chad posts the steps with an `Open the sign-in` link button and a
   `Paste the address` button. When the link is longer than a Discord button takes, it is in the message instead.
4. Open the link and approve. The browser goes to `http://localhost/oauth/callback?code=...`, which does not load. Copy
   the whole address from the address bar.
5. Click `Paste the address`, put the address in the form and submit.
6. In the DM, ask for something only the server knows, such as "List my Linear teams".
7. Run `docker restart chad`, then `chad status`, then ask again.
8. Run `chad logs | grep -c -F '<code>'` with the value of `code` from the address you pasted, and
   `chad mcp logout linear`.

Passes when the DM gets `Signed in to "linear".` and `MCP server linear: connected` as subtext, steps 6 and 7 answer from
the server, `chad status` after the restart shows `mcp: linear, connected` with no new sign-in, the grep prints `0`,
no message in the DM shows the address you pasted, and the logout prints `MCP server linear: needs login.`. Leave it
signed in for a day before the logout if you can: a call after the access token has run out shows that the refresh
works on the real server.

## 11. OAuth sign-in with a client you registered

Use a server you can register an OAuth client with, such as a Slack app for `https://mcp.slack.com/mcp`. Register the
client with a redirect URL of your own, for example `https://chad.example.com/oauth/callback`. Nothing has to answer
at it.

1. Save the client's id and secret, each with `chad secret set`: `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`.
2. In `work/mcp.json`, add the server with
   `"oauth": { "clientId": "${SLACK_CLIENT_ID}", "clientSecret": "${SLACK_CLIENT_SECRET}", "redirectUrl": "https://chad.example.com/oauth/callback", "scopes": ["channels:read", "chat:write"] }`
   and apply it. The apply prints that the server needs login.
3. Run `docker exec -it chad chad mcp login slack`. It prints a link. Check that the link's `client_id`,
   `redirect_uri` and `scope` are the values you wrote.
4. Open the link and approve. Copy the address the browser ends on, paste it at the prompt, which shows nothing, and
   press Enter.
5. Run `chad logs | grep -c -F '<secret>'` with the client secret, typed in a shell whose history you do not keep.

Passes when step 4 prints `Signed in to "slack".` and `MCP server slack: connected`, the app's page on the server lists
no second client, a turn in the DM can call one of the server's tools, and the grep prints `0`.

## 12. A one-off value through a form

Pick a fresh value that appears nowhere else, such as a few random words. It goes only into the form, never into a
message or a command.

1. In the DM, send "Ask me for a one-off value named LIVE_ONCE with requestOnce, then run
   `chad secret run --env V=LIVE_ONCE -- sh -c 'test -n "$V" && echo got-a-value'` and tell me what it printed".
2. chad posts a message that names `LIVE_ONCE` with an `Enter LIVE_ONCE` button, and the turn keeps running. Click it.
3. A form titled "Enter a one-off value" opens, with one field. Type your fresh value and submit.
4. Once the turn has ended, run `chad secret list`, then `chad logs | grep -c -F '<value>'` with your value, typed in
   a shell whose history you do not keep.

Passes when the request changes to `Got LIVE_ONCE` and its button disappears, chad's answer says the command printed
`got-a-value`, `chad secret list` does not list `LIVE_ONCE`, the grep prints `0`, and no message in the DM shows your
value.

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

1. Start asphodel and save its token in chad as `docs/running.md` says under "asphodel". Then open
   `http://127.0.0.1:7720/dashboard` on the host, choose an LLM (an OpenAI-compatible endpoint with its key, or a
   ChatGPT subscription and its login) and click Finish setup.
2. Turn the plugin on in `/data/repo/work/chad.json`. On a fresh volume the file is `{ "plugins": {} }`, and
   `docker exec chad cat /data/repo/work/chad.json` shows what it holds now. Keep any plugin already in it, and add
   `asphodel` under `plugins`:

   ```json
   {
     "plugins": {
       "asphodel": {
         "enabled": true,
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

3. Run `chad apply -m "Turn asphodel on"`. It prints `Applied <commit>.`, a settings line that ends with
   `token (${ASPHODEL_TOKEN} from the secret store)`, and `Rebuilt: asphodel.`, and `chad log` lists the commit.
4. Send chad two direct messages, then ask "what do you remember about me?".
5. Run `chad logs` and look for lines from the plugin `asphodel`.
6. Run `docker exec asphodel asphodel bank list`.

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
