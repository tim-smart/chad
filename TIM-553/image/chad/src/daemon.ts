// PROTOTYPE for TIM-553. A stand-in for `chad serve`: the boot order, the lock, the boot counter,
// the start-up checks and the stop, around a real Session entity on effect cluster's SingleRunner
// and clanka's real McpServers layer. It has no model, no gateway and no plugins.
import * as v8 from "node:v8"
import * as vm from "node:vm"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as McpServers from "clanka/McpServers"
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as Entity from "effect/cluster/Entity"
import * as SingleRunner from "effect/cluster/SingleRunner"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as net from "node:net"
import * as Layer from "effect/Layer"
import * as PrimaryKey from "effect/PrimaryKey"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as fs from "node:fs"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ChadRpcs, DATA, SOCKET, VERSION } from "./rpcs.ts"

const APP = path.resolve(import.meta.dirname, "..")
const env = process.env
const DB_DELAY = Number(env.CHAD_PROTO_DB_DELAY ?? 0)
const CLEAR_MS = Number(env.CHAD_PROTO_CLEAR_MS ?? 60_000)
/** 0 means no deadline of chad's own on the stop. */
const STOP_MAX = Number(env.CHAD_PROTO_STOP_MAX ?? 0)
/** Stands in for the owner timezone chad stores. */
const OWNER_TZ = env.CHAD_PROTO_OWNER_TZ
const uid = process.getuid!()
const gid = process.getgid!()
const started = Date.now()

const state = { phase: "starting", bootCount: 0, fsType: "", fsWarning: "", mcp: "" }
let sendTurn: ((payload: { session: string; ms: number; mode: string; child: boolean }) => Effect.Effect<string>) | undefined

const logFile = path.join(DATA, "logs", "chad.log")
let logToFile = false
const log = (ev: string, data: Record<string, unknown> = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), up: Date.now() - started, ev, ...data })
  console.log(line)
  if (logToFile) try { fs.appendFileSync(logFile, line + "\n") } catch {}
}
const die = (message: string): never => {
  console.error("chad serve: " + message)
  process.exit(1)
}

// --- start-up checks, before anything is written ------------------------------------------------

const owner = (p: string) => { const s = fs.statSync(p); return "uid " + s.uid + ", gid " + s.gid + ", mode " + (s.mode & 0o7777).toString(8) }
if (!fs.existsSync(DATA)) die(DATA + " does not exist. Mount the data volume there or set CHAD_DATA.")
try {
  fs.accessSync(DATA, fs.constants.W_OK | fs.constants.X_OK)
} catch {
  die("cannot write " + DATA + ". chad runs as uid " + uid + ", gid " + gid + " and " + DATA + " is owned by " + owner(DATA) + ". Give the volume to uid " + uid + ", for example: chown -R " + uid + ":" + gid + " <volume>")
}
const repo = path.join(DATA, "repo")
if (fs.existsSync(repo) && fs.statSync(repo).uid !== uid) {
  die(repo + " is owned by " + owner(repo) + " and chad runs as uid " + uid + ". git refuses a repository owned by another user. Give it to uid " + uid + ": chown -R " + uid + ":" + gid + " " + repo)
}
for (const d of ["db", "repo", "repo/work", "secrets", "state", "sessions", "home", "cache", "logs"]) fs.mkdirSync(path.join(DATA, d), { recursive: true })
fs.mkdirSync(path.join(DATA, "run"), { recursive: true, mode: 0o700 })
logToFile = true

// --- the filesystem under the volume -----------------------------------------------------------

