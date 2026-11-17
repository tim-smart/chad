import { Effect } from "effect"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { scenario } from "../support/driver.ts"
import { lines, posted, rows, says, sessions } from "../support/owner.ts"

test("a stranger's direct message, mention, Stop click and each chat command start, stop, change and post nothing while an owner's turn runs", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "done", hold: true }])
  const direct = await fakes.chat.makeThread("direct")
  const channel = await fakes.chat.makeThread("channel")
  await says(running, direct, "do the thing")
  await fakes.model.received(1)
  const [status] = await fakes.chat.statuses()

  const stranger = async (
    thread: typeof direct,
    text: string,
    mentionsSelf = false,
  ) =>
    expect(
      await fakes.chat.deliver(
        await fakes.chat.userPosts(thread, {
          text,
          authorId: "mallory",
          mentionsSelf,
        }),
      ),
    ).toBe(true)
  const commands = [
    "/stop",
    "/new",
    "/status",
    "/safe on",
    "/model openai-compat/other",
  ]
  for (const command of commands) await stranger(direct, command)
  await stranger(direct, "open sesame")
  await stranger(channel, "open sesame", true)
  await stranger(channel, "/new", true)
  // The one button is Stop, and a stranger's click gets the plain acknowledgement in time and stops nothing.
  const click = await Effect.runPromise(
    running.click(status!, "stop", "mallory"),
  )
  expect(click._tag).toBe("Ack")
  const ignored = await lines(running, "message.ignored", commands.length + 3)
  expect(
    ignored.map((line) => [
      line.annotations["reason"],
      line.annotations["author"],
    ]),
  ).toEqual(Array(commands.length + 3).fill(["not-owner", "mallory"]))

  // The owner's turn ran to its answer in the one session, and nothing else was posted or changed.
  await fakes.model.release(0)
  await fakes.chat.answers(direct, 1)
  expect(await posted(running, direct)).toEqual(["done"])
  expect(await posted(running, channel)).toEqual([])
  expect(sessions(running)).toHaveLength(1)
  expect(rows(running, "SELECT outcome FROM turns")).toEqual([
    { outcome: "answered" },
  ])
  expect(await fakes.model.calls()).toHaveLength(1)
  expect((await running.chad(["safe"])).stdout).toBe(
    Messages.safeState("off") + "\n",
  )
  expect(
    running.log().some((line) => line.annotations["event"] === "command.ran"),
  ).toBe(false)
})
