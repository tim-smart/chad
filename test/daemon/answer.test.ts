import { expect, test } from "vitest"
import * as Format from "../../dist/daemon/Format.js"
import * as Messages from "../../dist/Messages.js"
import * as Failed from "../../dist/daemon/Failed.js"
import { scenario } from "../support/driver.ts"
import { lines, rows, says } from "../support/owner.ts"

test("a failed turn posts its reason in the server thread", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ status: 400 }])
  const thread = await fakes.chat.makeThread("thread")
  await says(running, thread, "hello", { mention: true })
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
})