const filesystem = (target: string = DATA) => {
  // The nearest directory that exists: HOME and the caches may not have been made yet.
  let existing = path.resolve(target)
  while (!fs.existsSync(existing)) existing = path.dirname(existing)
  const real = fs.realpathSync(existing)
  let best = { mount: "", type: "unknown", source: "" }
  for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const [left, right] = line.split(" - ")
    if (right === undefined) continue
    const mount = left.split(" ")[4]
    if ((real === mount || real.startsWith(mount === "/" ? "/" : mount + "/")) && mount.length >= best.mount.length) {
      const [type, source] = right.split(" ")
      best = { mount, type, source }
    }
  }
  return best
}
const NETWORK = /^(nfs|nfs4|ceph|cifs|smb3|smbfs|9p|glusterfs|lustre|fuse|fuse\..+)$/
const found = filesystem()
state.fsType = found.type + " (" + found.source + " at " + found.mount + ")"
if (NETWORK.test(found.type)) {
  state.fsWarning = DATA + " is on " + found.type + ". chad needs a local filesystem: SQLite's lock and write-ahead log are not safe on a network or FUSE filesystem."
} else if (found.type === "overlay" && found.mount === "/") {
  // The check follows CHAD_DATA to the mount that holds it. The container's own layer is that mount when no volume is.
  state.fsWarning = DATA + " is on the container's own filesystem, not on a volume. Everything chad writes is lost when the container is removed. Mount a volume at " + DATA + "."
} else if (found.type === "tmpfs" || found.type === "ramfs") {
  state.fsWarning = DATA + " is on " + found.type + ", which is memory. Everything chad writes is lost when the container stops."
}
if (state.fsWarning !== "") log("volume.warning", { type: found.type, message: state.fsWarning })
// What the agent installs goes to HOME, the npm prefix and the cache. The same check on each: the harm is an
// install that dies with the container. On a laptop none of them is on a container's layer, so this stays quiet.
for (const name of ["HOME", "NPM_CONFIG_PREFIX", "XDG_CACHE_HOME"]) {
  const value = env[name]
  if (value === undefined || value === "") continue
  const at = filesystem(value)
  const lost = at.type === "overlay" && at.mount === "/" ? "the container's own filesystem" : at.type === "tmpfs" || at.type === "ramfs" ? at.type : undefined
  if (lost === undefined || state.fsWarning.includes("container's own filesystem, not on a volume")) continue
  const message = name + "=" + value + " is on " + lost + ", not on the volume at " + DATA + ". What is installed there is lost with the container. In the chad image the volume is mounted at /data."
  state.fsWarning = state.fsWarning === "" ? message : state.fsWarning + "\nwarning: " + message
  log("volume.warning", { type: at.type, name, message })
}

// --- the lock and the boot counter -------------------------------------------------------------

const boots = path.join(DATA, "state", "boots")
const readBoots = () => { try { return Number(fs.readFileSync(boots, "utf8")) || 0 } catch { return 0 } }
const clearBoots = (why: string) => {
  if (readBoots() === 0) return
  fs.writeFileSync(boots, "0")
  state.bootCount = 0
  log("boot.cleared", { why })
}

const takeLock = () => {
  const handle = new DatabaseSync(path.join(DATA, "db", "daemon.lock"), { timeout: 0 })
  try {
    handle.exec("CREATE TABLE IF NOT EXISTS holder (pid INTEGER); BEGIN IMMEDIATE; DELETE FROM holder; INSERT INTO holder VALUES (" + process.pid + ")")
  } catch {
    die("another chad serve holds the lock on " + DATA + ". This boot is not counted.")
  }
  return handle
}
// The lock is the open write transaction, and it lasts only as long as this handle does. Until the third run
// nothing referred to the handle after this point, so a garbage collection closed it and let a second daemon in.
// The exit listener is what keeps it: it refers to the handle for as long as the process lives.
// CHAD_PROTO_NO_LOCK_REF=1 puts the hole back, for the check that shows it: the handle is taken and dropped.
if (env.CHAD_PROTO_NO_LOCK_REF === "1") takeLock()
else {
  const lock = takeLock()
  process.on("exit", () => { try { lock.close() } catch {} })
}
// CHAD_PROTO_GC_MS: collect garbage on a timer, so the check does not depend on when V8 chooses to.
if (env.CHAD_PROTO_GC_MS !== undefined) {
  v8.setFlagsFromString("--expose-gc")
  const collect = vm.runInNewContext("gc") as () => void
  setInterval(collect, Number(env.CHAD_PROTO_GC_MS)).unref()
}
state.bootCount = readBoots() + 1
fs.writeFileSync(boots, String(state.bootCount))
log("boot.counted", { count: state.bootCount, uid, gid, node: process.version, session: env.CHAD_SESSION })

