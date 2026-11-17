/**
 * The MCP layer. The process has one wrapper around clanka's `McpServers`, which every Agent is handed, and under it
 * one clanka layer at a time, built in a scope of its own and rebuilt whole. Every rebuild takes one path, whatever
 * caused it: the calls in flight are interrupted, the old layer is closed, the new one connects, and once it is current
 * the generation moves so each session rebuilds its Agent on its next turn. A rebuild has no gate, no drain and no
 * held calls.
 */
import * as McpServers from "clanka/McpServers"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Scope,
  Semaphore,
} from "effect"
import * as McpFile from "../McpFile.ts"
import * as Messages from "../Messages.ts"
import type * as Settings from "../Settings.ts"
import * as Logger from "./Logger.ts"
import type * as Notices from "./Notices.ts"

type Handlers = ReturnType<McpServers.McpServers["Service"]["handlers"]>
type OnImage = Parameters<McpServers.McpServers["Service"]["handlers"]>[0]

/** One clanka layer and what chad keeps of it. */
interface Built {
  readonly services: McpServers.McpServers["Service"]
  /** Keeps the values of the layer's `${NAME}`s out of what it says. */
  readonly scrub: (text: string) => string
  /** Each server's name by the identifier its keys carry. */
  readonly names: ReadonlyMap<string, string>
  /** Done when a rebuild starts, which interrupts every call this layer has in flight. */
  readonly restart: Deferred.Deferred<void>
  readonly scope: Scope.Closeable
  open: boolean
}

export interface Mcp {
  /** The wrapper every Agent is handed in place of a layer. */
  readonly servers: McpServers.McpServers["Service"]
  /** Moves each time a new layer becomes current. */
  readonly generation: () => number
  /** The applied `mcp.json` the next rebuild builds, or none in safe mode and when it could not be read. */
  readonly file: () => McpFile.File | undefined
  readonly set: (file: McpFile.File | undefined) => void
  /** A file's servers after expansion, as the next rebuild would build them, which a check reads. */
  readonly resolve: (
    file: McpFile.File,
  ) => Effect.Effect<ReadonlyMap<string, McpFile.Resolved>>
  /**
   * Starts a rebuild in the service's own scope, so a caller that goes away once it has started does not stop it, and
   * gives the wait for it, which gives each server's state once the new layer is current.
   */
  readonly rebuild: Effect.Effect<
    Effect.Effect<ReadonlyArray<Messages.McpServerState>>
  >
  /** A rebuild nothing waits for, as a boot's. */
  readonly start: Effect.Effect<void>
  /** Each server for `chad status`, as its transport is now. */
  readonly report: Effect.Effect<ReadonlyArray<Messages.McpServerState>>
  /** The servers of every layer whose close has not ended, which a stop cut by its deadline names. */
  readonly open: () => ReadonlyArray<string>
  /** A stop abandons a rebuild in progress. */
  readonly abandon: Effect.Effect<void>
}

/** The notice key of an `mcp.json` a boot or `chad safe off` could not read. */
export const unreadableKey = "mcp-unreadable"

/**
 * The applied `mcp.json` as a boot reads it. A file that cannot be read or parsed starts chad with no MCP servers,
 * with a notice, which "Problems" lists, and a log line. No file stops a boot.
 */
export const atBoot = Effect.fnUntraced(function* (
  tree: string | undefined,
  notices: Notices.Notices["Service"],
) {
  const read = yield* McpFile.read(tree)
  if (read._tag === "File") {
    yield* notices.clear(unreadableKey)
    return read.file
  }
  yield* Logger.event(
    "mcp.config-unreadable",
    "mcp.json could not be read at boot",
    { error: read.error },
  )
  yield* notices.raise({
    key: unreadableKey,
    text: Messages.mcpUnreadable(read.error),
  })
  return undefined
})

/** Each server of a layer as clanka sees it now, which a server that exits after connecting changes. */
const states = (
  layer: Built,
): Effect.Effect<ReadonlyArray<Messages.McpServerState>> =>
  Effect.map(layer.services.status, (status) =>
    Object.entries(status).map(([name, server]) =>
      server._tag === "Connected"
        ? { name, state: "connected", tools: server.tools.length }
        : { name, state: "failed", error: layer.scrub(server.error) },
    ),
  )

