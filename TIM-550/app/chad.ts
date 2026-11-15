// One program: `serve` is the daemon, everything else is a client.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import * as Cause from "effect/Cause"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Prompt from "effect/cli/Prompt"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ChadRpcs, VERSION } from "./rpcs.ts"

const stateDir = process.env.CHAD_STATE ?? path.resolve("state")
const lockPath = path.join(stateDir, "daemon.lock")
const sockAbs = path.join(stateDir, "chad.sock")
// sun_path is 108 bytes on Linux. A longer absolute path fails with listen EINVAL, so
// fall back to a path relative to the working directory.
const sockPath =
  Buffer.byteLength(sockAbs) > 107 && process.env.CHAD_PROTO_ABS_SOCKET !== "1" ? path.relative(process.cwd(), sockAbs) : sockAbs
const ts = () => new Date().toISOString().slice(11, 23)
let exitCode = 0
const finish = (code: number, message?: string) =>
  Effect.sync(() => {
    if (message) (code === 0 ? console.log : console.error)(message)
    exitCode = code
  })

// ---------------------------------------------------------------- daemon

const dlog = (s: string) => console.log(`${ts()} [daemon ${process.pid}] ${s}`)

const refused = (reason: "version" | "owner", message: string) => ({ _tag: "Refused" as const, reason, message })

const guard = (tag: string, headers: Record<string, string | undefined>, owner = false) =>
  Effect.suspend(() => {
    const v = headers["chad-version"]
    if (v !== VERSION) {
      dlog(`REFUSED ${tag}: client version ${JSON.stringify(v)} != daemon ${VERSION}`)
      return Effect.fail(refused("version", `version mismatch: cli ${v ?? "(none)"}, daemon ${VERSION}; only status and health are allowed`))
    }
    const session = headers["chad-session"]
    if (owner && session !== undefined) {
      dlog(`REFUSED ${tag}: owner call carried session id ${session}`)
      return Effect.fail(refused("owner", `'${tag}' is an owner command; call came from agent session ${session}`))
    }
    return Effect.void
  })

// A stream RPC body that emits lines. The body runs in a fiber owned by the call's
// scope, so a client that goes away interrupts it.
const lineStream = <E>(name: string, body: (emit: (line: string) => Effect.Effect<void>) => Effect.Effect<void, E>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const q = yield* Queue.unbounded<string, E | Cause.Done>()
      yield* body((line) => Effect.asVoid(Queue.offer(q, line))).pipe(
        Effect.onExit((exit) => {
          dlog(
            `${name} handler exit: ${Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "INTERRUPTED" : "failure"}`
          )
          return Exit.isSuccess(exit) ? Queue.end(q) : Queue.failCause(q, exit.cause as any)
        }),
        Effect.forkScoped
      )
      return Stream.fromQueue(q)
    })
  )

const handlers = ChadRpcs.toLayer(
  Effect.gen(function* () {
    const queue = yield* Semaphore.make(1)
    let current: string | undefined
    let step = ""
    let calls = 0
    return ChadRpcs.of({
      Ping: () => Effect.succeed("pong"),
      Status: (_, { headers }) =>
        Effect.sync(() => {
          dlog(`Status from client version ${headers["chad-version"]}`)
          return { pid: process.pid, version: VERSION, queue: current ? `${current} at step ${step}` : "idle" }
        }),
      Tail: ({ count, intervalMs }, { headers, client }) => {
        const name = `tail#${++calls} (client ${client.id})`
        return lineStream(name, (emit) =>
          Effect.gen(function* () {
            yield* guard("tail", headers)
            dlog(`${name} started`)
            for (let i = 1; i <= count; i++) {
              yield* emit(`line ${i}/${count} sent ${ts()}`)
              yield* Effect.sleep(intervalMs)
            }
          })
        )
      },
      Apply: ({ label, loadMs, swapDelayMs }, { headers, client }) => {
        const name = `apply#${++calls} "${label}" (client ${client.id})`
        return lineStream(name, (emit) =>
          Effect.gen(function* () {
            yield* guard("apply", headers)
            dlog(`${name} received`)
            if (current !== undefined) {
              dlog(`${name} queued behind ${current}`)
              yield* emit(`waiting on: ${current} (at step ${step})`)
            }
            const at = (s: string) =>
              Effect.suspend(() => {
                step = s
                dlog(`${name} step ${s}`)
                return emit(`step ${s} ${ts()}`)
              })
            yield* queue.withPermits(1)(
              Effect.gen(function* () {
                current = name
                yield* at("snapshot")
                yield* Effect.sleep(100)
                yield* at("check")
                yield* Effect.sleep(100)
                yield* at("load")
                yield* Effect.sleep(loadMs)
                // from commit on the call cannot be interrupted
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* at("commit")
                    fs.appendFileSync(path.join(stateDir, "commits.log"), `${ts()} commit ${label}\n`)
                    yield* Effect.sleep(swapDelayMs)
                    yield* at("swap")
                    fs.appendFileSync(path.join(stateDir, "commits.log"), `${ts()} swap ${label}\n`)
                  })
                )
                yield* emit(`applied ${label}`)
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    current = undefined
                  })
                )
              )
            )
          })
        )
      },
      Reload: (_, { headers }) =>
        Effect.gen(function* () {
          yield* guard("reload", headers, true)
          dlog("Reload accepted (owner call, no session id on the call)")
          return "reloaded"
        })
    })
  })
)

