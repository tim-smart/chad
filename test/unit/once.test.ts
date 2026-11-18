// The mask the daemon puts in place of a value `requestOnce` gave a session: in a stream of that session's output whose
// chunks split the value, after the session forgets it, and in the error of a command that could not be spawned.
import { inspect } from "node:util"
import { Cause, Duration, Effect, Exit, Layer } from "effect"
import * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { expect, it } from "vitest"
import * as Once from "../../src/daemon/Once.ts"
import * as Spawner from "../../src/daemon/Spawner.ts"

it("a value split across chunks of a session's output is masked, an address cut after its code is masked whole, and another session's output is left alone", async () => {
  const value = "once-7c3e9a41d2"
  const once = Once.make(Duration.minutes(5))
  const request = once.open("local:t1", "s1")
  expect(once.submit(request.id, "local:t1", value)).toBe(true)
  expect(await Effect.runPromise(request.submitted)).toBe(value)

  const redactor = once.redactor("s1")
  const chunks = [
    "code: once-7c",
    "3e9a41d2 and once-7",
    "c3e9a41d2",
    " then once-7",
  ]
  const passed = [...chunks.map(redactor.push), redactor.end()]
  expect(passed.join("")).toBe(
    `code: ${Once.mask} and ${Once.mask} then once-7`,
  )
  for (const part of passed) expect(part).not.toContain(value)

  const other = once.redactor("s2")
  expect(other.push(value)).toBe(value)

  // An address cut after its code: the code alone matches, but the address may still follow, so it is held back and
  // masked whole. A stream that ends there masks what it held.
  const address =
    "http://localhost/oauth/callback?state=st-9f2b6d81c4a7e035&code=4%2F0Ab7c3e9a41d2once&scope=calendar.events"
  const cut = address.indexOf("&scope=")
  const second = once.open("local:t1", "s1")
  once.submit(second.id, "local:t1", address)
  const split = once.redactor("s1")
  expect(
    [
      split.push("got " + address.slice(0, cut)),
      split.push(address.slice(cut) + " done"),
      split.end(),
    ].join(""),
  ).toBe(`got ${Once.mask} done`)
  const ended = once.redactor("s1")
  expect(ended.push("got " + address.slice(0, cut)) + ended.end()).toBe(
    `got http://localhost/oauth/callback?state=${Once.mask}&code=${Once.mask}`,
  )
})

it("a session's values are gone once its turn ends, and a stream that was open then keeps its mask", async () => {
  const value = "once-7c3e9a41d2"
  const once = Once.make(Duration.minutes(5))
  const request = once.open("local:t1", "s1")
  once.submit(request.id, "local:t1", value)
  const open = once.redactor("s1")
  once.forget("s1")
  expect(once.holds("s1")).toBe(false)
  expect(once.scrub("s1", value)).toBe(value)
  expect(open.push(value) + open.end()).toBe(Once.mask)
})

it("a command's spawn error is made again with the value masked, and keeps no raw error under it", async () => {
  const value = "once-7c3e9a41d2"
  const once = Once.make(Duration.minutes(5))
  const request = once.open("local:t1", "s1")
  once.submit(request.id, "local:t1", value)
  // effect's Node spawner names the command line in the error, and Node's own error under it holds the arguments.
  const failing = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: `bash -c 'test -n ${value}'`,
          cause: Object.assign(new Error("spawn bash ENOENT"), {
            spawnargs: ["-c", `test -n ${value}`],
          }),
        }),
      ),
    ),
  )
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return yield* spawner.spawn(ChildProcess.make("bash", ["-c", "true"]))
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Spawner.layer("s1", undefined, undefined, () =>
          once.redactor("s1"),
        ).pipe(Layer.provide(failing)),
      ),
      Effect.exit,
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) return
  expect(Cause.pretty(exit.cause)).toContain(Once.mask)
  expect(inspect(Cause.squash(exit.cause), { depth: 10 })).not.toContain(value)
})
