// What effect's ChildProcessSpawner (the one clanka uses) reports when the binary is not on PATH
import { NodeServices } from "@effect/platform-node"
import { Effect, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
const tryIt = (name, args) => Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make(name, args, { stdin: "ignore" }))
  const out = yield* handle.all.pipe(Stream.decodeText, Stream.runCollect)
  const code = yield* handle.exitCode
  return name + " exit=" + code + " out=" + JSON.stringify(Array.from(out).join("").slice(0, 60))
}).pipe(Effect.scoped, Effect.catchCause((c) => Effect.succeed(name + " FAILED: " + String(c.failures?.[0]?.error ?? JSON.stringify(c)).slice(0, 400))))
const program = Effect.gen(function* () {
  for (const [n, a] of [["bash", ["-c", "echo hi"]], ["rg", ["--version"]], ["gh", ["--version"]], ["git", ["--version"]]]) console.log(yield* tryIt(n, a))
})
Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer))).catch((e) => console.log("run error", e))
