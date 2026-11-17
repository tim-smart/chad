import { expect, it } from "vitest"
import * as Attachments from "../../src/daemon/Attachments.ts"
it("an inbox file is named by the message's id and the file's own name, with every character that is not a letter, a digit, a dot, an underscore or a hyphen as an underscore, no leading dots, and file for a name with nothing left", () => {
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
