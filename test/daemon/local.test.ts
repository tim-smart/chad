import { spawn } from "node:child_process"
import { test } from "vitest"
import { owner, scenario } from "../support/driver.ts"

test("a developer types into the local platform through the short script, and reads chad's answer", async () => {
  const running = await scenario({ transport: "client" })
  const { fakes, data } = running
  await running.logged("boot.ready")
  await fakes.model.script([{ text: "Hello, person." }])

  const script = spawn(
    process.execPath,
    ["scripts/local-chat.ts", "--as", owner],
    { env: { ...running.environment(), CHAD_DATA: data } },
  )
  try {
    let output = ""
    const printed = (text: string) =>
      new Promise<void>((resolve, reject) => {
        const check = () => output.includes(text) && resolve()
        script.stdout.on("data", (chunk) => {
          output += String(chunk)
          check()
        })
        script.stderr.on("data", (chunk) => (output += String(chunk)))
        script.on("exit", () =>
          reject(new Error("the script ended: " + output)),
        )
        check()
      })
    await printed("listening at")
    script.stdin.write("hello\n")
    await printed("chad: Hello, person.")
  } finally {
    script.kill()
  }
})
