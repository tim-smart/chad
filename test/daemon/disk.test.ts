import { Effect } from "effect"
import { ChatError } from "effect/chat"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { execute } from "../support/database.ts"
import { owner, scenario } from "../support/driver.ts"
import { posted, prompted, says } from "../support/owner.ts"

// No test can make the daemon's own connection hit a page cap, so a trigger fails the save with SQLite's full text.
const full =
  "CREATE TRIGGER full BEFORE INSERT ON cluster_messages BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"

test("a message the full volume cannot save is answered in the thread and accepted, refused when the answer cannot be posted either, and never runs later by itself", async () => {
  const chad = await scenario()
  await chad.fakes.model.script([{ text: "there is space again" }])
  await chad.logged("boot.ready")
  execute(chad.data, full)
  const thread = await chad.fakes.chat.makeThread("direct")
  await says(chad, thread, "hello")
  expect(await posted(chad, thread)).toEqual([Messages.diskFull])
  await chad.logged("disk.full")

  await Effect.runPromise(
    chad.chat.failNext("post", new ChatError.Forbidden({ detail: "down" })),
  )
  const refused = await chad.fakes.chat.userPosts(thread, {
    text: "again",
    authorId: owner,
  })
  expect(await chad.fakes.chat.deliver(refused)).toBe(false)

  execute(chad.data, "DROP TRIGGER full")
  await says(chad, thread, "now")
  await chad.fakes.chat.answers(thread, 2)
  const calls = await chad.fakes.model.calls()
  expect(calls).toHaveLength(1)
  expect(prompted(calls[0])).toContain("now")
  expect(prompted(calls[0])).not.toContain("hello")
})
