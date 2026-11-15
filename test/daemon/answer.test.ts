import { Effect } from "effect"
import { ChatError } from "effect/chat"
import { expect, test } from "vitest"
import * as Format from "../../dist/daemon/Format.js"
import * as Messages from "../../dist/Messages.js"
import * as Failed from "../../dist/daemon/Failed.js"
import { scenario } from "../support/driver.ts"
import { lines, rows, says } from "../support/owner.ts"

test("DIS-55 FAIL-66 DIS-100 in a server thread the answer replies to the owner's message, and a failed-turn message whose owner's message is gone goes out as a plain post", async () => {
  const running = await scenario()
  const { fakes, chat } = running
  await fakes.model.script([{ status: 400, hold: true }, { text: "answered" }])
  const thread = await fakes.chat.makeThread("thread")
  await says(running, thread, "hello", { mention: true })
  await fakes.model.received(1)
  // The failed-turn message replies to a message that the platform no longer has.
  await Effect.runPromise(
    chat.failNext(
      "post",
      new ChatError.NotFound({ detail: "message_not_found" }),
    ),
  )
  await fakes.model.release(0)
  const [failed] = await fakes.chat.answers(thread, 1)
  const [line] = await lines(running, "turn.failed", 1)
  const reason = Failed.fromRow(
    "ModelError",
    String(
      rows(running, "SELECT failure_detail FROM turns")[0]?.["failure_detail"],
    ),
  )
  if (reason._tag !== "ModelError") throw new Error("not a ModelError")
  expect(failed!.text).toBe(
    Messages.failedTurn(
      Format.local,
      Number(line!.annotations["duration_ms"]),
      reason,
      String(line!.annotations["turn"]),
    ),
  )
  expect(failed!.replyTo).toBeUndefined()

  const again = await says(running, thread, "again")
  const [, answer] = await fakes.chat.answers(thread, 2)
  expect(answer!.text).toBe("answered")
  if (again.message === undefined) throw new Error("no message")
  expect(answer!.replyTo?.messageId).toBe(again.message.id)
})
