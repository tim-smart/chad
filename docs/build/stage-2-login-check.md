# The Codex check, for Tim

This is the one Codex check that is left (TST-145, TST-147), as Tim ruled in chat on 2026-11-15. It is one turn on your login, on the image you run on your own server, and you can do it at any time from the first usable build on (ORD-22). The builder's note, not spec. Each command below is checked against `chad --help` and `docs/spec/10-cli.md` at the commit that adds this file.

It is the only check of the Codex path: the device login, the token store and the WebSocket at chatgpt.com. The builder's runs against the proxy go through chad's `openai` path over HTTP and touch none of those (`docs/build/codex-capture.md`).

## The steps

1. Build the image from `chad-v1`, with Docker or podman:

   ```sh
   git clone --branch chad-v1 https://github.com/tim-smart/chad.git && cd chad
   docker build -t chad .
   ```

2. Start it on a volume, with `CHAD_MODEL` set to a model on the Codex login and no key. `openai/<model>` with no `CHAD_OPENAI_API_KEY` is the Codex path (`src/ModelSpec.ts`). With a key it is the `openai` path, and the check would prove nothing.

   ```sh
   docker run -d --name chad -v chad:/data -e CHAD_MODEL=openai/gpt-6-astra/medium chad
   docker exec chad chad health
   ```

   Don't pass `-e CHAD_OPENAI_API_KEY` or `-e CHAD_OPENAI_API_URL`.

3. Add the Discord connection. The command asks for the bot token at a hidden prompt. `--token-file <path>` reads it from a file inside the container. It checks the token, then prints the invite URL and the privileged intents the bot needs.

   ```sh
   docker exec -it chad chad connection add discord
   ```

   Open the invite URL to add the bot to your server, and turn on each privileged intent it names in the Discord developer portal.

4. Make yourself the owner, with your Discord user id. The connection is named `discord` unless you passed `--name`. A change applies at once, with no restart (CLI-120).

   ```sh
   docker exec -it chad chad owner add discord <your Discord user id>
   ```

5. Check the model line before you send anything:

   ```sh
   docker exec chad chad status
   ```

   It should read `model: openai/gpt-6-astra/medium (not logged in)`. `needs no login` means a key is set, so stop and start the container again without it. `logged in` means the volume already holds a login. Run `docker exec -it chad chad logout` first, so that the turn has to log in.

6. Send chad a message, either a direct message or a mention in a server channel, which opens a thread.
7. The device code appears in that thread: "To log chad in to Codex, open <url> and enter the code <code>. The code is good for 15 minutes." The status message shows "Waiting for login".
8. Open the URL, sign in to the ChatGPT account chad should use, and enter the code.
9. The same turn carries on, and the answer arrives in that thread. That is the pass mark (TST-147). `chad status` now reads `(logged in)`.

The result goes in the stage 5 hand-off comment, whenever you ran it (TST-151). Tell the builder or the Architect what you saw.

## If it fails

Read the log from inside the container. `--since 30m` keeps it short, and `--json` prints the stored lines in full.

```sh
docker exec chad chad logs --since 30m --level warn
docker exec chad chad logs --since 30m --event turn
docker exec chad chad status
```

| What you see                                                    | Where to look                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No reply and no code at all                                     | `--event message` for `message.ignored`. Its reason `not-owner` means the author id is not on the owner list. `--event chat` for `chat.connected`, or for `chat.refused`, which names a missing privileged intent.                                                                                         |
| `chad is not logged in to Codex.` in the thread                 | chad could not post a code there. Check the status line and `--event turn`.                                                                                                                                                                                                                                |
| The code, then "Login timed out. Send a message to try again."  | The code was not entered within 15 minutes. Send another message.                                                                                                                                                                                                                                          |
| The code, then "Login failed (…). Send a message to try again." | `--event turn` for the `turn.failed` line and its reason.                                                                                                                                                                                                                                                  |
| You approved the code, but the turn fails or never answers      | `--event turn` for `turn.login-wait`, `turn.retry` and `turn.failed`. `chad logs --turn <id> --json` gives the whole turn, and the `turn.failed` line carries the cause the call ended with. A frame the real service sends and the fake does not shows up here, and the builder brings the fake up to it. |
| A model warning at start                                        | `--event model` for `model.check-failed`.                                                                                                                                                                                                                                                                  |
