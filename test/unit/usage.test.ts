import { AiError } from "effect/ai"
import { expect, it } from "vitest"
import * as Failed from "../../src/daemon/Failed.ts"
import * as Format from "../../src/daemon/Format.ts"
import * as Messages from "../../src/Messages.ts"

it("a usage limit's reset time, which the HTTP body gives in epoch seconds and chad holds in milliseconds, is divided down to seconds in the Discord timestamp chad posts", () => {
  const seconds = 1_900_000_000
  // The error as effect's OpenAI client makes it from a 429 whose body names the usage limit.
  const error = AiError.make({
    module: "OpenAiClient",
    method: "streamText",
    reason: new AiError.RateLimitError({
      metadata: {
        openai: {
          errorType: "usage_limit_reached",
          errorCode: null,
          requestId: null,
        },
      },
      http: {
        body: JSON.stringify({
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            resets_at: seconds,
          },
        }),
      },
    }),
  })
  const reason = Failed.usageLimit(error)
  expect(reason).toEqual({ _tag: "UsageLimit", resetsAt: seconds * 1000 })
  const text = Messages.failedTurn(Format.discord, 1000, reason!, "turn")
  expect(text).toContain(`<t:${seconds}:R>`)
})
