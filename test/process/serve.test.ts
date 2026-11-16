import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { path } from "../support/repo.ts"

it("chad serve is the daemon: it boots on an empty directory with no connection, and a SIGTERM ends it with code 0", async () => {
  const data = mkdtempSync(join(tmpdir(), "chad-serve-"))
  const { CHAD_SESSION: _, ...environment } = process.env
  const serve = spawn(process.execPath, [path("bin/chad.js"), "serve"], {
    env: { ...environment, CHAD_DATA: data },
  })
  try {
    let output = ""
    serve.stdout.on("data", (chunk) => (output += String(chunk)))
    serve.stderr.on("data", (chunk) => (output += String(chunk)))
    const exit = new Promise<number | null>((resolve) =>
      serve.on("exit", (code) => resolve(code)),
    )
    await new Promise<void>((resolve, reject) => {
      serve.stdout.on(
        "data",
        () => output.includes("event=boot.ready") && resolve(),
      )
      void exit.then(() => reject(new Error("chad serve ended: " + output)))
    })
    expect(output).toMatch(/event=boot\.ready .*connections=0/)

    serve.kill("SIGTERM")
    expect(await exit).toBe(0)
    expect(readFileSync(join(data, "state/version"), "utf8")).toMatch(/^\S+\n$/)
  } finally {
    serve.kill("SIGKILL")
    rmSync(data, { recursive: true, force: true })
  }
}, 30_000)
