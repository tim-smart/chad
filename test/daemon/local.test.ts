import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { owner, scenario } from "../support/driver.ts"

test("TST-49 TST-50 TST-57 STO-122 DIS-79 the adapter client reaches a platform that starts listening at run/local.sock after the daemon, and the scenario runs over the test-only requests", async () => {
  // With this transport the driver starts the platform only after the boot, so the client has had to try again.
  const running = await scenario({ transport: "socket" })
  const { fakes, data } = running
  expect(existsSync(join(data, "run/local.sock"))).toBe(true)
  await fakes.model.script([{ text: "Hello over the socket." }])
  const thread = await fakes.chat.makeThread("direct")
  const event = await fakes.chat.userPosts(thread, {
    text: "hello",
    authorId: owner,
  })
  expect(await fakes.chat.deliver(event)).toBe(true)

  const [answer] = await fakes.chat.answers(thread, 1)
  expect(answer?.text).toBe("Hello over the socket.")
  expect(await fakes.model.received(1)).toHaveLength(1)
})

test("TST-55 the local platform splits an answer at the Discord adapter's limit of 2000 and not at ChatTest's 4000", async () => {
  const running = await scenario()
  const { fakes } = running
  const long = Array.from({ length: 50 }, (_, index) =>
    `Paragraph ${index} `.padEnd(59, "x"),
  ).join("\n\n")
  expect(long.length).toBeGreaterThan(2000)
  expect(long.length).toBeLessThan(4000)
  await fakes.model.script([{ text: long }])
  const thread = await fakes.chat.makeThread("direct")
  const event = await fakes.chat.userPosts(thread, {
    text: "hello",
    authorId: owner,
  })
  await fakes.chat.deliver(event)

  const answers = await fakes.chat.answers(thread, 2)
  expect(answers).toHaveLength(2)
  for (const answer of answers) {
    expect(answer.text.length).toBeLessThanOrEqual(2000)
  }
})

test("TST-51 a developer types into the local platform through the short script, and reads chad's answer", async () => {
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
