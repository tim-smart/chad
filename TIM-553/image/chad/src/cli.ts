// Every command but `serve`. Bundled into one file by esbuild.
import * as fs from "node:fs"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import { ChadRpcs, DATA, SOCKET, VERSION } from "./rpcs.ts"

const clientLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(NodeSocket.layerNet({ path: SOCKET })),
  Layer.provide(RpcSerialization.layerNdjson)
)

let exitCode = 0
const fail = (message: string) => Effect.sync(() => { console.error(message); exitCode = 1 })

type Client = Effect.Success<ReturnType<typeof makeClient>>
const makeClient = () => RpcClient.make(ChadRpcs)

const withDaemon = (command: string, f: (client: Client) => Effect.Effect<void, any, any>) =>
  Effect.gen(function*() {
    const client = yield* makeClient()
    const pong = yield* client.Ping().pipe(Effect.timeoutOption("2 seconds"))
    if (Option.isNone(pong)) return yield* fail("chad " + command + ": no answer on " + SOCKET + " in 2 seconds")
    yield* f(client)
  }).pipe(
    Effect.scoped,
    Effect.provide(clientLayer),
    Effect.catchCause(() => fail("chad " + command + ": no daemon on " + SOCKET))
  )

// "The chad CLI" (TIM-542): health exits 0 only when the lock is held and the daemon answers one ping.
// The lock test is the one from TIM-550: try to take it, and give it straight back.
const lockHeld = () => {
  const file = path.join(DATA, "db", "daemon.lock")
  if (!fs.existsSync(file)) return false
  const db = new DatabaseSync(file, { timeout: 0 })
  try { db.exec("BEGIN IMMEDIATE; ROLLBACK;"); return false } catch { return true } finally { db.close() }
}
const health = Command.make("health", {}, () =>
  lockHeld()
    ? withDaemon("health", () => Effect.sync(() => console.log("ok")))
    : fail("chad health: nothing holds the lock on " + DATA + ". Either no daemon runs there or the one that does has lost its lock."))

const status = Command.make("status", {}, () =>
  withDaemon("status", (client) =>
    Effect.gen(function*() {
      const s = yield* client.Status()
      console.log("chad " + s.version + ", pid " + s.pid + ", up " + (s.uptimeMs / 1000).toFixed(1) + " s")
      console.log("phase: " + s.phase)
      console.log("boot counter: " + s.bootCount)
      console.log("data volume: " + s.fsType + (s.fsWarning === "" ? "" : "\nwarning: " + s.fsWarning))
      if (s.mcp !== "") console.log("mcp: " + s.mcp)
    })))

const turn = Command.make(
  "turn",
  {
    session: Flag.String("session").pipe(Flag.withDefault("s1")),
    ms: Flag.Int("ms").pipe(Flag.withDefault(1000)),
    mode: Flag.String("mode").pipe(Flag.withDefault("busy")),
    child: Flag.Boolean("child").pipe(Flag.withDefault(false))
  },
  (options) => withDaemon("turn", (client) => Effect.gen(function*() { console.log(yield* client.Turn(options)) }))
)

const root = Command.make("chad").pipe(Command.withSubcommands([health, status, turn]))

NodeRuntime.runMain(
  Command.run(root, { version: VERSION }).pipe(
    Effect.catchCause(() => Effect.sync(() => { exitCode = exitCode || 2 })),
    Effect.provide(NodeServices.layer)
  ) as Effect.Effect<void>,
  { disableErrorReporting: true, teardown: (_exit, onExit) => onExit(exitCode) }
)
