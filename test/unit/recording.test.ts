import { expect, it } from "vitest"
import { load, strip, stripped } from "../support/recording.ts"

it("the kept recording of the Codex side holds no token and no account id", () => {
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