/** The server and tool identifiers of a key, which clanka writes as `<server>.<tool>`. */
const split = (key: string) => {
  const dot = key.indexOf(".")
  return { server: key.slice(0, dot), tool: key.slice(dot + 1) }
}

export const make = Effect.fnUntraced(function* <E, R>(options: {
  /** The scope the layers are built in, which a stop closes after the plugins'. */
  readonly scope: Scope.Scope
  readonly lookup: Settings.Lookup<E, R>
  /** The daemon's `HOME`, a stdio server's `cwd` when it names none. */
  readonly home: string
}) {
  const context = yield* Effect.context<R>()
  const fibers = yield* FiberSet.make<
    ReadonlyArray<Messages.McpServerState>
  >().pipe(Scope.provide(options.scope))
  const semaphore = yield* Semaphore.make(1)
  let wanted: McpFile.File | undefined
  let current: Built | undefined
  let rebuilding = false
  let generation = 0
  const layers = new Set<Built>()

  const once = Effect.gen(function* () {
    const started = Date.now()
    const file = wanted ?? McpFile.empty
    const resolved = yield* McpFile.resolve(file, options.lookup, options.home)
    rebuilding = true
    // Every call in flight is told at once, and the old layer closes before the new one starts, with no deadline.
    const old = current
    if (old !== undefined) {
      yield* Deferred.succeed(old.restart, undefined)
      yield* Scope.close(old.scope, Exit.void)
      old.open = false
      layers.delete(old)
    }
    const scope = yield* Scope.fork(options.scope)
    const names = new Map<string, string>()
    for (const name of file.keys()) {
      const id = McpServers.identifier(name)
      if (!names.has(id)) names.set(id, name)
    }
    const scrub = McpFile.scrubber(resolved.values())
    const built: Built = {
      services: undefined as never,
      scrub,
      names,
      restart: yield* Deferred.make<void>(),
      scope,
      open: true,
    }
    layers.add(built)
    const services = Context.get(
      yield* Layer.buildWithScope(
        McpServers.layer(
          Object.fromEntries(
            [...resolved].map(([name, { config }]) => [name, config]),
          ),
        ),
        scope,
      ).pipe(Effect.provideService(Logger.Scrub, scrub)),
      McpServers.McpServers,
    )
    const next: Built = Object.assign(built, { services })
    // The new layer is current once clanka has connected it, and sessions follow it on their next turn.
    current = next
    rebuilding = false
    generation++
    const servers = yield* states(next)
    for (const server of servers) {
      if (server.state === "failed")
        yield* Logger.event(
          "mcp.server-failed",
          "An MCP server failed to connect",
          {
            server: server.name,
            error: Messages.firstLine(server.error ?? ""),
          },
        )
    }
    yield* Logger.event("mcp.rebuilt", "The MCP layer was rebuilt", {
      duration_ms: Date.now() - started,
      servers: servers.length,
      connected: servers.filter(({ state }) => state === "connected").length,
      failed: servers.filter(({ state }) => state === "failed").length,
    })
    return servers
  }).pipe(
    (effect) => semaphore.withPermit(effect),
    Effect.provideContext(context),
  )

  const fork = FiberSet.run(fibers, once)

  /** A call by its key, routed to the layer that is current when it is made. */
  const call = (
    key: string,
    params: unknown,
    origin: Built,
    held: ReadonlySet<string>,
    handlersOf: (layer: Built) => Handlers,
  ): Effect.Effect<unknown, string> =>
    Effect.suspend(() => {
      if (rebuilding) return Effect.fail(Messages.mcpRestarting)
      const layer = current
      if (layer === undefined) return Effect.fail(Messages.mcpNotRunning)
      const handlers = handlersOf(layer)
      return Effect.mapError(
        route(key, params, layer, origin, held, handlers),
        layer.scrub,
      )
    })

  const route = (
    key: string,
    params: unknown,
    layer: Built,
    origin: Built,
    held: ReadonlySet<string>,
    handlers: Handlers,
  ): Effect.Effect<unknown, string> => {
    if (key === "searchTools") {
      const search = handlers["searchTools"]
      if (search === undefined)
        return Effect.fail(Messages.mcpNoServerConnected)
      // A tool the current layer has and this turn holds no key for is named, callable from the next turn.
      const fresh = Object.keys(handlers).filter(
        (name) => name !== "searchTools" && !held.has(name),
      )
      return Effect.map(search(params), (result) =>
        fresh.length === 0
          ? result
          : `${String(result)}\n\n${Messages.mcpNextTurn(fresh)}`,
      )
    }
    const handler = handlers[key]
    if (handler !== undefined)
      return Effect.raceFirst(
        handler(params),
        Effect.andThen(
          Deferred.await(layer.restart),
          Effect.fail(Messages.mcpInterrupted(key)),
        ),
      )
    // chad words what the new layer lacks itself, from its config and status.
    const ids = split(key)
    const name = layer.names.get(ids.server)
    if (name === undefined)
      return Effect.fail(
        Messages.mcpRemoved(key, origin.names.get(ids.server) ?? ids.server),
      )
    return Effect.flatMap(layer.services.status, (status) =>
      Effect.fail(
        status[name]?._tag === "Failed"
          ? Messages.mcpNotConnected(key, name, status[name].error)
          : Messages.mcpToolGone(key, name),
      ),
    )
  }

  const servers = McpServers.McpServers.of({
    status: Effect.suspend(
      () => current?.services.status ?? Effect.succeed({}),
    ),
    // clanka reads the prompt section and the declarations once, when an Agent is built. A turn that starts during a
    // rebuild takes those of the last layer that finished connecting, and one before the first layer has none, with
    // `Messages.mcpStarting` in place of the section when servers are on their way.
    get prompt() {
      if (current !== undefined) return current.scrub(current.services.prompt)
      return rebuilding && (wanted?.size ?? 0) > 0 ? Messages.mcpStarting : ""
    },
    get dts() {
      return current?.services.dts ?? ""
    },
    // Asked once per spawn: the keys are those of the current layer, and each call is routed when it is made.
    handlers: (onImage: OnImage) => {
      const origin = current
      if (origin === undefined) return {}
      let cached:
        { readonly layer: Built; readonly handlers: Handlers } | undefined
      const handlersOf = (layer: Built) => {
        if (cached?.layer !== layer)
          cached = { layer, handlers: layer.services.handlers(onImage) }
        return cached.handlers
      }
      const keys = Object.keys(handlersOf(origin))
      const held = new Set(keys)
      return Object.fromEntries(
        keys.map((key) => [
          key,
          (params: unknown) => call(key, params, origin, held, handlersOf),
        ]),
      )
    },
  })

  return {
    servers,
    generation: () => generation,
    file: () => wanted,
    set: (file) => {
      wanted = file
    },
    resolve: (file) =>
      McpFile.resolve(file, options.lookup, options.home).pipe(
        Effect.provideContext(context),
      ),
    // A rebuild a stop abandoned gives nothing to print.
    rebuild: Effect.map(fork, (fiber) =>
      Effect.map(Fiber.await(fiber), (exit) =>
        Exit.isSuccess(exit) ? exit.value : [],
      ),
    ),
    start: Effect.asVoid(fork),
    report: Effect.suspend(
      (): Effect.Effect<ReadonlyArray<Messages.McpServerState>> =>
        rebuilding
          ? Effect.succeed(
              [...(wanted?.keys() ?? [])].map((name) => ({
                name,
                state: "starting" as const,
              })),
            )
          : current === undefined
            ? Effect.succeed([])
            : states(current),
    ),
    open: () =>
      [...layers]
        .filter((layer) => layer.open)
        .flatMap((layer) => [...layer.names.values()]),
    abandon: FiberSet.clear(fibers),
  } satisfies Mcp as Mcp
})