// --- the stop ----------------------------------------------------------------------------------

let stopAt = 0
process.on("SIGTERM", () => {
  if (stopAt !== 0) return
  stopAt = Date.now()
  // First thing: a restart by the owner is not an unclean boot, even if the kill comes before the exit.
  clearBoots("SIGTERM")
  log("stop.sigterm", { phase: state.phase })
  state.phase = "stopping"
  if (STOP_MAX > 0) {
    setTimeout(() => {
      // The line names what had not closed, so the owner can see what the deadline cut.
      const stillOpen = [
        ...(closed.has("stop.entityLayersClosed") ? [] : ["sessions with a turn running: " + [...running].join(", ")]),
        ...(closed.has("stop.runnerClosed") ? [] : ["the runner"]),
        ...(closed.has("stop.mcpClosed") || state.mcp === "" ? [] : ["MCP servers: " + state.mcp.replace(/ Connected/g, "")])
      ]
      log("stop.forced", { afterMs: Date.now() - stopAt, stillOpen, note: "chad's own deadline: something did not stop" })
      process.exit(1)
    }, STOP_MAX).unref()
  }
})
process.on("exit", (code) => log("stop.exit", { code, afterMs: stopAt === 0 ? null : Date.now() - stopAt }))

const closed = new Set<string>()
const running = new Set<string>()
const marker = (ev: string) => Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => { closed.add(ev); log(ev, { afterMs: Date.now() - stopAt }) })))
const phase = (name: string) => Effect.sync(() => { state.phase = name; log("boot.phase", { phase: name }) })

// --- the socket: listening before the database is opened ---------------------------------------

const handlers = ChadRpcs.toLayer(Effect.succeed(ChadRpcs.of({
  Ping: () => Effect.succeed("pong"),
  Status: () => Effect.sync(() => ({ pid: process.pid, version: VERSION, phase: state.phase, bootCount: state.bootCount, fsType: state.fsType, fsWarning: state.fsWarning, uptimeMs: Date.now() - started, mcp: state.mcp })),
  Turn: (payload) => sendTurn === undefined ? Effect.succeed("not ready: " + state.phase) : sendTurn(payload)
})))

// Some filesystems cannot hold a unix socket (sshfs is one). Say so, and say what to do.
const socketCheck = Effect.callback<void>((resume) => {
  try { fs.unlinkSync(SOCKET) } catch {}
  const probe = net.createServer()
  const bytes = Buffer.byteLength(SOCKET)
  const tooLong = () => {
    console.error("chad serve: the socket path " + SOCKET + " is " + bytes + " bytes and a unix socket path holds 107. Set CHAD_SOCKET to a shorter path, for example /tmp/chad.sock.")
    process.exit(1)
  }
  if (bytes > 107) return tooLong()
  probe.once("error", (error: NodeJS.ErrnoException) => {
    console.error("chad serve: cannot create the socket " + SOCKET + " (" + (error.code ?? error.message) + "). " + path.dirname(SOCKET) + " is on " + filesystem(path.dirname(SOCKET)).type + ", which cannot hold a unix socket. chad needs a local filesystem under " + DATA + ".")
    process.exit(1)
  })
  probe.listen(SOCKET, () => probe.close(() => resume(Effect.void)))
})
const RpcLive = Layer.unwrap(Effect.as(socketCheck, undefined).pipe(Effect.map(() => {
  try { fs.unlinkSync(SOCKET) } catch {}
  return RpcServer.layer(ChadRpcs).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(NodeSocketServer.layer({ path: SOCKET })),
    Layer.merge(Layer.effectDiscard(phase("listening")))
  )
})))

