# Recording the Codex frames

This is the builder's record of how the one recording of TST-43 was made, and of how to make it again. It is not spec. The builder made it on 2026-11-16, in the follow-up to the `models` slice, under Tim's ruling in chat of 2026-11-15. It used the OpenAI endpoint and key of the builder's own environment. No test and no job on the gate reads that key. The gate runs the recorder against the fake model server only (`test/unit/record-codex.test.ts`), with one of the fake's own tokens as the key, and the suite passes with both variables unset.

## What was recorded

`scripts/record-codex.ts` reads the endpoint from `CLANKA_OPENAI_API_URL` and the key from `CLANKA_OPENAI_API_KEY`. The endpoint is a proxy that serves the Responses API. The script makes two calls, each on `gpt-6-astra` with the prompt "Say hello." and one line of instructions:

| Transport          | The call                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Server-sent events | `POST <url>/responses` with `stream: true`                                                                                           |
| WebSocket          | A socket opened on `<url>/responses` with the key in the opening request's `authorization` header, and one `response.create` message |

Each call answered. Both transports gave the same nine event types with the same keys: `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta` (twice), `response.output_text.done`, `response.content_part.done`, `response.output_item.done` and `response.completed`.

What the hand-made frames lacked, and the fake now sends:

- `sequence_number` on every event. The recording skips one number. The fake counts from 0 without a gap.
- `logprobs` and `obfuscation` on the delta, and `logprobs` on each text part and on `response.output_text.done`.
- `phase` on the message item.
- The response's other keys, about thirty of them. They are the same on `response.created`, `response.in_progress` and `response.completed`, where `usage` and `completed_at` are `null` until the last. Among them are a `tools` list and a `tool_usage` object for an image tool that the proxy adds to a call that sent no tools.
- `usage`: `cache_write_tokens` and its `ttl_12h_tokens` and `ttl_30m_tokens` under `input_tokens_details`, and an `attribution` object. `attribution.items` is keyed by item id, one entry for the input message and one for the answer, and `attribution.request_fields` counts the tokens of the tools and the instructions.

clanka decodes the reshaped frames. Every Codex scenario of the suite passes on them.

## What it does not show

- The recording is what the proxy relays over the `openai` path. It is not shown to be what `chatgpt.com/backend-api/codex` sends to chad directly.
- A run through the proxy goes through chad's `openai` path, which is `Codex.model` over HTTP with a key (`src/ModelSpec.ts`). It never touches the Codex login, the token store or the WebSocket transport at chatgpt.com. It does send the `session-id` header and `prompt_cache_key`, as chad does on `openai` with a key (MOD-96, `src/ModelSpec.ts`), so the header is not what tells the two paths apart. Nothing here is evidence for a rule about that path. Tim's one Codex check is what covers it (TST-147, `docs/build/stage-2-login-check.md`).
- The opening request's headers are chad's own. They come from chad's Codex path against the fake, not from this recording.

## What stays hand-made

- The usage-limit frame under `refusal` in `test/unit/fixtures/codex-frames.json`. Nobody has recorded one, so it is written from the error schema clanka decodes (TST-41). The proxy cannot produce a usage limit on demand, and an error that passes through it may not be the frame chatgpt.com sends.
- What a new connection gets while a limit is in force. In the fake it is a socket that opens and answers `response.create` with that frame.
- A tool call. The recorder made no call with tools. The fake's `function_call` events follow the pattern of the recorded answer.
- A failed response. The fake's `failed` reply sends `response.created`, `response.in_progress` and `response.failed` with the response's `error`, following the pattern of the recorded answer.

The fixture's `source` line says the same. No later capture or comparison is planned. The first real limit on Tim's login is what shows the real frame, and `chad logs` holds a frame that fails a turn.

## What is stripped

The recorder writes the fixture only through `keep` in `test/support/recording.ts`, which runs `strip` and then `renumber`:

- `strip` replaces every JWT, and the value of each field the stripper names, wherever it is. The fields are the login's tokens and codes, the account and user ids, `email`, cookies, `safety_identifier`, `user`, `prompt_cache_key`, `metadata`, `access_programs` and `instructions` where it is text. A string becomes `<stripped>`, an object `{}`, a list `[]` and a number 0, so the frame keeps its shape. `null` stays `null`. The `instructions` entry of `usage.attribution.request_fields` holds token counts and is kept.
- `renumber` gives each id the service made, such as `resp_…` and `msg_…`, the next number of its prefix (`resp_0`, `msg_0`, `msg_1`), as the fake numbers its own. An id names one call in the service's logs.
- No response header is recorded.

Before it writes, the recorder looks for the key, the endpoint and each part of its host or path longer than four characters, and for anything `strip` should have replaced. If one is left it writes nothing and prints only the path in the JSON where it was found.

## Making it again

1. Use a runtime whose `CLANKA_OPENAI_API_URL` and `CLANKA_OPENAI_API_KEY` are set. Never print either, and keep both out of the repository, the logs and any comment.
2. Run it, with the raw copy outside the repository:

   ```sh
   nix develop -c pnpm build
   nix develop -c node scripts/record-codex.ts --raw ../raw-capture/raw.json > ../raw-capture/run.txt 2>&1
   ```

   It prints how each call ended and where a secret was left, never a value. `--model <model>` records on another model. `--raw` refuses a path inside the repository.

   A call that cannot be made, or a step that fails, prints one line on stderr that names only what failed, such as "the endpoint URL could not be parsed", "the HTTP request failed" or "the HTTP response could not be read", with the status where there is one. A call that is made but not answered is reported in the outcome, such as a status or "the WebSocket closed before an answer" with its close code. The error under a failure is never printed, because its message or cause can hold the endpoint or its host, and so is an error outside the awaited calls, such as a socket's. A run that fails exits 1. It writes the fixture only after stripping succeeded with nothing left over, so a failure before that leaves the fixture as it was; if writing the fixture itself fails, check `git diff` on it. With `--raw`, the raw copy may already be written when a later step fails or a secret is left in the stripped result. It sits at the path you gave, outside the repository, so delete it as step 4 says. `test/unit/record-codex.test.ts` runs the script as a child process on a malformed and on an unreachable endpoint, with a synthetic key.

3. Check the fixture in code, so that no value is printed: it must not contain the key, the endpoint, the host or any part of the host longer than a common word. It must hold no JWT, and every field listed above must be blank. If another field names the account or the proxy, add it to `strip`. Then re-strip the raw copy without a second call:

   ```sh
   nix develop -c node scripts/strip-recording.ts ../raw-capture/raw.json
   ```

4. Read the stripped file. Then delete `../raw-capture/`.
5. Run `test/unit/recording.test.ts`. It compares the fake's frames with the recording's on each transport (TST-41). Where the shapes differ, change `responses` in `test/support/model.ts` to match. Never change the recording to match the fake. Then run the full `pnpm test` with both variables unset.
