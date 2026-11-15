import { expect, it } from "vitest"
import * as Messages from "../../src/Messages.ts"
import * as Status from "../../src/Status.ts"
import { read } from "../support/repo.ts"

it("STO-201 STO-202 what chad db prints beside its rows are templates of the Messages module, in the spec's wording", () => {
  const spec = read("docs/spec/02-storage.md")
  const templates = [
    Messages.dbMore(200),
    Messages.dbLimit(),
    Messages.dbFailed("query", "<SQLite's message>"),
    Messages.dbMissing("query", "<path>"),
  ]
  for (const template of templates) expect(spec).toContain(template)
  expect(Messages.dbMissing("check", "/data/db/chad.db")).toBe(
    "chad db check: no database at /data/db/chad.db",
  )
  expect(Messages.dbFailed("check", "database disk image is malformed")).toBe(
    "chad db check: database disk image is malformed",
  )
})

it("CLI-237 chad status --json gives one object whose daemon is up, none or silent, with the daemon's report, or with what the files say and null for a volume that is not written yet", () => {
  const report = {
    version: "1.2.3",
    effect: "4.1.4",
    phase: "loading",
    filesystem: ["/data is on tmpfs, which is memory."],
    connections: [{ name: "discord", kind: "discord" }],
  } as const
  expect(JSON.parse(Status.json({ daemon: "up", report }))).toEqual({
    daemon: "up",
    ...report,
  })
  const none = {
    daemon: "none",
    lock: "/data/state/daemon.lock",
    version: "1.2.3",
  } as const
  expect(JSON.parse(Status.json({ ...none, volume: undefined }))).toEqual({
    ...none,
    volume: null,
    connections: [],
  })
  const silent = {
    daemon: "silent",
    socket: "/data/run/chad.sock",
    seconds: 2,
    version: "1.2.3",
    volume: "1.2.2",
  } as const
  // A stored connection is shown by its name and kind, and never with its owner ids.
  const stored = { name: "discord", kind: "discord", owners: ["1"] }
  const line = Status.json({ ...silent, connections: [stored] })
  expect(JSON.parse(line)).toEqual({
    ...silent,
    connections: [{ name: "discord", kind: "discord" }],
  })
  expect(line).not.toContain("\n")
})
