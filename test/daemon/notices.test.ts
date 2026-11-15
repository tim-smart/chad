import { readFileSync } from "node:fs"
import { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import { scenario } from "../support/driver.ts"
import { says } from "../support/owner.ts"

/** What `state/notice-thread` holds, which must be one JSON line. */
const destination = (data: string) => {
  const [line, ...rest] = readFileSync(`${data}/state/notice-thread`, "utf8")
    .split("\n")
    .filter((part) => part !== "")
  expect(rest).toEqual([])
  return JSON.parse(line ?? "")
}

const at = (thread: ChatThread.ChatThread) => ({
  connection: "local",
  thread: ChatThread.toString(thread),
})

test("FAIL-158 FAIL-159 FAIL-231 REC-109 REC-145 a notice outside a turn goes where the owner's latest message arrived, a direct message before any other thread, in state/notice-thread", async () => {
  const first = await scenario()
  await first.fakes.model.script([
    { text: "one" },
    { text: "two" },
    { text: "three" },
  ])
  const server = await first.fakes.chat.makeThread("thread")
  await says(first, server, "hello", { mention: true })
  expect(destination(first.data)).toEqual(at(server))

  const direct = await first.fakes.chat.makeThread("direct")
  await says(first, direct, "hello")
  expect(destination(first.data)).toEqual(at(direct))
  // A chat command counts too, and a server thread does not take a direct message's place.
  await says(first, server, "/status")
  expect(destination(first.data)).toEqual(at(direct))
  const later = await first.fakes.chat.makeThread("direct")
  await says(first, later, "hello")
  expect(destination(first.data)).toEqual(at(later))
  await first.fakes.chat.answers(later, 1)
})
