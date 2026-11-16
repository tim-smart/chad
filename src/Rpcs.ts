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

/** What "Recent" in `chad status` shows, or why the daemon could not read it. */
export const Recent = Schema.Union([
  Schema.Struct({
    /** The failed turns of the last 24 hours, as a count for each reason, the most first. */
    failed: Schema.Array(
      Schema.Struct({ reason: Schema.String, count: Schema.Number }),
    ),
    /** The last five failed turns, the latest first. */
    last: Schema.Array(
      Schema.Struct({
        turn: Schema.String,
        reason: Schema.String,
        at: Schema.Number,
      }),
    ),
    /** The tokens in and out of the turns that started today and in the last 7 days. */
    today: Schema.Number,
    week: Schema.Number,
  }),
  Schema.Struct({ unavailable: Schema.String }),
])
export type Recent = typeof Recent.Type

/** The login state `chad status` shows beside the model (CLI-125). */
export const LoginState = Schema.Literals([
  "logged-in",
  "logged-out",
  "pending",
  "not-needed",
])
export type LoginState = typeof LoginState.Type

/** The main model in force and its login state (CLI-125). */
export const ModelState = Schema.Struct({
  spec: Schema.String,
  login: LoginState,
})
export type ModelState = typeof ModelState.Type

/**
 * One key of a plugin's settings listing: its path, where its value came from, and whether it was read at load or at
 * call time. It never holds a value (SET-71, SET-72, SET-94).
 */
export const SettingItem = Schema.Struct({
  key: Schema.String,
  sources: Schema.Array(
    Schema.Union([
      Schema.Struct({ from: Schema.Literals(["file", "default"]) }),
      Schema.Struct({
        from: Schema.Literals(["store", "env", "inline"]),
        name: Schema.String,
      }),
    ]),
  ),
  at: Schema.Literals(["load", "call"]),
})
export type SettingItem = typeof SettingItem.Type

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
  /** When the daemon started, in milliseconds since the epoch. A daemon before the `failures` slice sends none. */
  started: Schema.optionalKey(Schema.Number),
  /** The "Problems" block: each standing condition once, from what the daemon holds without the database (FAIL-112). */
  problems: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The "Recent" block, from the `turns` table, or why it could not be read (FAIL-114). */
  recent: Schema.optionalKey(Recent),
  /** The main model and the login state, once the models are loaded (CLI-125). */
  model: Schema.optionalKey(ModelState),
  /** Each loaded plugin's count of warnings and errors since it loaded, with the latest of those lines (FAIL-117). */
  plugins: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        warnings: Schema.Number,
        errors: Schema.Number,
        latest: Schema.optionalKey(Schema.String),
        /** The mark of a plugin that kept its running version (SWAP-141, SWAP-142). */
        previous: Schema.optionalKey(Schema.String),
        /** The keys it read at load and since, with no value (SET-70, SET-94). */
        settings: Schema.optionalKey(Schema.Array(SettingItem)),
      }),
    ),
  ),
  /** The plugins the applied `chad.json` turns off (SET-34). */
  off: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Safe mode and what turned it on, the applied commit and whether `work/` holds a draft (CLI-125b to CLI-125d). */
  repository: Schema.optionalKey(
    Schema.Struct({
      safe: Schema.Literals(["off", "variable", "toggle"]),
      applied: Schema.optional(
        Schema.Struct({ commit: Schema.String, message: Schema.String }),
      ),
      draft: Schema.optional(Schema.Boolean),
    }),
  ),
  /** Each plugin skipped at boot, with the first line of why (CLI-125). */
  skipped: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
  ),
  /** Each MCP server, with its tool count or the first line of its error (CLI-125f). */
  mcp: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        state: Schema.Literals(["connected", "failed", "starting"]),
        tools: Schema.optionalKey(Schema.Number),
        error: Schema.optionalKey(Schema.String),
      }),
    ),
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

/** What a `chad login` through the daemon hears: the code to show, then how it ended (MOD-55, MOD-56, MOD-107). */
export const LoginEvent = Schema.Union([
  Schema.TaggedStruct("Code", {
    verifyUrl: Schema.String,
    code: Schema.String,
  }),
  Schema.TaggedStruct("Ended", {
    outcome: Schema.Literals(["logged-in", "already", "not-needed"]),
    /** The model in force. */
    spec: Schema.String,
  }),
])
export type LoginEvent = typeof LoginEvent.Type

