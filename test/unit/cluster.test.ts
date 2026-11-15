import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Effect, Exit, Layer, Queue, Schema, Scope } from "effect"
import { ClusterSchema, Entity, SingleRunner } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { expect, it } from "vitest"

it("SES-23 a persisted request reaches the local entity straight after it is saved, with cluster's storage poll an hour away", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chad-cluster-"))
  const Echo = Entity.make("Echo", [
    Rpc.make("say", {
      payload: { id: Schema.String },
      primaryKey: ({ id }) => id,
    }).annotate(ClusterSchema.Persisted, true),
  ])
  try {
    const said = Effect.runSync(Queue.unbounded<string>())
    const cluster = Echo.toLayer({
      say: ({ payload }) => Effect.asVoid(Queue.offer(said, payload.id)),
    }).pipe(
      Layer.provideMerge(
        // After the read at start-up, the storage poll delivers nothing within this test.
        SingleRunner.layer({
          shardingConfig: { entityMessagePollInterval: "1 hour" },
        }),
      ),
      Layer.provide(
        SqliteClient.layer({ filename: join(directory, "cluster.sqlite") }),
      ),
      Layer.provide(NodeCrypto.layerDigest),
    )
    const heard = await Effect.gen(function* () {
      const echo = (yield* Echo.client)("one")
      const heard: Array<string> = []
      // The second request is saved after the first was handled, so no read at start-up can be what delivers it.
      for (const id of ["first", "second"]) {
        yield* echo.say({ id }, { discard: true })
        heard.push(yield* Queue.take(said))
      }
      return heard
    }).pipe(Effect.provide(cluster), Effect.runPromise)
    expect(heard).toEqual(["first", "second"])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("SES-28 a second runner on the same database file starts beside the first and handles its own requests, so cluster's shard lock stops no second daemon", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chad-cluster-"))
  const Echo = Entity.make("Echo", [
    Rpc.make("say", {
      payload: { id: Schema.String },
      primaryKey: ({ id }) => id,
    }).annotate(ClusterSchema.Persisted, true),
  ])
  /** One daemon's worth of cluster: its own runner, with the address every chad has, on the shared file. */
  const runner = Effect.fnUntraced(function* (scope: Scope.Scope) {
    const said = yield* Queue.unbounded<string>()
    const context = yield* Layer.buildWithScope(
      Echo.toLayer({
        say: ({ payload }) => Effect.asVoid(Queue.offer(said, payload.id)),
      }).pipe(
        Layer.provideMerge(
          SingleRunner.layer({
            shardingConfig: { entityMessagePollInterval: "1 hour" },
          }),
        ),
        Layer.provide(
          SqliteClient.layer({ filename: join(directory, "cluster.sqlite") }),
        ),
        Layer.provide(NodeCrypto.layerDigest),
      ),
      scope,
    )
    const say = (id: string) =>
      Effect.gen(function* () {
        const echo = (yield* Echo.client)("one")
        yield* echo.say({ id }, { discard: true })
        return yield* Queue.take(said)
      }).pipe(Effect.provideContext(context))
    return { say }
  })
  try {
    const heard = await Effect.gen(function* () {
      const scope = yield* Scope.make()
      const first = yield* runner(scope)
      const before = yield* first.say("first, alone")
      // The first runner is still up and holds its shard when the second starts.
      const second = yield* runner(scope)
      const heard = [
        before,
        yield* second.say("second"),
        yield* first.say("first, beside the second"),
      ]
      yield* Scope.close(scope, Exit.void)
      return heard
    }).pipe(Effect.runPromise)
    expect(heard).toEqual([
      "first, alone",
      "second",
      "first, beside the second",
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
