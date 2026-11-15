import { Effect, Layer, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"
import * as Connections from "./Connections.ts"
import { version } from "./Version.ts"

/**
 * The calls a CLI makes to the daemon over the unix socket. This is the one group both sides import: the daemon
 * serves it and the CLI's client is made from it.
 */

/** The header that carries the chad version of the CLI that makes a call. */
export const versionHeader = "chad-version"

/** The header that carries the `CHAD_SESSION` of the CLI that makes a call, when it has one. */
export const sessionHeader = "chad-session"

/** The phase of a boot, as `chad status` names it. */
export const Phase = Schema.Literals([
  "starting",
  "listening",
  "database",
  "loading",
  "ready",
  "stopping",
])
export type Phase = typeof Phase.Type

/** What the daemon knows about itself, which is what `chad status` prints when the daemon answers. */
export const Report = Schema.Struct({
  /** The daemon's chad version. */
  version: Schema.String,
  /** The version of the effect the daemon runs, which is the one plugins are given. */
  effect: Schema.String,
  phase: Phase,
  /** One warning for each path that is on a filesystem chad warns about. */
  filesystem: Schema.Array(Schema.String),
  connections: Schema.Array(
    Schema.Struct({ name: Schema.String, kind: Schema.String }),
  ),
})
export type Report = typeof Report.Type

/** A call the daemon refused because the CLI that made it is of another chad version. */
export class Refused extends Schema.TaggedError<Refused>("chad/Rpcs/Refused")(
  "Refused",
  {
    /** The version the call carried, when it carried one. */
    cli: Schema.NullOr(Schema.String),
    daemon: Schema.String,
  },
) {}

/**
 * The version check. It runs at the start of every call but the two that any version may make, and versions are
 * compared exactly.
 */
export class VersionCheck extends RpcMiddleware.Service<VersionCheck>()(
  "chad/Rpcs/VersionCheck",
  { error: Refused },
) {}

/** The check as the daemon runs it, against the daemon's own version unless a test of the check names another. */
export const layerVersionCheck = (daemon: string = version) =>
  Layer.succeed(VersionCheck, (effect, { headers }) => {
    const cli = headers[versionHeader]
    return cli === daemon
      ? effect
      : Effect.fail(new Refused({ cli: cli ?? null, daemon }))
  })

/** The calls behind `chad health` and `chad status`, which a CLI of any version may make. */
export const OpenRpcs = RpcGroup.make(
  Rpc.make("Ping", { success: Schema.String }),
  Rpc.make("Status", { success: Report }),
)

/**
 * Every other call. A call is declared here, and is then refused to a CLI of another version. No call returns a
 * stored secret: a connection comes back without its token.
 */
const checked = RpcGroup.make(
  /** A `connection` or `owner` command that changes something. */
  Rpc.make("ConnectionChange", {
    payload: { change: Connections.Change },
    success: Connections.Changed,
    error: Connections.Rejected,
  }),
  /** `chad connection list`. */
  Rpc.make("ConnectionList", { success: Schema.Array(Connections.Listed) }),
  /** `chad connection check`, of every connection or of the one that is named. */
  Rpc.make("ConnectionCheck", {
    payload: { name: Schema.optionalKey(Schema.String) },
    success: Schema.Array(Connections.Checked),
    error: Connections.Rejected,
  }),
).middleware(VersionCheck)

export const Rpcs = OpenRpcs.merge(checked)
