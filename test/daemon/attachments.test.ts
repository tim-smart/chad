import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Effect } from "effect"
import { ChatError } from "effect/chat"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import { fresh, scenario, type Scenario } from "../support/driver.ts"
import { printed, runs } from "../support/model.ts"
import {
  eventually,
  posted,
  prompted,
  rows,
  says,
  sessions,
} from "../support/owner.ts"

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const megabyte = 1024 * 1024

/** The `inbox/` of a scenario's one session. */
const inbox = (running: Scenario) =>
  join(running.data, "sessions", String(sessions(running)[0]?.["id"]), "inbox")

/** The files under `inbox/`, by name. */
const saved = (running: Scenario) =>
  existsSync(inbox(running)) ? readdirSync(inbox(running)).toSorted() : []

test("OV-37 SES-40 SES-41 SES-43 SES-189 SES-191 DIS-63 STO-21 STO-67 STO-204 on a message that starts a turn an image goes to the model and into the history as base64, every other file and an image over 10 MB are saved under inbox/ and named in the prompt, and the stored request holds ids and no bytes", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([{ text: "done" }])
  const thread = await fakes.chat.makeThread("direct")
  const large = new Uint8Array(10 * megabyte + 1).fill(7)
  const hello = await says(running, thread, "look at these", {
    files: [
      { name: "dot.png", contentType: "image/png", content: png },
      {
        name: "my notes?.txt",
        contentType: "text/plain",
        content: new TextEncoder().encode("the notes"),
      },
      { name: "large.png", contentType: "image/png", content: large },
      { name: "..hidden", contentType: "image/svg+xml", content: png },
    ],
  })
  await fakes.chat.answers(thread, 1)
  await running.logged("turn.ended")
  const id = hello.message.id
  const base64 = Buffer.from(png).toString("base64")

  // The small image is the one file the model gets, and it is in the stored history as it was sent.
  const [call] = await fakes.model.calls()
  const body = JSON.stringify(call?.body)
  expect(body.split(base64)).toHaveLength(2)
  const history = rows(
    running,
    "SELECT message FROM session_messages ORDER BY seq",
  ).map((row) => String(row["message"]))
  expect(history[0]?.split(base64)).toHaveLength(2)

  // The others are files in the session's directory, under the message's id and a name that is safe in a path.
  expect(saved(running)).toEqual([
    `${id}-hidden`,
    `${id}-large.png`,
    `${id}-my_notes_.txt`,
  ])
  expect(
    readFileSync(join(inbox(running), `${id}-my_notes_.txt`), "utf8"),
  ).toBe("the notes")
  expect(statSync(join(inbox(running), `${id}-large.png`)).size).toBe(
    large.length,
  )
  for (const [name, file] of [
    ["my notes?.txt", "my_notes_.txt"],
    ["large.png", "large.png"],
    ["..hidden", "hidden"],
  ] as const) {
    expect(body).toContain(
      JSON.stringify(
        Messages.promptFileSaved(name, join(inbox(running), `${id}-${file}`)),
      ).slice(1, -1),
    )
  }
  expect(await posted(running, thread)).toEqual(["done"])

  // The request cluster stored names the four attachments by their ids in the message, and carries no content.
  const [request] = rows(
    running,
    "SELECT payload FROM cluster_messages WHERE tag = 'message'",
  )
  const payload = JSON.parse(String(request?.["payload"]))
  expect(payload.attachments).toEqual(
    hello.message.attachments.map((attachment) => attachment.id),
  )
  expect(payload.attachments).toHaveLength(4)
  expect(String(request?.["payload"])).not.toContain(base64)
  expect(String(request?.["payload"]).length).toBeLessThan(10_000)
})

test("SES-42 SES-190 DIS-64 a file over 25 MB is not downloaded and one whose download fails is skipped, each with a subtext notice that names it and a line in the prompt, and the turn carries on", async () => {
  const running = await scenario()
  const { fakes, chat } = running
  await fakes.model.script([{ text: "done" }])
  const thread = await fakes.chat.makeThread("direct")
  const size = 26 * megabyte
  await Effect.runPromise(
    chat.failNext("download", new ChatError.NotFound({ detail: "gone" })),
  )
  await says(running, thread, "and these", {
    files: [
      {
        name: "big.zip",
        contentType: "application/zip",
        content: new Uint8Array(size),
      },
      { name: "lost.txt", contentType: "text/plain", content: png },
      { name: "kept.txt", contentType: "text/plain", content: png },
    ],
  })
  await fakes.chat.answers(thread, 3)
  await running.logged("turn.ended")

  expect(await posted(running, thread)).toEqual([
    Messages.fileSkipped("big.zip", size),
    Messages.fileFailed("lost.txt"),
    "done",
  ])
  const prompt = prompted((await fakes.model.calls())[0])
  expect(prompt).toContain(Messages.promptFileSkipped("big.zip", size))
  expect(prompt).toContain(Messages.promptFileFailed("lost.txt"))
  expect(saved(running)).toHaveLength(1)
  expect(saved(running)[0]).toMatch(/-kept\.txt$/)
  // Only the two files under the limit were asked for.
  const downloads = (await Effect.runPromise(chat.calls)).filter(
    (call) => call.op === "download",
  )
  expect(downloads).toHaveLength(2)
  expect(rows(running, "SELECT outcome FROM turns")).toEqual([
    { outcome: "answered" },
  ])
})