const serve = (opts: { listenDelay: number; keepStaleSocket: boolean }) =>
  Effect.gen(function* () {
    fs.mkdirSync(stateDir, { recursive: true })
    const db = new DatabaseSync(lockPath, { timeout: 0 })
    try {
      db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;")
    } catch (e: any) {
      return yield* finish(1, `${ts()} [daemon ${process.pid}] another daemon holds ${lockPath}: ${e.message}`)
    }
    dlog("lock taken")
    if (opts.listenDelay > 0) {
      dlog(`delaying ${opts.listenDelay}ms before listening`)
      yield* Effect.sleep(opts.listenDelay)
    }
    if (!opts.keepStaleSocket && fs.existsSync(sockPath)) {
      fs.unlinkSync(sockPath)
      dlog("removed stale socket file (safe: we hold the lock)")
    }
    const server = RpcServer.layer(ChadRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(NodeSocketServer.layer({ path: sockPath }))
    )
    const old = process.umask(0o177)
    yield* Layer.build(server)
    process.umask(old)
    dlog(`listening on ${sockPath} mode ${(fs.statSync(sockPath).mode & 0o777).toString(8)}`)
    yield* Effect.never
  }).pipe(Effect.scoped)

// ---------------------------------------------------------------- client

// Non-destructive lock test. Never creates the lock file.
const lockState = (): "free" | "held" => {
  if (!fs.existsSync(lockPath)) return "free"
  const db = new DatabaseSync(lockPath, { timeout: 0 })
  try {
    db.exec("BEGIN IMMEDIATE; ROLLBACK;")
    return "free"
  } catch {
    return "held"
  } finally {
    db.close()
  }
}

const clientLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(NodeSocket.layerNet({ path: sockPath })),
  Layer.provide(RpcSerialization.layerNdjson)
)

const headers = (): Record<string, string> => {
  const h: Record<string, string> = { "chad-version": process.env.CHAD_PROTO_VERSION ?? VERSION }
  if (process.env.CHAD_SESSION) h["chad-session"] = process.env.CHAD_SESSION
  return h
}

type Client = Effect.Success<ReturnType<typeof makeClient>>
const makeClient = () => RpcClient.make(ChadRpcs)

// lock free -> no daemon (4). lock held + no pong in 2s -> starting or frozen (4).
const withDaemon = <E>(command: string, f: (client: Client) => Effect.Effect<void, E, any>) =>
  Effect.gen(function* () {
    if (lockState() === "free") {
      return yield* finish(4, `chad ${command}: no daemon (lock ${lockPath} is free)`)
    }
    const client = yield* makeClient()
    const pong = yield* client.Ping().pipe(Effect.timeoutOption("2 seconds"), Effect.catchCause(() => Effect.succeed({ _tag: "None" } as const)))
    if (pong._tag === "None") {
      return yield* finish(4, `chad ${command}: daemon is starting or frozen (lock held, no answer on ${sockPath} in 2s)`)
    }
    yield* f(client).pipe(
      Effect.catchCause((cause) => {
        const err: any = Cause.squash(cause)
        if (err?._tag === "Refused") {
          return finish(err.reason === "owner" ? 3 : 1, `chad ${command}: refused by daemon: ${err.message}`)
        }
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        return finish(1, `chad ${command}: failed: ${String(err?.message ?? err)}`)
      })
    )
  }).pipe(RpcClient.withHeaders(headers()), Effect.scoped, Effect.provide(clientLayer))

// Owner commands are refused inside an agent session, before anything else happens.
const ownerOnly = (command: string, effect: Effect.Effect<void, any, any>) =>
  Effect.suspend(() => {
    const session = process.env.CHAD_SESSION
    if (session && process.env.CHAD_PROTO_SKIP_LOCAL_CHECK !== "1") {
      return finish(3, `chad ${command}: refused: '${command}' is an owner command and this shell belongs to agent session ${session}`)
    }
    return effect
  })

