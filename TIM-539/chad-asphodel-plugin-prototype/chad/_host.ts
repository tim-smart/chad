// PROTOTYPE for TIM-539. Throwaway. A stand-in for chad, just enough to run
// a plugin's hooks and tools in the order the map's tickets describe. It is
// not a design for chad. Where it had to pick a behaviour the tickets leave
// open, the comment says so.
import { Plugin, Session } from "chad"
import { Chat } from "effect/chat"
import * as ConfigProvider from "effect/ConfigProvider"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/http/HttpClient"
import { Turns } from "./Turns.ts"

export interface Tools {
  /** Calls a plugin tool the way a script would. Returns what the model would see. */
  readonly call: (name: string, params: unknown) => Effect.Effect<string>
}

export interface AgentRun {
  readonly answer?: string
  readonly stopped?: boolean
  readonly steers?: ReadonlyArray<string>
  readonly compacted?: boolean
  /** The process dies before the turn ends. No hook runs for it. */
  readonly cut?: boolean
}

const say = (line: string) => Effect.sync(() => console.log(`  chad    ${line}`))

export const make = (options: {
  readonly name: string
  readonly plugin: Plugin.Plugin
  readonly http: HttpClient.HttpClient
  readonly owners: ReadonlyArray<string>
  readonly zone: string
  readonly config: Record<string, unknown>
}) =>
  Effect.gen(function*() {
    // chad's SQLite file. It outlives a plugin reload and a restart.
    const sqlite = yield* KeyValueStore.KeyValueStore.pipe(Effect.provide(KeyValueStore.layerMemory))
    const store = KeyValueStore.prefix(sqlite, `${options.name}/`)

    let loaded: { readonly scope: Scope.Closeable; readonly registry: Plugin.Registry } | undefined
    let counter = 0
    /** The chunk text each session last saw. chad keeps this in the `sessions` row. */
    const lastSeen = new Map<string, string>()
    /** Sessions whose system prompt is rendered again on their next turn. */
    const rerender = new Set<string>()
    const current = new Map<string, Ref.Ref<Option.Option<Session.Turn>>>()
    /** afterTurn and onSession calls, off the reply path, in order. */
    const queue: Array<{ readonly label: string; readonly run: Effect.Effect<unknown> }> = []

    const hook = <A>(label: string, effect: Effect.Effect<A, unknown>, timeout: any) =>
      effect.pipe(
        Effect.timeout(timeout),
        Effect.map(Option.some),
        Effect.catchCause((cause) => Effect.as(say(`${label} failed and was skipped: ${String(cause).split("\n")[0]}`), Option.none<A>()))
      )

    const load = Effect.gen(function*() {
      const scope = yield* Scope.make()
      const context: Plugin.PluginContext["Service"] = { name: options.name, store, owners: options.owners }
      const host = Layer.mergeAll(
        Layer.succeed(Plugin.PluginContext, context),
        Layer.succeed(Turns, { start: () => Effect.succeed({ _tag: "Stopped" as const }) }),
        Layer.succeed(Chat.Chat, {} as any),
        Layer.succeed(HttpClient.HttpClient, options.http),
        Layer.succeed(FileSystem.FileSystem, {} as any),
        Layer.succeed(Path.Path, {} as any),
        Layer.succeed(DateTime.CurrentTimeZone, DateTime.zoneMakeNamedUnsafe(options.zone)),
        ConfigProvider.layer(ConfigProvider.fromUnknown(options.config))
      )
      yield* Layer.buildWithScope(Layer.provide(options.plugin, host), scope)
      loaded = { scope, registry: Plugin.registryOf(context) }
      yield* say(`loaded ${options.name}`)
    })

    const unload = Effect.gen(function*() {
      if (!loaded) return
      yield* Scope.close(loaded.scope, Exit.void)
      loaded = undefined
      yield* say(`unloaded ${options.name}`)
    })

    const session = (kind: Session.Session["kind"]): Session.Session => {
      const id = `session-${++counter}`
      current.set(id, Ref.makeUnsafe(Option.none()))
      return { id, kind, thread: { platform: "discord", id: `channel-${counter}` } }
    }

    const callTool = (on: Session.Session, name: string, params: unknown): Effect.Effect<string> => {
      const entry = loaded?.registry.toolkits.find(({ toolkit }) => name in toolkit.tools)
      if (!entry) return Effect.succeed(`no tool named ${name}`)
      return Effect.gen(function*() {
        const handlers = yield* (entry.toolkit as any as Effect.Effect<any>)
        const stream: Stream.Stream<any> = yield* handlers.handle(name, params)
        const results = yield* Stream.runCollect(stream)
        return JSON.stringify((results.at(-1) as any)?.encodedResult)
      }).pipe(
        Effect.provide(entry.context),
        Effect.provideService(Session.CurrentSession, { session: on, turn: Ref.get(current.get(on.id)!) }),
        Effect.catch((error) => Effect.succeed(`FAILED ${JSON.stringify(error)}`)),
        Effect.tap((result) => say(`tool ${name}(${JSON.stringify(params)}) -> ${result}`))
      ) as Effect.Effect<string>
    }

    const turn = (
      on: Session.Session,
      start:
        | { readonly text: string; readonly resume?: Session.Turn }
        | { readonly cron: string },
      agent: (tools: Tools) => Effect.Effect<AgentRun>
    ) =>
      Effect.gen(function*() {
        const registry = loaded!.registry
        const now = yield* DateTime.now
        const resume = "text" in start ? start.resume : undefined
        const running: Session.Turn = resume
          ? { ...resume, resumed: true, prompt: "The process restarted while you were working. Side effects of a cut-off script already happened." }
          : {
            id: `turn-${++counter}`,
            session: on,
            startedAt: now,
            resumed: false,
            prompt: "text" in start ? start.text : `Run the job "${start.cron}".`,
            origin: "text" in start
              ? {
                _tag: "Message",
                message: {
                  id: `message-${counter}`,
                  thread: on.thread,
                  author: { id: "1234", name: "Tim", isBot: false, isSelf: false },
                  text: start.text,
                  mentions: [],
                  attachments: [],
                  timestamp: now,
                  raw: null
                }
              }
              : { _tag: "Plugin", plugin: "cron", label: start.cron }
          }
        yield* say(`${running.id} starts in ${on.id}${running.resumed ? " (resumed)" : ""}: ${JSON.stringify(running.prompt.slice(0, 60))}`)

        // 1. Prompt chunks, before every turn (TIM-531 answer 3).
        for (const chunk of registry.prompts) {
          const rendered = yield* hook("prompt", chunk.run(on), chunk.timeout)
          // PROPOSED rule: a failed render keeps what the session last saw.
          const text = Option.getOrElse(rendered, () => lastSeen.get(on.id) ?? "")
          const seen = lastSeen.get(on.id)
          if (seen === undefined) yield* say(`system prompt rendered with the chunk ${JSON.stringify(text)}`)
          else if (rerender.delete(on.id)) yield* say(`system prompt rendered again after the compaction, chunk ${JSON.stringify(text)}`)
          else if (seen !== text) yield* say(`model sees <environment-update> with the chunk ${JSON.stringify(text)}`)
          lastSeen.set(on.id, text)
        }

        // 2. beforeTurn. The stand-in runs it for a resumed turn too and lets
        // the plugin decide. The tickets do not say whether chad does.
        for (const before of registry.beforeTurn) {
          const text = yield* hook("beforeTurn", before.run(running), before.timeout)
          if (Option.isSome(text) && text.value) {
            yield* say(`model sees <plugin-context plugin="${options.name}">${text.value}</plugin-context>`)
          }
        }

        // 3. The agent. Its tools see the running turn through CurrentSession.
        yield* Ref.set(current.get(on.id)!, Option.some(running))
        const run = yield* agent({ call: (name, params) => callTool(on, name, params) })
        yield* Ref.set(current.get(on.id)!, Option.none())
        if (run.cut) {
          yield* say(`${running.id} is cut off`)
          return running
        }

        // 4. afterTurn, then Compacted, queued off the reply path.
        const ended: Session.TurnEnded = {
          turn: running,
          appended: [],
          steers: (run.steers ?? []).map((text) => ({
            ...(running.origin._tag === "Message" ? running.origin.message : ({} as any)),
            id: `message-${++counter}`,
            text
          })),
          outcome: run.stopped ? { _tag: "Stopped" } : { _tag: "Answered", text: run.answer ?? "" }
        }
        yield* say(`${running.id} ends: ${ended.outcome._tag}`)
        for (const after of registry.afterTurn) {
          queue.push({ label: `afterTurn(${running.id})`, run: hook("afterTurn", after.run(ended), after.timeout) })
        }
        if (run.compacted) {
          rerender.add(on.id)
          for (const event of registry.onSession) {
            queue.push({ label: `onSession(Compacted ${on.id})`, run: hook("onSession", event.run({ _tag: "Compacted", session: on }), event.timeout) })
          }
        }
        return running
      })

    /** Runs what is queued off the reply path. A scenario decides when. */
    const drain = Effect.gen(function*() {
      while (queue.length > 0) {
        const next = queue.shift()!
        yield* say(`runs ${next.label}`)
        yield* next.run
      }
    })

    const reset = (previous: Session.Session) =>
      Effect.sync(() => {
        const next = { ...session(previous.kind), thread: previous.thread }
        for (const event of loaded!.registry.onSession) {
          queue.push({
            label: `onSession(Reset ${previous.id} -> ${next.id})`,
            run: hook("onSession", event.run({ _tag: "Reset", previous, session: next }), event.timeout)
          })
        }
        return next
      })

    /** What a restart loses: the plugin's memory and the queue. The store stays. */
    const restart = Effect.gen(function*() {
      queue.length = 0
      yield* unload
      yield* load
    })

    return { load, unload, restart, session, turn, drain, reset, callTool, storeKeys: store.keys }
  })
