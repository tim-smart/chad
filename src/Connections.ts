import { createConnection } from "node:net"
import { dirname, join } from "node:path"
import { Effect, FileSystem, Schema } from "effect"
import type { HttpClient } from "effect/http"
import type { PlatformError } from "effect/PlatformError"
import * as Discord from "./Discord.ts"
import * as Errno from "./Errno.ts"

/**
 * The stored chat connections: the file `secrets/connections.json`, and what a `connection` or `owner` command may
 * do to it. The CLI uses this when no daemon runs and the daemon uses it when one does, so the two never differ on
 * what a command is refused for.
 */

/** The format number this chad writes, and the highest it reads. */
export const format = 1

/** The file, as a path on the volume. */
export const path = (data: string): string =>
  join(data, "secrets/connections.json")

/** The fixed path at which a `local` connection looks for its chat platform. */
export const localSocket = (data: string): string =>
  join(data, "run/local.sock")

export const Kind = Schema.Literals(["discord", "local"])
export type Kind = typeof Kind.Type

/** What a stored chat connection holds. A connection of kind `local` has no token. */
export const Connection = Schema.Struct({
  /** The unique name, which tells two connections of one platform apart. */
  name: Schema.String,
  kind: Kind,
  token: Schema.optionalKey(Schema.String),
  /** The ids of the users who may talk to chad on this connection. */
  owners: Schema.Array(Schema.String),
  /**
   * The ids of the channels in which an owner's message needs no mention, as if it mentioned chad. A connection that
   * has none needs no key, so a file that an older chad wrote reads the same.
   */
  channels: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Connection = typeof Connection.Type

const Stored = Schema.Struct({
  format: Schema.Number,
  connections: Schema.Array(Connection),
})

/** A connection as a command shows it, which is without its token. */
export const Listed = Schema.Struct({
  name: Schema.String,
  kind: Kind,
  owners: Schema.Array(Schema.String),
  channels: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Listed = typeof Listed.Type

export const listed = (
  connections: ReadonlyArray<Connection>,
): ReadonlyArray<Listed> =>
  connections.map(({ name, kind, owners, channels }) =>
    channels === undefined
      ? { name, kind, owners }
      : { name, kind, owners, channels },
  )

/** Why a command was refused or failed. Each reason has one message in the `Messages` module. */
export const Reason = Schema.Literals([
  "name-invalid",
  "name-taken",
  "second-local",
  "no-connection",
  "no-token",
  "last-connection",
  "last-owner",
  "token-refused",
  "token-unchecked",
  "newer-format",
  "unreadable",
  "malformed",
])
export type Reason = typeof Reason.Type

/** A command that changed nothing, with the reason and what the reason's message names. */
export class Rejected extends Schema.TaggedError<Rejected>(
  "chad/Connections/Rejected",
)("Rejected", {
  reason: Reason,
  /** The connection the reason is about. */
  subject: Schema.String,
  /** The owner id, the format number or what went wrong, by the reason. */
  detail: Schema.String,
}) {}

const rejected = (reason: Reason, subject: string, detail = "") =>
  new Rejected({ reason, subject, detail })

/** What a `connection`, `owner` or `channel` command changes. */
export const Change = Schema.Union([
  Schema.TaggedStruct("Add", {
    name: Schema.String,
    kind: Kind,
    token: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("Token", { name: Schema.String, token: Schema.String }),
  Schema.TaggedStruct("Remove", { name: Schema.String, force: Schema.Boolean }),
  Schema.TaggedStruct("OwnerAdd", { name: Schema.String, id: Schema.String }),
  Schema.TaggedStruct("OwnerRemove", {
    name: Schema.String,
    id: Schema.String,
    force: Schema.Boolean,
  }),
  Schema.TaggedStruct("ChannelAdd", { name: Schema.String, id: Schema.String }),
  Schema.TaggedStruct("ChannelRemove", {
    name: Schema.String,
    id: Schema.String,
  }),
])
export type Change = typeof Change.Type

/** The command behind a change, as the CLI's messages and the log name it. */
export const commandOf = (change: Change): string =>
  ({
    Add: "connection add",
    Token: "connection token",
    Remove: "connection remove",
    OwnerAdd: "owner add",
    OwnerRemove: "owner remove",
    ChannelAdd: "channel add",
    ChannelRemove: "channel remove",
  })[change._tag]

/** What a change that was made gives back. */
export const Changed = Schema.Struct({
  /** False for an owner or channel id that was already on the list, or already off it. */
  changed: Schema.Boolean,
  /** The id of the Discord application a checked token belongs to, which the invite URL is made from. */
  application: Schema.optionalKey(Schema.String),
})
export type Changed = typeof Changed.Type

/** One line of `chad connection check`. */
export const Checked = Schema.Struct({
  name: Schema.String,
  kind: Kind,
  /** How the check ended. `no-platform` is a local connection whose socket nothing listens on. */
  result: Schema.Literals([
    "ok",
    "token-refused",
    "token-unchecked",
    "no-platform",
  ]),
  /** What the platform or the socket answered, when the check failed. */
  detail: Schema.String,
  /** The name of the bot a Discord token that passed belongs to, which `chad setup` shows. */
  bot: Schema.optionalKey(Schema.String),
})
export type Checked = typeof Checked.Type

/** A connection's name is made of lower-case letters, digits and hyphens, as a plugin's is. */
export const validName = (name: string): boolean => /^[a-z0-9-]+$/.test(name)

/**
 * Reads the stored connections. A missing file is no connection. A file with a higher format number is refused before
 * anything else of it is read, because a newer chad may have given the list another shape.
 */
export const read = Effect.fnUntraced(function* (
  data: string,
): Effect.fn.Return<
  ReadonlyArray<Connection>,
  Rejected,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem
  const file = path(data)
  const text = yield* fs
    .readFileString(file)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.undefined
          : Effect.fail(rejected("unreadable", file, Errno.code(error))),
      ),
    )
  if (text === undefined) return []
  const json = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => rejected("malformed", file),
  })
  const found = Schema.decodeUnknownOption(
    Schema.Struct({ format: Schema.Number }),
  )(json)
  if (found._tag === "Some" && found.value.format > format) {
    return yield* rejected("newer-format", file, String(found.value.format))
  }
  return yield* Schema.decodeUnknownEffect(Stored)(json).pipe(
    Effect.map((stored) => stored.connections),
    Effect.mapError(() => rejected("malformed", file)),
  )
})

/**
 * Writes the stored connections, by a temporary file and a rename. `secrets/` gets mode 0700 and the file 0600, each
 * by a chmod after it is made, and the process umask is left alone.
 */
export const write = Effect.fnUntraced(function* (
  data: string,
  connections: ReadonlyArray<Connection>,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const target = path(data)
  const directory = dirname(target)
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* fs.chmod(directory, 0o700)
  const temporary = `${target}.${process.pid}.tmp`
  yield* fs.writeFileString(
    temporary,
    JSON.stringify({ format, connections }, null, 2) + "\n",
    { mode: 0o600 },
  )
  yield* fs.chmod(temporary, 0o600)
  yield* fs.rename(temporary, target)
})

/** The list after a change, and whether the change made a difference. It fails with the reason a change is refused for. */
export const apply = (
  connections: ReadonlyArray<Connection>,
  change: Change,
): Effect.Effect<
  {
    readonly connections: ReadonlyArray<Connection>
    readonly changed: boolean
  },
  Rejected
> =>
  Effect.gen(function* () {
    const done = (next: ReadonlyArray<Connection>) => ({
      connections: next,
      changed: true,
    })
    const current = connections.find(({ name }) => name === change.name)
    if (change._tag === "Add") {
      if (!validName(change.name)) {
        return yield* rejected("name-invalid", change.name)
      }
      if (current !== undefined) {
        return yield* rejected("name-taken", change.name)
      }
      const local = connections.find(({ kind }) => kind === "local")
      if (change.kind === "local" && local !== undefined) {
        return yield* rejected("second-local", local.name)
      }
      return done([
        ...connections,
        change.kind === "local"
          ? { name: change.name, kind: change.kind, owners: [] }
          : {
              name: change.name,
              kind: change.kind,
              token: change.token ?? "",
              owners: [],
            },
      ])
    }
    if (current === undefined) {
      return yield* rejected("no-connection", change.name)
    }
    const others = connections.filter((connection) => connection !== current)
    const replaced = (next: Connection) =>
      done(
        connections.map((connection) =>
          connection === current ? next : connection,
        ),
      )
    switch (change._tag) {
      case "Token":
        return current.kind === "local"
          ? yield* rejected("no-token", change.name)
          : replaced({ ...current, token: change.token })
      case "Remove":
        return others.length === 0 && !change.force
          ? yield* rejected("last-connection", change.name)
          : done(others)
      case "OwnerAdd":
        return current.owners.includes(change.id)
          ? { connections, changed: false }
          : replaced({ ...current, owners: [...current.owners, change.id] })
      case "OwnerRemove": {
        if (!current.owners.includes(change.id)) {
          return { connections, changed: false }
        }
        const owners = current.owners.filter((id) => id !== change.id)
        return owners.length === 0 && !change.force
          ? yield* rejected("last-owner", change.name, change.id)
          : replaced({ ...current, owners })
      }
      case "ChannelAdd": {
        const channels = current.channels ?? []
        return channels.includes(change.id)
          ? { connections, changed: false }
          : replaced({ ...current, channels: [...channels, change.id] })
      }
      case "ChannelRemove": {
        const channels = current.channels ?? []
        if (!channels.includes(change.id)) {
          return { connections, changed: false }
        }
        const { channels: _, ...rest } = current
        const left = channels.filter((id) => id !== change.id)
        return replaced(left.length === 0 ? rest : { ...rest, channels: left })
      }
    }
  })

const checkToken = (name: string, token: string) =>
  Discord.checkToken(token).pipe(
    Effect.mapError((error) =>
      rejected(
        error.reason === "refused" ? "token-refused" : "token-unchecked",
        name,
        error.detail,
      ),
    ),
  )

/**
 * What comes before a change takes its place: the change is tried on the list as it stands, so that a change that is
 * refused asks nothing of the platform, and a token is checked against the platform. It gives the application a
 * Discord token belongs to.
 */
export const prepare = Effect.fn("Connections.prepare")(function* (
  connections: ReadonlyArray<Connection>,
  change: Change,
): Effect.fn.Return<
  { readonly application?: string },
  Rejected,
  HttpClient.HttpClient
> {
  yield* apply(connections, change)
  if (change._tag === "Token") {
    return yield* checkToken(change.name, change.token)
  }
  if (change._tag === "Add" && change.kind === "discord") {
    return yield* checkToken(change.name, change.token ?? "")
  }
  return {}
})

/** Whether something accepts a connection on a unix socket, and the error code when nothing does. */
const accepts = (socket: string) =>
  Effect.callback<string | undefined>((resume) => {
    const connection = createConnection({ path: socket })
    connection.once("connect", () => {
      connection.destroy()
      resume(Effect.undefined)
    })
    connection.once("error", (error: NodeJS.ErrnoException) =>
      resume(Effect.succeed(error.code ?? "unknown")),
    )
    return Effect.sync(() => connection.destroy())
  })

/**
 * Checks the stored connections, or the one that is named. A Discord connection's token is checked as a new one is,
 * and a local connection is checked for a platform that accepts a connection on its socket.
 */
export const check = Effect.fn("Connections.check")(function* (
  connections: ReadonlyArray<Connection>,
  data: string,
  name: string | undefined,
) {
  const chosen =
    name === undefined
      ? connections
      : connections.filter((connection) => connection.name === name)
  if (name !== undefined && chosen.length === 0) {
    return yield* rejected("no-connection", name)
  }
  return yield* Effect.forEach(
    chosen,
    Effect.fnUntraced(function* (connection) {
      const line = (
        result: Checked["result"] = "ok",
        detail = "",
      ): Checked => ({
        name: connection.name,
        kind: connection.kind,
        result,
        detail,
      })
      if (connection.kind === "local") {
        const socket = localSocket(data)
        const code = yield* accepts(socket)
        return code === undefined
          ? line()
          : line("no-platform", `${socket}: ${code}`)
      }
      return yield* Discord.checkToken(connection.token ?? "").pipe(
        Effect.map(({ bot }): Checked => ({
          ...line(),
          ...(bot === undefined ? {} : { bot }),
        })),
        Effect.catch((error) =>
          Effect.succeed(line(`token-${error.reason}`, error.detail)),
        ),
      )
    }),
  )
})