// --- the database ------------------------------------------------------------------------------

const DatabaseLive = Layer.unwrap(Effect.gen(function*() {
  yield* phase("database")
  // Stand-in for a migration or a copy of the database that takes a while.
  yield* Effect.sleep(DB_DELAY)
  return SqliteClient.layer({ filename: path.join(DATA, "db", "chad.sqlite") })
}))

// --- what is put on the volume at every boot ---------------------------------------------------

// A link is replaced without asking. Anything else at that path is the agent's, so it is moved aside and logged.
const relink = (link: string, target: string) => {
  const stat = fs.lstatSync(link, { throwIfNoEntry: false })
  if (stat?.isSymbolicLink()) fs.unlinkSync(link)
  else if (stat !== undefined) {
    const aside = link + ".replaced-" + new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)
    fs.renameSync(link, aside)
    log("boot.movedAside", { path: link, to: aside, note: "chad keeps a link at this path and found something else there" })
  }
  fs.symlinkSync(target, link)
}
const LoadingLive = Layer.effectDiscard(Effect.gen(function*() {
  yield* phase("loading")
  fs.writeFileSync(path.join(DATA, "state", "version"), VERSION + "\n")
  // Both sit above work/, so git never sees them. Both point into the image, so an upgrade replaces what they show.
  relink(path.join(repo, "node_modules"), path.join(APP, "node_modules"))
  relink(path.join(repo, "examples"), path.join(APP, "plugins"))
  log("boot.linked", { node_modules: fs.readlinkSync(path.join(repo, "node_modules")), examples: fs.readlinkSync(path.join(repo, "examples")) })
}))

// --- MCP servers, through clanka's own layer ---------------------------------------------------

const mcpFile = path.join(repo, "work", "mcp.json")
// clanka adds one finalizer per server to the scope its layer is built in, and a scope runs its finalizers one
// after another. CHAD_PROTO_MCP_PARALLEL=1 builds the layer in a scope of chad's own that runs them at once.
// No change to clanka.
const mcpLayer = (config: any) =>
  env.CHAD_PROTO_MCP_PARALLEL !== "1" ? McpServers.layer(config) : Layer.effectContext(Effect.gen(function*() {
    const scope = yield* Scope.make("parallel")
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
    return yield* Layer.buildWithScope(McpServers.layer(config), scope)
  }))
const McpLive = Layer.unwrap(Effect.sync(() => {
  const config = fs.existsSync(mcpFile) ? JSON.parse(fs.readFileSync(mcpFile, "utf8")) : {}
  return Layer.effectDiscard(Effect.gen(function*() {
    const mcp = yield* McpServers.McpServers
    const status = yield* mcp.status
    state.mcp = Object.entries(status).map(([name, s]) => name + " " + (s as any)._tag).join(", ")
    if (state.mcp !== "") log("mcp.connected", { servers: state.mcp })
  })).pipe(Layer.provide(mcpLayer(config)))
}))

// --- the Session entity ------------------------------------------------------------------------

class TurnMessage extends Schema.Class<TurnMessage>("chad/TurnMessage")({
  key: Schema.String,
  ms: Schema.Number,
  mode: Schema.String,
  child: Schema.Boolean
}) {
  [PrimaryKey.symbol]() {
    return this.key
  }
}

const Session = Entity.make("Session", [
  Rpc.make("message", { payload: TurnMessage, success: Schema.String }).annotate(ClusterSchema.Persisted, true)
])

