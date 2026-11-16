# Live checks

These checks run chad against a real Discord, a real Codex login and a real deployment. No test in the repository does
any of them, because no job holds a Discord token, a Codex login or access to your server. Do each one by hand, once,
on the image you run. Each step says what you should see. You need nothing outside this file and `docs/running.md`.

Record what you saw in the stage 5 hand-off comment on the build issue, or in a comment on the pull request after it.
A check with no recorded result has not run.

## Status

| Check                                                        | What it confirms                                                                                                       | Result  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------- |
| 1. `chad setup` on a real bot                                | Setup turns the message content intent on, or says where to click. The invite gives the bot what it needs in a server. | not run |
| 2. A direct message                                          | chad answers you in a DM.                                                                                              | not run |
| 3. Stop                                                      | The Stop button on the status message stops a turn.                                                                    | not run |
| 4. A mention in a server channel, then a message without one | A mention opens a thread, and chad reads a message in that thread that does not mention it.                            | not run |
| 5. Codex login in a thread                                   | A turn that needs a login posts the code, and finishes once you approve it.                                            | not run |
| 6. The other Codex models (optional)                         | The sub-agent runs on `gpt-6.1-sol`, `gpt-6.1-terra` or `gpt-6-luna` on your login.                                    | not run |
| D1. Publish the image                                        | The image builds and pushes to `ghcr.io/tim-smart/chad`.                                                               | not run |
| D2. The volume's filesystem                                  | The volume's filesystem is one chad's lock and SQLite are safe on.                                                     | not run |
| D3. asphodel for real                                        | The asphodel plugin talks to a real asphodel daemon with its token.                                                    | not run |
| D4. Backup and restore                                       | A chad backup and an asphodel backup restore onto a fresh volume.                                                      | not run |

Checks 1 to 6 are the hand checks and the Codex check. D1 to D4 are deployment checks. None of them has been run
by the builder, and the automated suite only runs fakes of Discord, Codex and asphodel.

## Before you start

- A running chad from `docs/running.md`, "Docker". Commands below are written `chad <command>`, so run each one as
  `docker exec -it chad chad <command>`.
- A Discord application with a bot, made at https://discord.com/developers/applications, and its bot token. Leave
  "Message Content Intent" off for now, so check 1 can show what setup does about it.
- A Discord server you own, with one ordinary text channel.
- Your own Discord user id. Turn on Developer Mode in Discord's settings, then right-click your name and pick "Copy User
  ID".
- chad not logged in to Codex. Answer no to the login question in check 1, or run `chad logout` before check 5.

## 1. `chad setup` on a real bot

1. Run `chad setup`. Paste the bot token, give your user id and your timezone, and answer no to "Log chad in to Codex
   now?".
2. Setup prints `The token is the bot <name>'s.` with your bot's name, and an `invite: <url>` line.
3. It then prints one of these:
   - `Message Content Intent turned on for the bot.`
   - `Message Content Intent is on for the bot.`
   - `Turn on Message Content Intent under Privileged Gateway Intents at <link> ...`. Open the link, turn it on and
     save.
4. Open the invite URL and add the bot to your server.

Passes when the developer portal shows Message Content Intent on, and the bot is in your server. Record which of the
three lines setup printed. The third is the expected one if Discord does not let a bot change its own intents.

## 2. A direct message

Send the bot a direct message, such as "what time is it?".

Passes when chad answers in the DM. While it works, a status message shows the turn's actions and a Stop button.

## 3. Stop

Send a message that takes a while, such as "count slowly to 60 in a script, printing each number". While the status
message is up, click Stop.

Passes when the turn ends with a `Stopped after <time>.` line, and chad answers your next message as usual.

## 4. A mention in a server channel, then a message without one

1. In the text channel, send a message that mentions the bot, such as "@chad what's 2+2?".
2. chad opens a thread on that message and answers in it.
3. In that thread, send a message with no mention, such as "and times 3?".

Passes when chad answers the second message in the thread. If it answers the first and ignores the second, the message
content intent is off. If no thread opens, the bot lacks Create Public Threads in that channel. The invite asks for
View Channel, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History and Attach Files.

## 5. Codex login in a thread

1. Run `chad logout`, which prints `chad is logged out of Codex.`
2. Check the model is on Codex: `chad model` should name an `openai/...` model, such as `openai/gpt-6-astra/medium`,
   and chad's environment should have no OpenAI API key.
3. Send chad a direct message.
4. The thread gets `To log chad in to Codex, open <url> and enter the code <code>. The code is good for 15 minutes.`
5. Open the URL, sign in with your ChatGPT account and enter the code.

Passes when the answer to your message arrives in the same thread, with no second message from you. `chad login`
then prints `chad is already logged in to Codex. ...`.

If you ever hit a usage limit on your login, keep the turn's `chad logs` lines. Nobody has seen a real usage-limit
frame yet, and that log shows what the service sends.

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

1. Start asphodel and save its token as `docs/running.md` says under "asphodel", and finish its first-run setup.
2. Copy the fixture into chad's repo as `plugins/asphodel.ts`:
   `docker cp test/fixtures/asphodel/asphodel.ts chad:/data/repo/plugins/asphodel.ts`.
3. Add the plugin to `/data/repo/chad.json`:

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

4. Run `chad apply`. It should commit and load the plugin.
5. Send chad two direct messages, then ask "what do you remember about me?".
6. Run `chad logs` and look for lines from the plugin `asphodel`.

Passes when the apply loads the plugin, `chad logs` shows no `asphodel` error, and asphodel's dashboard shows the
turns ingested into the bank `chad`. A `401` in the log means the token chad holds is not asphodel's.

The asphodel image tag in `docs/running.md` is `latest`. Pin it to the version you tested once this passes.

## D4. Backup and restore

1. Take both backups as `docs/running.md` says under "Backup".
2. Restore chad's tar onto a new volume as it says under "Restore", and start chad on it.
3. Send chad a direct message.

Passes when chad answers, `chad status` shows the same connection and owner, and `chad secret list` shows the
secrets you had. Restoring asphodel's `backup.db` follows asphodel's own README.
