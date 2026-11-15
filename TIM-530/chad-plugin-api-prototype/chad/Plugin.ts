// PROTOTYPE for TIM-530. Throwaway. Types only, no implementation.
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import type { Chat } from "effect/chat"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import type * as KeyValueStore from "effect/persistence/KeyValueStore"
import type * as HttpClient from "effect/http/HttpClient"
import type { CurrentSession, Session, SessionEvent, Turn, TurnEnded } from "./Session.ts"
import type { Turns } from "./Turns.ts"

/**
 * A plugin file's default export is a Layer that provides nothing and needs
 * only what chad supplies. The functions below each return a Layer that
 * registers one contribution. A plugin gives them its own services with
 * `Layer.provide` and combines them with `Plugin.make`.
 *
 * chad builds the Layer once, in a scope of its own, when the plugin is
 * loaded. Unloading or reloading closes that scope, which removes what the
 * plugin registered, runs its finalizers and interrupts its scoped fibers.
 * If the build fails, the load fails and nothing it registered is kept.
 *
 * The plugin's name is its file or directory name in the data volume.
 */
export type Plugin<E = unknown> = Layer.Layer<never, E, Services>

/** What chad supplies to a plugin's Layer. */
export type Services =
  | PluginContext
  | Turns
  | Chat.Chat
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path

/**
 * `Layer.mergeAll`, with one more check: every Layer may need only what chad
 * supplies. A Layer that still needs one of the plugin's own services, a
 * tool's handlers or a tool dependency does not compile.
 *
 * It takes one Layer too, so it also works as the last step of a pipe.
 */
export declare const make: <
  Layers extends [Layer.Layer<never, any, Services>, ...Array<Layer.Layer<never, any, Services>>]
>(...layers: Layers) => Plugin<Layer.Error<Layers[number]>>

export class PluginContext extends Context.Service<
  PluginContext,
  {
    readonly name: string
    /** A key-value store in chad's SQLite file. Every key is under this plugin's name. */
    readonly store: KeyValueStore.KeyValueStore
  }
>()("chad/Plugin/PluginContext") {}

// Configuration needs no API here. A plugin reads it with Effect's `Config`,
// and chad installs a ConfigProvider scoped to the plugin for the build, so
// `Config.String("url")` reads this plugin's `url`. A secret is
// `Config.Redacted("token")`. A missing value fails the load with a
// ConfigError that names the key.

/**
 * Adds a toolkit to every session's agent. The model calls the tools as
 * functions from its scripts, the way it calls clanka's own tools. The shape
 * follows `McpServer.toolkit`: the handlers come from `toolkit.toLayer`.
 *
 * A tool may list `Session.CurrentSession` in its `dependencies` to learn
 * which session and turn it is running in. chad supplies that per call. Any
 * other dependency has to come from the plugin's own Layers.
 *
 * A tool name that another plugin or clanka already uses fails the load.
 */
export declare const toolkit: <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
) => Layer.Layer<
  never,
  never,
  PluginContext | Tool.HandlersFor<Tools> | Exclude<Tool.HandlerServices<Tools[keyof Tools]>, CurrentSession>
>

export interface HookOptions {
  /**
   * How long chad waits for the hook. A hook that fails, dies or runs past its
   * budget is logged and skipped. The turn carries on without it.
   */
  readonly timeout?: Duration.Input | undefined
}

// A hook may use services. They become requirements of the Layer, so the
// plugin's own Layers have to provide them.

/**
 * A chunk appended to the system prompt. Rendered once when a session starts
 * and again when the plugin is reloaded. An empty string means no chunk.
 * Default budget 2s.
 */
export declare const prompt: <R = never>(
  render: (session: Session) => Effect.Effect<string, unknown, R>,
  options?: HookOptions
) => Layer.Layer<never, never, PluginContext | R>

/**
 * Runs before each turn, on the reply path. A returned string is added to the
 * turn as context for the model. Hooks of different plugins run at the same
 * time. Default budget 5s.
 */
export declare const beforeTurn: <R = never>(
  hook: (turn: Turn) => Effect.Effect<string | void, unknown, R>,
  options?: HookOptions
) => Layer.Layer<never, never, PluginContext | R>

/**
 * Runs after a turn ends, off the reply path. One plugin's calls run one at a
 * time, in the order the turns ended. Default budget 30s.
 */
export declare const afterTurn: <R = never>(
  hook: (ended: TurnEnded) => Effect.Effect<void, unknown, R>,
  options?: HookOptions
) => Layer.Layer<never, never, PluginContext | R>

/**
 * Runs when a session is reset or compacted. Queued with `afterTurn`, so a
 * plugin sees a turn end before the reset that follows it. Default budget 10s.
 */
export declare const onSession: <R = never>(
  hook: (event: SessionEvent) => Effect.Effect<void, unknown, R>,
  options?: HookOptions
) => Layer.Layer<never, never, PluginContext | R>
