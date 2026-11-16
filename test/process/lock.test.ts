// What only a daemon in a process of its own shows: the lock it keeps for the life of the process, and the local
// platform's redelivery of an event that a killed daemon never acknowledged.
import { renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { eventually, posted, says } from "../support/owner.ts"
import { daemon } from "../support/process.ts"

test("a daemon started with --expose-gc that forces a collection every 200 milliseconds keeps its lock, and a second daemon on the same volume is refused and exits 1", async () => {
  const running = await daemon({ gc: true })
  await running.start()
  await eventually(running.collections, (count) => count >= 3)
  const second = running.spawn({ gc: false })
  expect((await second.exit).code).toBe(1)
  expect(running.output()).toContain("event=boot.refused reason=lock")
}, 15_000)

test("a daemon whose state/daemon.lock is replaced under it fails chad health, and goes on answering, because it keeps the lock's handle", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([{ text: "still here" }])
  await running.start()
  expect((await running.chad(["health"])).code).toBe(0)
  const lock = join(running.data, "state/daemon.lock")
  writeFileSync(lock + ".new", "")
  renameSync(lock + ".new", lock)
  expect((await running.chad(["health"])).code).not.toBe(0)
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual(["still here"])
}, 15_000)

test("an event the killed daemon never acknowledged is delivered again to the next daemon, and answered once", async () => {
  const running = await daemon()
  const { fakes } = running
  await fakes.model.script([{ text: "answered once" }])
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  // The daemon is stopped dead, so the event reaches it and is never acknowledged.
  first.signal("SIGSTOP")
  const event = await fakes.chat.userPosts(thread, {
    text: "hello",
    authorId: "owner",
  })
  const delivered = fakes.chat.deliver(event)
  await first.kill()
  await running.start()
  expect(await delivered).toBe(true)
  await fakes.chat.answers(thread, 1)
  expect(await posted(running, thread)).toEqual(["answered once"])
}, 15_000)