/** What the agent's `bash` tool would leave running: started the way clanka starts it. */
const BACKGROUND = "echo $$ > child.pid; env | grep '^CHAD_SESSION=' > child.env; echo TZ=${TZ:-unset} $(date +%Z) > child.tz; trap 'date +%s%3N > child.term; exit 0' TERM; while :; do sleep 0.1; done"

const SessionLive = Session.toLayer(
  Effect.gen(function*() {
    const address = yield* Entity.CurrentAddress
    const id = address.entityId as string
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Effect.scope
    const dir = path.join(DATA, "sessions", id)
    fs.mkdirSync(dir, { recursive: true })
    yield* Effect.addFinalizer(() => Effect.sync(() => log("session.closed", { session: id, afterMs: Date.now() - stopAt })))
    return {
      message: (envelope) =>
        Effect.gen(function*() {
          const p = envelope.payload
          log("turn.start", { session: id, key: p.key, ms: p.ms, mode: p.mode })
          running.add(id)
          if (p.child) {
            const handle = yield* spawner.spawn(ChildProcess.make("bash", ["-c", BACKGROUND], { cwd: dir, stdin: "ignore", env: { CHAD_SESSION: id, ...(OWNER_TZ === undefined ? {} : { TZ: OWNER_TZ }) }, extendEnv: true })).pipe(
              Scope.provide(scope),
              Effect.orDie
            )
            log("turn.background", { session: id, pid: handle.pid })
          }
          const wait = Effect.sleep(p.ms)
          yield* (p.mode === "stuck" ? Effect.uninterruptible(wait) : wait).pipe(
            Effect.onInterrupt(() => Effect.sync(() => { running.delete(id); log("turn.interrupted", { session: id, key: p.key, afterMs: Date.now() - stopAt }) }))
          )
          running.delete(id)
          log("turn.end", { session: id, key: p.key })
          return "done"
        })
    }
  }),
  { concurrency: "unbounded", maxIdleTime: 30 * 60_000, disableFatalDefects: true }
)

const ReadyLive = Layer.effectDiscard(Effect.gen(function*() {
  const makeSession = yield* Session.client
  let n = 0
  sendTurn = (payload) =>
    makeSession(payload.session).message(new TurnMessage({ key: payload.session + "-" + Date.now() + "-" + n++, ms: payload.ms, mode: payload.mode, child: payload.child }), { discard: true }).pipe(
      Effect.as("turn started in " + payload.session),
      Effect.orDie
    )
  yield* phase("ready")
  // 60 seconds after the boot finished loading, this boot counts as a clean one.
  const timer = setTimeout(() => clearBoots(CLEAR_MS / 1000 + " seconds after the boot finished loading"), CLEAR_MS)
  timer.unref()
  yield* Effect.addFinalizer(() => Effect.sync(() => { sendTurn = undefined; clearTimeout(timer) }))
}))

// Later lines are built first and closed last.
const Live = ReadyLive.pipe(
  Layer.provideMerge(SessionLive),
  Layer.provideMerge(marker("stop.entityLayersClosed")),
  // One shard: one runner gains nothing from cluster's default of 300, and each costs about 7 ms at the close.
  Layer.provideMerge(SingleRunner.layer({ shardingConfig: { entityMessagePollInterval: 1000, shardsPerGroup: Number(env.CHAD_PROTO_SHARDS ?? 1) } })),
  Layer.provideMerge(marker("stop.runnerClosed")),
  Layer.provideMerge(McpLive),
  Layer.provideMerge(marker("stop.mcpClosed")),
  Layer.provideMerge(LoadingLive),
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(RpcLive),
  Layer.provideMerge(Layer.mergeAll(NodeCrypto.layerDigest, NodeServices.layer))
)

// A stop the daemon finished exits 0. Only a boot that failed or a stop that was forced exits 1.
NodeRuntime.runMain(Layer.launch(Live as Layer.Layer<never, any, never>), {
  teardown: (exit, onExit) => onExit(stopAt !== 0 || Exit.isSuccess(exit) ? 0 : 1)
})
