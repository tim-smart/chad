import { expect, it } from "vitest"
import { refusalFrame, responses } from "../support/model.ts"
import { load, shape, shapes, strip, stripped } from "../support/recording.ts"

it("TST-41 the kept recording of the Codex side holds no token and no account id", () => {
  const recording = load()
  expect(strip(recording)).toEqual(recording)
  // The stripper finds what a real recording holds: a JWT anywhere, the fields that name the login, and the fields of a
  // response that name the caller, with the token counts that share a name with one of them kept.
  const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl"
  expect(
    strip({
      headers: {
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": "acct",
      },
      response: {
        text: `a ${token} b`,
        user_id: "user",
        instructions: "the caller's",
        prompt_cache_key: "session",
        access_programs: { program: "enrolled" },
        metadata: {},
        usage: { request_fields: { instructions: { input_tokens: 10 } } },
      },
    }),
  ).toEqual({
    headers: { Authorization: stripped, "ChatGPT-Account-Id": stripped },
    response: {
      text: `a ${stripped} b`,
      user_id: stripped,
      instructions: stripped,
      prompt_cache_key: stripped,
      access_programs: {},
      metadata: {},
      usage: { request_fields: { instructions: { input_tokens: 10 } } },
    },
  })
})

it("TST-41 TST-43 the fake's Codex frames have the shape of the kept recording's, for an answer on each transport and for a usage limit", () => {
  const recording = load()
  const answer = shapes(responses(0, { text: "Hello" }, "gpt-6-astra"))
  expect(answer).toEqual(shapes(recording.answer.http))
  expect(answer).toEqual(shapes(recording.answer.socket))
  expect(
    shape(
      refusalFrame({
        status: 429,
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          resets_at: 1_900_000_000,
        },
      }),
    ),
  ).toEqual(shape(recording.refusal))
})