const printLines = (stream: Stream.Stream<string, any, any>) =>
  Stream.runForEach(stream, (line) => Effect.sync(() => console.log(`${ts()} [cli ${process.pid}] ${line}`)))

const health = Command.make("health", {}, () =>
  withDaemon("health", () => finish(0, "healthy: lock held and daemon answered ping"))
)
const status = Command.make("status", {}, () =>
  withDaemon("status", (c) => Effect.flatMap(c.Status(), (s) => finish(0, JSON.stringify(s))))
)
const tail = Command.make(
  "tail",
  { count: Flag.Int("count").pipe(Flag.withDefault(5)), interval: Flag.Int("interval").pipe(Flag.withDefault(400)) },
  ({ count, interval }) => withDaemon("tail", (c) => printLines(c.Tail({ count, intervalMs: interval })))
)
const apply = Command.make(
  "apply",
  {
    label: Flag.String("label").pipe(Flag.withDefault("cfg")),
    load: Flag.Int("load").pipe(Flag.withDefault(1000)),
    swapDelay: Flag.Int("swap-delay").pipe(Flag.withDefault(0))
  },
  ({ label, load, swapDelay }) =>
    withDaemon("apply", (c) => printLines(c.Apply({ label, loadMs: load, swapDelayMs: swapDelay })))
)
const reload = Command.make("reload", {}, () =>
  ownerOnly(
    "reload",
    withDaemon("reload", (c) => Effect.flatMap(c.Reload(), (s) => finish(0, s)))
  )
)

// J: secret from a hidden prompt (terminal) or from stdin (--secret-stdin). Our own check
// names the flag when there is neither.
const readStdin = Effect.promise(async () => {
  let s = ""
  for await (const chunk of process.stdin) s += chunk
  return s.replace(/\n$/, "")
})
const describe = (secret: string) =>
  `got secret: length ${secret.length}, sha256 ${crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12)}`
const secretSet = Command.make("secret-set", { stdin: Flag.Boolean("secret-stdin").pipe(Flag.withDefault(false)) }, ({ stdin }) =>
  ownerOnly(
    "secret-set",
    Effect.gen(function* () {
      if (stdin) return yield* finish(0, describe(yield* readStdin))
      if (!process.stdin.isTTY) {
        return yield* finish(2, "chad secret-set: no terminal to prompt on; pipe the secret and pass --secret-stdin")
      }
      const secret = yield* Prompt.run(Prompt.Hidden({ message: "secret" }))
      return yield* finish(0, describe(Redacted.value(secret)))
    })
  )
)
// What effect/cli does on its own: a flag with a prompt fallback, no check of ours.
const secretRaw = Command.make(
  "secret-raw",
  { token: Flag.Redacted("token").pipe(Flag.withFallbackPrompt(Prompt.Hidden({ message: "token" }))) },
  ({ token }) => finish(0, describe(Redacted.value(token)))
)
const serveCmd = Command.make(
  "serve",
  { listenDelay: Flag.Int("listen-delay").pipe(Flag.withDefault(0)), keepStaleSocket: Flag.Boolean("keep-stale-socket").pipe(Flag.withDefault(false)) },
  serve
)

const root = Command.make("chad").pipe(
  Command.withSubcommands([serveCmd, health, status, tail, apply, reload, secretSet, secretRaw])
)

const main = Command.run(root, { version: VERSION }).pipe(
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      if (Cause.hasInterruptsOnly(cause)) {
        exitCode = 130
        return
      }
      const err: any = Cause.squash(cause)
      if (process.env.CHAD_PROTO_DEBUG) console.error("main failed:", err)
      // effect/cli has already printed its own usage error
      exitCode = String(err?._tag ?? "").length > 0 && exitCode === 0 ? 2 : exitCode || 1
    })
  ),
  Effect.provide(NodeServices.layer)
)

if (process.env.CHAD_PROTO_DEBUG) {
  process.on("exit", (code) => console.error(`${ts()} [debug] process exit event: code=${code} exitCode var=${exitCode}`))
}

NodeRuntime.runMain(main as Effect.Effect<void>, {
  disableErrorReporting: true,
  teardown: (exit, onExit) => {
    if (process.env.CHAD_PROTO_DEBUG) console.error(`${ts()} [debug] teardown: main fiber exit=${exit._tag} exitCode var=${exitCode}`)
    onExit(Exit.isFailure(exit) && exitCode === 0 ? 130 : exitCode)
  }
})
