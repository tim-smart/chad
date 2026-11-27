// What `fillSecret` asks of the daemon: to put a stored secret into a field of a page through the `browse` MCP server,
// with no script, tool or plugin ever holding the value. The daemon (src/daemon/Fill.ts) gives this only to the bundled
// plugins, so a plugin from the repo reads none and its `fillSecret` says it cannot fill.
import { Context, type Effect } from "effect"

/** The field a secret goes into, as browse's `fill` names one. */
export interface Target {
  readonly tab: string | number
  readonly ref?: string | undefined
  readonly selector?: string | undefined
}

export interface Filler {
  /**
   * Fills the field with the stored secret `name` for a session, and gives what browse's `fill` returned, with the
   * value masked. From the fill on, the session's output masks the value.
   */
  readonly fill: (
    session: string,
    name: string,
    target: Target,
  ) => Effect.Effect<unknown, string>
}

/** The daemon's filler, or nothing in a plugin the daemon gives none. */
export const Fill = Context.Reference<Filler | undefined>("chad/daemon/Fill", {
  defaultValue: () => undefined,
})
