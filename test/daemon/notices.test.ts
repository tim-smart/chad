import { readFileSync } from "node:fs"
import { ChatThread } from "effect/chat"
import { expect, test } from "vitest"
import { scenario } from "../support/driver.ts"
import { says, sessions } from "../support/owner.ts"

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

test("FAIL-231 REC-101 a direct message that only a command reached stays the destination after a restart while the owner writes in a server thread", async () => {
  const first = await scenario()
  const direct = await first.fakes.chat.makeThread("direct")
  await says(first, direct, "/status")
  await first.fakes.chat.answers(direct, 1)
  expect(destination(first.data)).toEqual(at(direct))
  // A command opens no session, so no row says that the thread is a direct message.
  expect(sessions(first)).toEqual([])
  expect(await first.stop()).toBe(0)

  // The platform starts again with the same direct message, which its first thread is.
  const second = await scenario({ directory: first.directory })
  expect(await second.fakes.chat.makeThread("direct")).toEqual(direct)
  const server = await second.fakes.chat.makeThread("thread")
  await says(second, server, "/status", { mention: true })
  await second.fakes.chat.answers(server, 1)
  expect(destination(second.data)).toEqual(at(direct))
  expect(await second.stop()).toBe(0)
})

test("FAIL-231 REC-101 FAIL-341 a direct message that only a command reached stays the destination after a restart while the platform is slow to say what it is and the owner writes in a server thread", async () => {
  const first = await scenario()
  const direct = await first.fakes.chat.makeThread("direct")
  await says(first, direct, "/status")
  await first.fakes.chat.answers(direct, 1)
  expect(sessions(first)).toEqual([])
  expect(await first.stop()).toBe(0)

  const second = await scenario({ directory: first.directory })
  expect(await second.fakes.chat.makeThread("direct")).toEqual(direct)
  const server = await second.fakes.chat.makeThread("thread")
  // The lookup of the restored destination's kind does not answer before the owner's message stops waiting for it.
  const held = second.holdThreads()
  await says(second, server, "/status", { mention: true })
  await second.fakes.chat.answers(server, 1)
  expect(destination(second.data)).toEqual(at(direct))
  held.release()
  await says(second, server, "/status", { mention: true })
  await second.fakes.chat.answers(server, 2)
  expect(destination(second.data)).toEqual(at(direct))
  expect(await second.stop()).toBe(0)
})