/** A login the daemon ran that did not complete, with the reason a waiting turn gets too (MOD-75, MOD-76). */
export class LoginFailed extends Schema.TaggedError<LoginFailed>(
  "chad/Rpcs/LoginFailed",
)("LoginFailed", {
  reason: Schema.Literals([
    "TimedOut",
    "DeviceFlowFailed",
    "TokenExchangeFailed",
    "RefreshFailed",
  ]),
}) {}

/** What `chad model` asks for: a missing field is left as it is, and `null` clears an override (MOD-82, MOD-83). */
export const ModelRequest = Schema.Struct({
  main: Schema.optionalKey(Schema.String),
  subagent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  summarizer: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

/** What a `chad model` through the daemon hears: the code of a login it needs, then what it prints (MOD-92). */
export const ModelEvent = Schema.Union([
  Schema.TaggedStruct("Code", {
    verifyUrl: Schema.String,
    code: Schema.String,
  }),
  Schema.TaggedStruct("Ended", { text: Schema.String }),
])
export type ModelEvent = typeof ModelEvent.Type

/** A change the daemon stored nothing of, with what the CLI prints (MOD-16, MOD-124). */
export class ModelUnchanged extends Schema.TaggedError<ModelUnchanged>(
  "chad/Rpcs/ModelUnchanged",
)("ModelUnchanged", { text: Schema.String }) {}

/** What `chad apply`, `check`, `revert`, `safe`, `plugin reload`, `plugin purge`, `timezone` and `secret set` and `rm` ask the daemon for. */
export const RepoRequest = Schema.Union([
  Schema.TaggedStruct("Apply", { message: Schema.String }),
  Schema.TaggedStruct("Check", {}),
  Schema.TaggedStruct("Revert", { commit: Schema.UndefinedOr(Schema.String) }),
  Schema.TaggedStruct("Safe", {
    to: Schema.UndefinedOr(Schema.Literals(["on", "off"])),
  }),
  Schema.TaggedStruct("Reload", { name: Schema.String }),
  Schema.TaggedStruct("Timezone", { zone: Schema.String }),
  /**
   * `chad secret set`, the one request that carries a value to the daemon. What comes back is the printed lines, which
   * hold names and flags and never the value (CRED-25, CRED-81). A missing note keeps the stored one and `""` clears it.
   */
  Schema.TaggedStruct("SecretSet", {
    name: Schema.String,
    value: Schema.String,
    note: Schema.UndefinedOr(Schema.String),
  }),
  Schema.TaggedStruct("SecretRm", { name: Schema.String }),
  Schema.TaggedStruct("Purge", { name: Schema.String }),
  /** `chad mcp restart` (MCP-39, MCP-42). */
  Schema.TaggedStruct("McpRestart", {}),
])
export type RepoRequest = typeof RepoRequest.Type

/** What such a command hears: that it waits behind another command, then what it prints and its exit code (CLI-40). */
export const RepoEvent = Schema.Union([
  Schema.TaggedStruct("Waiting", { text: Schema.String }),
  /** Lines printed before the command ends, as an apply's commit line before it waits for the MCP rebuild (MCP-112). */
  Schema.TaggedStruct("Printed", { stdout: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Ended", {
    stdout: Schema.Array(Schema.String),
    stderr: Schema.Array(Schema.String),
    code: Schema.Literals([0, 1]),
  }),
])
export type RepoEvent = typeof RepoEvent.Type

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
  /** `chad login`. It takes no place in the queue (CLI-159), and the daemon's timeout is its only one (MOD-59). */
  Rpc.make("Login", { success: LoginEvent, error: LoginFailed, stream: true }),
  /** `chad logout`, which says whether the model in force needs the login. */
  Rpc.make("Logout", { success: Schema.Struct({ spec: Schema.String }) }),
  /** `chad model`. It takes no place in the queue (CLI-159), and a killed CLI ends its change before the store. */
  Rpc.make("Model", {
    payload: { request: ModelRequest },
    success: ModelEvent,
    error: ModelUnchanged,
    stream: true,
  }),
  /**
   * The commands that change what is loaded from the repo, which run one at a time in the queue (SWAP-40). From an
   * apply's commit on, a CLI that goes away no longer stops it (CLI-43).
   */
  Rpc.make("Repository", {
    payload: { request: RepoRequest },
    success: RepoEvent,
    stream: true,
  }),
).middleware(VersionCheck)

export const Rpcs = OpenRpcs.merge(checked)
