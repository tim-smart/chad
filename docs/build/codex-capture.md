# Recording the Codex side

This is the procedure for the first Codex recording of TST-43, made with the recorder of TST-216. It is the builder's note, not spec. Tim runs it once, on his own machine, with his own Codex login. No test and no CI job runs the recorder on a real login. The gate runs it against the fake model server only (`test/unit/record-codex.test.ts`).

## What it does

The recorder logs in with the device flow, the way `chad login` does. It holds the token in memory and never writes it to disk, and it neither reads nor touches chad's `secrets/auth/`. Then it drives clanka's Codex model the way chad builds it (`src/ModelSpec.ts`), through these flows:

| Flow                                          | What it records                                                                                 | Why                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `login`                                       | The device code, its poll and the token exchange                                                | TST-39: the login flow, and a login in the middle of a turn, which makes the same exchanges |
| `answer`, `answer-http`                       | One call that answers with text, over the socket and over HTTP                                  | TST-39. The socket's opening headers show the `session-id` header                           |
| `tool-call`                                   | A call that calls clanka's `execute` tool, then the call that carries its result, on one socket | TST-39: one sub-agent, and a resumed turn, which send the same calls                        |
| `stop`                                        | A call stopped at its first text, then the next call on the same model                          | TST-39: Stop during a streaming response                                                    |
| `reconnect`                                   | A call, a 65 second wait while the socket idles out, then a call on a new socket                | TST-39: the socket idling out and reconnecting                                              |
| `refresh`                                     | A call after the stored access token is marked expired, so the login refreshes it first         | TST-39: the order of the token check                                                        |
| `refused-model`, `refused-model-http`         | A model a ChatGPT login does not accept (`gpt-4.1` unless you pass another)                     | TST-40                                                                                      |
| `max-output-tokens`, `max-output-tokens-http` | A call with `max_output_tokens`                                                                 | TST-40, and the reason compaction runs with no output cap                                   |
| `expired-token`, `expired-token-http`         | A call with an access token the service did not issue                                           | TST-40 (see below)                                                                          |

Every HTTP exchange and every socket frame goes into the recording. The whole thing is passed through the stripper in `test/support/recording.ts` before anything is written. If a token, the account id or a code of the login is still in the result, the recorder writes nothing. It prints where the secret was left (a path in the JSON, never the value) and exits with 1.

## Running it

You need the repo at the branch the builder names, and a Codex login that is not at its usage limit. The run takes about two minutes after you approve the code, most of it the 65 second wait.

```sh
nix develop -c pnpm install
nix develop -c pnpm build
nix develop -c node scripts/record-codex.ts
```

It prints a link and a code. Open the link, sign in to the ChatGPT account chad will use, and enter the code. It then prints one line per flow and `Wrote <file>`.

The output goes to `test/unit/fixtures/codex-recording.json`. The options are:

- `--out <file>` writes somewhere else.
- `--model <setting>` records on another model. The default is chad's own, `openai/gpt-6-astra/medium`.
- `--refused-model <model>` picks the model the `refused-model` flow sends. Use it if `gpt-4.1` ever becomes accepted.

## Before you commit it

1. The run ended with `Wrote …` and exit code 0. If it printed `Not written: a secret is left after stripping, at …`, nothing was written. Send the builder the paths it printed, and don't edit the stripper or the file by hand to get past it.
2. Read the flow lines. An answer flow should say `answered` and a refusal flow `refused: …`. Two other outcomes matter:
   - A refusal flow that says `answered, which the fake refuses` means the real service accepted something the fake refuses (TST-40). The file is still worth committing. Tell the builder which flow it was.
   - An answer flow that says `failed: …`. Run the recorder once more. If it fails again, commit what you have and tell the builder which flow failed.
3. Search the file for anything personal. The repo is public. Each of these must print nothing:

   ```sh
   rg -n 'eyJ' test/unit/fixtures/codex-recording.json
   rg -n -i '<your email>' test/unit/fixtures/codex-recording.json
   rg -n '<your ChatGPT account id>' test/unit/fixtures/codex-recording.json
   ```

   Every `authorization`, `chatgpt-account-id`, `cookie`, `set-cookie`, `access_token`, `refresh_token`, `id_token`, `user_code`, `device_auth_id`, `authorization_code` and `code_verifier` value should read `<stripped>`. Skim the response headers of one exchange too. If a header holds something you would rather not publish, tell the builder and don't commit.

4. Commit that one file and nothing else:

   ```sh
   git add test/unit/fixtures/codex-recording.json
   git commit -m "Record the Codex side on Tim's login"
   ```

## What it can't provoke

- The usage limit. The service sends it only when the login is at its limit, so the first run lists `usage-limit` under `missing` in the file and prints `Not provoked: usage-limit`. That is expected. When your login next hits its limit, run:

  ```sh
  nix develop -c node scripts/record-codex.ts --usage-limit
  ```

  It logs in again, sends one call over the socket and one over HTTP, adds the limit's frame to the same file as `refusal`, and drops it from `missing`. Check and commit it the same way. If the limit never comes, the builder keeps the hand-made usage-limit frame and says so. If your login is at its limit during the first run, the answer flows fail but the frame is kept. Run the first run again once the limit resets.

- An expired token. The service reads a token's expiry from the token itself, and clanka refreshes a token it knows has expired before it sends it. So the recorder sends your real token with its signature replaced, along with your real account id. If the service answers a forged token differently from an expired one, the recording has the forged token's answer. The builder notes that against TST-40.
- The server closing an idle socket. The `reconnect` flow records the client's own idle-out after 60 seconds, which is what a chat meets between turns. A close by the server after a longer time is not recorded.
- A retry after a transient error. It can't be caused on demand. The frames a retry sees are an error and then a normal answer.
- A kill and resume, an Agent rebuild, compaction. These differ only on chad's side. Their calls have the shapes of `answer` and `tool-call`, and compaction's refusal is `max-output-tokens`.

## What the builder does afterwards

1. Replace the hand-made frames with the recording: `git mv -f test/unit/fixtures/codex-recording.json test/unit/fixtures/codex-frames.json`. If the recording has no `refusal` yet, copy the hand-made one across and say so in `source`.
2. Run the comparison:

   ```sh
   TZ=Pacific/Auckland nix develop -c pnpm exec vitest run test/unit/recording.test.ts
   ```

   It checks that the kept recording has nothing left to strip, and that the fake's answer and usage-limit frames have the recording's shape (TST-41).

3. Where a shape differs, change the fake's Codex side in `test/support/model.ts` (`responses`, `refusalFrame`, `refused`, the login endpoints, the socket) to match the recording. Never change the recording to match the fake.
4. Go through the flows the comparison does not cover by hand: `login`, `refresh`, `tool-call`, `stop`, `reconnect` and the refusals. Anything the fake plays differently gets fixed in the fake, with a test where TST-173 asks for one.
5. Run the full `pnpm test`, because every Codex scenario runs on the fake's frames. Then mark TST-41 and TST-43 built in `docs/build/models.md`.
