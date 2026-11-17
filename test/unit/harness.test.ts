import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as Storage from "../../src/daemon/Storage.ts"
import { json, path, read } from "../support/repo.ts"

it("the migrations only go forward, one file for each, and one that has shipped is never edited", () => {
  const delivered: Record<string, string> = json(
    "test/unit/fixtures/migrations.json",
  )
  const directory = "src/daemon/migrations"
  const names = readdirSync(path(directory)).sort()
  expect(names.map((name) => name.replace(/\.ts$/, ""))).toEqual(
    Object.keys(Storage.migrations),
  )
  for (const name of names) {
    expect(read(join(directory, name))).not.toMatch(/\bdown\b|DROP TABLE/i)
  }
  // A shipped migration keeps the hash it shipped with. A new migration adds its hash to the fixture.
  const hashes = Object.fromEntries(
    names.map((name) => [
      name,
      createHash("sha256")
        .update(read(join(directory, name)))
        .digest("hex"),
    ]),
  )
  expect(hashes).toEqual(delivered)
})
