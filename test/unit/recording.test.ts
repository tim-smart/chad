import { expect, it } from "vitest"
import { refusalFrame, responses } from "../support/model.ts"
import { load, shape, strip, stripped } from "../support/recording.ts"

it("TST-41 the kept recording of the Codex side holds no token and no account id", () => {
  const recording = load()
  expect(strip(recording)).toEqual(recording)
  // The stripper finds what a real recording holds: a JWT anywhere, and the fields that name the login.
  const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl"
  expect(
    strip({
      headers: {
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": "acct",
      },
      response: { instructions: `a ${token} b`, user_id: "user" },
    }),
  ).toEqual({
    headers: { Authorization: stripped, "ChatGPT-Account-Id": stripped },
    response: { instructions: `a ${stripped} b`, user_id: stripped },
  })
})

it("TST-41 TST-43 FAIL-98 the fake's Codex frames have the shape of the kept recording's, for an answer and for a usage limit", () => {
  const recording = load()
  expect(shape(responses(0, { text: "Hello" }, "gpt-6-astra"))).toEqual(
    shape(recording.answer),
  )
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
