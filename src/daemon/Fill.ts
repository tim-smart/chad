// What `fillSecret` does in the daemon: it reads a stored secret, masks it in the session's output, and passes it to
// the `browse` MCP server's `fill` itself, so the value goes from the store to the page and nowhere else. The value is
// masked before the call, so whatever browse or the page says back, a text field's value echoed in a result or an
// error included, reaches the script, the history and the log with `[secret NAME]` in its place (`Once.ts`). What
// browse writes to its stderr, which clanka logs at debug on no session's fiber, is masked by the MCP layer's own
// scrubber, which is given every filled value (`Mcp.ts`).
//
// Nothing checks which site the tab is on: the model picks the tab, as it does for every other fill.
import type * as McpServers from "clanka/McpServers"
import { Effect, FileSystem } from "effect"
import * as Messages from "../Messages.ts"
import type { Filler } from "../plugins/request-secret/Fill.ts"
import * as Secrets from "../Secrets.ts"
import type * as Once from "./Once.ts"

/** The MCP tool a secret goes through, as clanka keys it. */
const key = "browse.fill"

/** A result with every string in it masked, however deep. */
const scrubDeep = (
  value: unknown,
  scrub: (text: string) => string,
): unknown => {
  if (typeof value === "string") return scrub(value)
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub))
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        scrub(name),
        scrubDeep(item, scrub),
      ]),
    )
  return value
}

export const make = (options: {
  readonly data: string
  readonly fs: FileSystem.FileSystem
  readonly once: Once.Daemon
  readonly servers: McpServers.McpServers["Service"]
}): Filler => ({
  fill: Effect.fnUntraced(function* (session, name, target) {
    const store = yield* Secrets.read(options.data).pipe(
      Effect.provideService(FileSystem.FileSystem, options.fs),
      Effect.mapError((error) => Messages.fillStoreBroken(error.message)),
    )
    const value = Object.hasOwn(store, name) ? store[name]?.value : undefined
    if (value === undefined || value === "")
      return yield* Effect.fail(Messages.fillMissing(name))
    const handler = options.servers.handlers(() => Effect.void)[key]
    if (handler === undefined) return yield* Effect.fail(Messages.fillNoBrowse)
    // Masked from here on, before browse can say it back.
    options.once.hide(session, name, value)
    const scrub = (text: string) => options.once.scrub(session, text)
    return yield* handler({ ...target, value }).pipe(
      Effect.map((result) => scrubDeep(result, scrub)),
      Effect.mapError(scrub),
    )
  }),
})