test("SES-154 on a message that steers a running turn every file is saved under inbox/ before the message joins the turn, an image included, and the steering text carries the path in place of the image", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    { ...runs('console.log("ran")'), hold: true },
    { text: "done" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "hello")
  await fakes.model.received(1)
  const steer = await says(running, thread, "and this picture", {
    files: [{ name: "dot.png", contentType: "image/png", content: png }],
  })
  const name = `${steer.message.id}-dot.png`
  await eventually(
    () => saved(running),
    (files) => files.includes(name),
  )
  // The file is there while the turn has not read the message.
  expect(rows(running, "SELECT * FROM steers")).toEqual([])
  await fakes.model.release(0)
  await fakes.chat.answers(thread, 1)

  const calls = await fakes.model.calls()
  expect(prompted(calls[1])).toBe(
    [
      "and this picture",
      Messages.promptFileSaved("dot.png", join(inbox(running), name)),
    ].join("\n\n"),
  )
  expect(JSON.stringify(calls[1]?.body)).not.toContain(
    Buffer.from(png).toString("base64"),
  )
  expect(new Uint8Array(readFileSync(join(inbox(running), name)))).toEqual(png)
  expect(rows(running, "SELECT * FROM steers")).toHaveLength(1)
})

test("SES-41 SES-198 STO-21 a file the owner sends after the Agent has changed its directory is named by a path that reaches the saved file from there", async () => {
  const running = await scenario()
  const { fakes } = running
  await fakes.model.script([
    runs('await run("mkdir -p work"); await changeDirectory("work")'),
    { text: "moved" },
    runs('console.log((await run("pwd")).trim())'),
    { text: "read it" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  await says(running, thread, "move")
  await fakes.chat.answers(thread, 1)
  const note = await says(running, thread, "read this", {
    files: [
      {
        name: "note.txt",
        contentType: "text/plain",
        content: new TextEncoder().encode("a note"),
      },
    ],
  })
  await fakes.chat.answers(thread, 2)

  const calls = await fakes.model.calls()
  const cwd = String(printed(calls[3]).at(-1)).trim()
  expect(cwd).toBe(join(inbox(running), "..", "work"))
  const path = join(inbox(running), `${note.message.id}-note.txt`)
  expect(prompted(calls[2])).toBe(
    ["read this", Messages.promptFileSaved("note.txt", path)].join("\n\n"),
  )
  expect(readFileSync(resolve(cwd, path), "utf8")).toBe("a note")
})

test("SES-41 SES-198 STO-21 with a relative CHAD_DATA the prompt still names a saved file by its absolute path, which reaches the file from the Agent's directory", async () => {
  const directory = fresh()
  const running = await scenario({
    directory,
    env: { CHAD_DATA: relative(process.cwd(), join(directory, "data")) },
  })
  const { fakes } = running
  await fakes.model.script([
    runs('console.log((await run("pwd")).trim())'),
    { text: "read it" },
  ])
  const thread = await fakes.chat.makeThread("direct")
  const note = await says(running, thread, "read this", {
    files: [
      {
        name: "note.txt",
        contentType: "text/plain",
        content: new TextEncoder().encode("a note"),
      },
    ],
  })
  await fakes.chat.answers(thread, 1)

  const calls = await fakes.model.calls()
  const cwd = String(printed(calls[1]).at(-1)).trim()
  const path = join(inbox(running), `${note.message.id}-note.txt`)
  expect(isAbsolute(path)).toBe(true)
  expect(prompted(calls[0])).toBe(
    ["read this", Messages.promptFileSaved("note.txt", path)].join("\n\n"),
  )
  expect(readFileSync(resolve(cwd, path), "utf8")).toBe("a note")
})
