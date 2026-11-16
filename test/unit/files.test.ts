import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Duration, Effect, Fiber, FileSystem } from "effect"
import { expect, it } from "vitest"
import { Environment } from "../../src/cli/Environment.ts"
import * as Files from "../../src/cli/Files.ts"
import * as Connections from "../../src/Connections.ts"
import * as Lock from "../../src/Lock.ts"
import * as Paths from "../../src/Paths.ts"

it("CLI-33 an interrupted offline write keeps the daemon lock until its pending rename finishes", async () => {
  const data = mkdtempSync(join(tmpdir(), "chad-files-"))
  const lock = Paths.lock(data)
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const fs = await Effect.runPromise(
    FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)),
  )
  const connections: ReadonlyArray<Connections.Connection> = [
    { name: "local", kind: "local", owners: ["owner"] },
  ]
  let pending: Promise<void> | undefined
  // Like Node's native rename, this submitted operation cannot be cancelled.
  const delayed = FileSystem.FileSystem.of({
    ...fs,
    rename: (from, to) =>
      Effect.promise(() => {
        started.resolve()
        pending = finish.promise.then(() =>
          Effect.runPromise(fs.rename(from, to)),
        )
        return pending
      }),
  })
  const fiber = Effect.runFork(
    Files.locked("connection add", Connections.write(data, connections)).pipe(
      Effect.provideService(FileSystem.FileSystem, delayed),
      Effect.provideService(Environment, {
        data,
        lock,
        socket: Paths.socket({ CHAD_DATA: data }),
        session: undefined,
        inherited: {},
      }),
    ),
  )
  try {
    await started.promise
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    await setImmediate()
    expect(Lock.test(lock)).toBe("held")
    finish.resolve()
    await interrupted
    const release = Lock.take(lock, Duration.zero)
    expect(release).toBeDefined()
    try {
      expect(
        await Effect.runPromise(
          Connections.read(data).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
        ),
      ).toEqual(connections)
    } finally {
      release?.()
    }
  } finally {
    finish.resolve()
    await Effect.runPromise(Fiber.await(fiber))
    await pending
    rmSync(data, { recursive: true, force: true })
  }
})

it("CLI-33 cancellation before lock ownership does not wait for setup or write connections", async () => {
  const data = mkdtempSync(join(tmpdir(), "chad-files-"))
  const lock = Paths.lock(data)
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const fs = await Effect.runPromise(
    FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)),
  )
  let pending: Promise<void> | undefined
  const delayed = FileSystem.FileSystem.of({
    ...fs,
    makeDirectory: (path, options) =>
      Effect.promise(() => {
        started.resolve()
        pending = finish.promise.then(() =>
          Effect.runPromise(fs.makeDirectory(path, options)),
        )
        return pending
      }),
  })
  const fiber = Effect.runFork(
    Files.locked(
      "connection add",
      Connections.write(data, [
        { name: "local", kind: "local", owners: ["owner"] },
      ]),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, delayed),
      Effect.provideService(Environment, {
        data,
        lock,
        socket: Paths.socket({ CHAD_DATA: data }),
        session: undefined,
        inherited: {},
      }),
    ),
  )
  try {
    await started.promise
    let stopped = false
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      stopped = true
    })
    await setImmediate()
    expect(Lock.test(lock)).toBe("free")
    expect(stopped).toBe(true)
    finish.resolve()
    await pending
    await interrupted
    expect(await Effect.runPromise(fs.exists(lock))).toBe(false)
    expect(
      await Effect.runPromise(
        Connections.read(data).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      ),
    ).toEqual([])
  } finally {
    finish.resolve()
    await Effect.runPromise(Fiber.await(fiber))
    await pending
    rmSync(data, { recursive: true, force: true })
  }
})
