import { expect, it } from "vitest"
import * as Attachments from "../../src/daemon/Attachments.ts"
import * as Handler from "../../src/daemon/Handler.ts"
import * as Sessions from "../../src/daemon/Sessions.ts"
import * as Messages from "../../src/Messages.ts"

/** A message with a mention of chad in front of its text. */
const mentioned = (text: string) => ({
  text: `<@chad> ${text}`,
  mentions: [
    { kind: "user" as const, id: "chad", isSelf: true, start: 0, end: 7 },
  ],
})

it("SES-34 SES-145 SES-146 a chat command is the first word of the trimmed message once the mention of chad is taken out, in any case and with any text after it, and nothing else is one", () => {
  const plain = (text: string) => Handler.command({ text, mentions: [] })
  expect(plain("/new")).toBe("new")
  expect(plain("  /STOP please, now")).toBe("stop")
  expect(plain("/Status\nand more")).toBe("status")
  expect(Handler.command(mentioned("/new"))).toBe("new")
  expect(Handler.command(mentioned("  /stop it"))).toBe("stop")
  for (const text of [
    "please /stop",
    "/stopped",
    "new",
    "/revert",
    "/login",
    "/",
    "",
  ]) {
    expect(plain(text)).toBeUndefined()
  }
  // A mention of someone else is not taken out, so the command is not the first word.
  expect(
    Handler.command({
      text: "<@other> /stop",
      mentions: [
        { kind: "user", id: "other", isSelf: false, start: 0, end: 8 },
      ],
    }),
  ).toBeUndefined()
})

it("STO-204 an inbox file is named by the message's id and the file's own name, with every character that is not a letter, a digit, a dot, an underscore or a hyphen as an underscore, no leading dots, and file for a name with nothing left", () => {
  expect(Attachments.inboxName("m1", "notes.txt")).toBe("m1-notes.txt")
  expect(Attachments.inboxName("m1", "my notes (1)?.txt")).toBe(
    "m1-my_notes__1__.txt",
  )
  expect(Attachments.inboxName("m1", "../../etc/passwd")).toBe(
    "m1-_.._etc_passwd",
  )
  expect(Attachments.inboxName("m1", "...hidden")).toBe("m1-hidden")
  expect(Attachments.inboxName("m1", "...")).toBe("m1-file")
  expect(Attachments.inboxName("m1", "")).toBe("m1-file")
  expect(Attachments.inboxName("m1", undefined)).toBe("m1-file")
  expect(Attachments.inboxName("a/b", "x")).toBe("a_b-x")
})

it("STO-206 a turn id is t_ and twelve lowercase hexadecimal digits, and no two are the same", () => {
  const ids = Array.from({ length: 200 }, Sessions.turnId)
  for (const id of ids) expect(id).toMatch(/^t_[0-9a-f]{12}$/)
  expect(new Set(ids).size).toBe(200)
})

it("SES-191 the image limit is 10 MiB and the file limit 25 MiB", () => {
  expect(Attachments.imageLimit).toBe(10 * 1024 * 1024)
  expect(Attachments.fileLimit).toBe(25 * 1024 * 1024)
})

it("SES-195 the reconcile gives each outstanding steer, oldest first, the first message it wrote with that text after the message the steer before it took, and a steer with no such message none", () => {
  // Every steer is among what was written, in order.
  expect(Sessions.matched(["a", "b"], ["a", "b"])).toEqual([0, 1])
  // Other messages lie between them, and a message with other content has no text.
  expect(Sessions.matched(["a", "b"], [undefined, "a", "x", "b"])).toEqual([
    0, 1,
  ])
  // Two steers with one text take one message each.
  expect(Sessions.matched(["a", "a"], ["a", "a"])).toEqual([0, 1])
  expect(Sessions.matched(["a", "a"], ["a"])).toEqual([0])
  // The order holds: a message before the one an older steer took is not a newer steer's.
  expect(Sessions.matched(["a", "b"], ["b", "a"])).toEqual([0])
  // A steer the Agent never read has no message, and the ones after it can still have theirs.
  expect(Sessions.matched(["a", "b"], ["b"])).toEqual([1])
  expect(Sessions.matched(["a"], [])).toEqual([])
  expect(Sessions.matched([], ["a"])).toEqual([])
})

it("DIS-59 DIS-64 DIS-75 DIS-76 DIS-77 SES-186 SES-190 the notices of a session are templates of the Messages module in the spec's wording, as subtext, and the one about a thread is a normal message", () => {
  expect(Messages.stopped(48_000)).toBe("-# Stopped after 48s.")
  expect(Messages.stopped(125_400)).toBe("-# Stopped after 2m 5s.")
  expect(Messages.stopped(200)).toBe("-# Stopped after 0s.")
  expect(Messages.nothingRunning()).toBe("-# Nothing is running.")
  expect(Messages.newSession()).toBe(
    "-# New session started. Nothing from the earlier conversation carries over.",
  )
  expect(Messages.noSession()).toBe(
    "-# There is no session in this channel. Mention me with a message and I'll open a thread for it.",
  )
  expect(Messages.threadFailed("Missing Permissions")).toBe(
    "I couldn't open a thread on that message (Missing Permissions). I need Create Public Threads here, or you can DM me.",
  )
  expect(Messages.fileSkipped("big.zip", 48 * 1024 * 1024)).toBe(
    "-# Skipped `big.zip` (48 MB). The limit is 25 MB.",
  )
  expect(Messages.fileFailed("lost.txt")).toBe(
    "-# Skipped `lost.txt`. I couldn't download it.",
  )
})
