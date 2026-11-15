/**
 * What chad posts in chat, its CLI errors and the messages the model reads as tool results. Each template is pinned to
 * the spec's wording by a test, and a scenario refers to a message by its name here.
 */
import * as Connections from "./Connections.ts"

/** The start-up check found no data directory (docs/spec/01-image-and-volume.md, IMG-58). */
export const dataMissing = (data: string) =>
  `chad serve: ${data} does not exist. Mount the data volume there or set CHAD_DATA.`

export interface Ownership {
  readonly uid: number
  readonly gid: number
  /** The mode as octal digits, such as `755`. */
  readonly mode: string
}

/** The start-up check could not write the data directory. */
export const dataNotWritable = (
  data: string,
  self: { readonly uid: number; readonly gid: number },
  owner: Ownership,
) =>
  `chad serve: cannot write ${data}. chad runs as uid ${self.uid}, gid ${self.gid} and ${data} is owned by uid ${owner.uid}, gid ${owner.gid}, mode ${owner.mode}. Give the volume to uid ${self.uid}, for example: chown -R ${self.uid}:${self.gid} <volume>`

/** The start-up check found `repo/` owned by another uid. */
export const repoNotOwned = (repo: string, uid: number, owner: Ownership) =>
  `chad serve: ${repo} is owned by uid ${owner.uid}, gid ${owner.gid}, mode ${owner.mode} and chad runs as uid ${uid}. git refuses a repository owned by another user. Give it to uid ${uid}: chown -R ${uid}:${uid} ${repo}`

/** The shard count guard found a database made with another count (docs/spec/02-storage.md, STO-53). */
export const shardCountChanged = (stored: number, now: number) =>
  `chad serve: this database was made with ${stored} shards and this chad uses ${now}. Messages stored under the old count would never be delivered, so chad will not start.`

/** Another `chad serve` holds the daemon lock on the volume (docs/spec/01-image-and-volume.md, IMG-60). */
export const lockHeld = (data: string) =>
  `chad serve: another chad serve holds the lock on ${data}. This boot is not counted.`

/** The socket path is longer than a unix socket path may be. `chad serve` and the CLI print the same line (IMG-63, CLI-12). */
export const socketPathTooLong = (path: string, bytes: number, limit: number) =>
  `chad serve: the socket path ${path} is ${bytes} bytes and a unix socket path holds ${limit}. Set CHAD_SOCKET to a shorter path, for example /tmp/chad.sock.`

/** The socket could not be created for a reason that is not the filesystem (CLI-213). */
export const socketFailed = (path: string, code: string) =>
  `chad serve: cannot create the socket ${path} (${code}).`

/** The filesystem under the socket's directory cannot hold a unix socket (IMG-63, CLI-213). */
export const socketUnsupported = (
  path: string,
  code: string,
  directory: string,
  type: string,
  data: string,
) =>
  `chad serve: cannot create the socket ${path} (${code}). ${directory} is on ${type}, which cannot hold a unix socket. chad needs a local filesystem under ${data}.`

/** The volume is on a network or FUSE filesystem (IMG-70). */
export const filesystemNetwork = (data: string, type: string) =>
  `${data} is on ${type}. chad needs a local filesystem: SQLite's lock and write-ahead log are not safe on a network or FUSE filesystem.`

/** The volume is on the container's own layer (IMG-70). */
export const filesystemContainer = (data: string) =>
  `${data} is on the container's own filesystem, not on a volume. Everything chad writes is lost when the container is removed. Mount a volume at ${data}.`

/** The volume is on tmpfs or ramfs (IMG-70). */
export const filesystemMemory = (data: string, type: string) =>
  `${data} is on ${type}, which is memory. Everything chad writes is lost when the container stops.`

/** One of `HOME`, `NPM_CONFIG_PREFIX` and `XDG_CACHE_HOME` is on the container's own layer or on tmpfs (IMG-72). */
export const filesystemInstall = (
  name: string,
  value: string,
  where: string,
  data: string,
) =>
  `${name}=${value} is on ${where}, not on the volume at ${data}. What is installed there is lost with the container. In the chad image the volume is mounted at /data.`

/** `chad db query` or `chad db check` found no database file on the volume (docs/spec/02-storage.md). */
export const dbMissing = (command: "query" | "check", path: string) =>
  `chad db ${command}: no database at ${path}`

/** SQLite failed the statement of `chad db query` or `chad db check`. The line carries SQLite's own message. */
export const dbFailed = (command: "query" | "check", message: string) =>
  `chad db ${command}: ${message}`

/** `chad db query` stopped at its row limit and the statement had more rows. */
export const dbMore = (limit: number) =>
  `chad db query: stopped at ${limit} rows and the statement has more. Pass --limit <n> for more rows.`

/** What `--limit` of `chad db query` takes, which the usage error for any other value names. */
export const dbLimit = () => "a whole number from 1 up"

/** A command needs the daemon and the lock is free (docs/spec/10-cli.md). */
export const noDaemon = (command: string, lock: string) =>
  `chad ${command}: no daemon (lock ${lock} is free)`

/** The lock is held and the daemon gave no answer in time (CLI-15). */
export const daemonSilent = (
  command: string,
  socket: string,
  seconds: number,
) =>
  `chad ${command}: daemon is starting or frozen (lock held, no answer on ${socket} in ${seconds}s)`

/** The one line of a `chad health` that passed (CLI-212). */
export const healthy = () => "chad health: ok"

/** The daemon refused a command because the CLI is of another chad version (CLI-22, CLI-214). */
export const versionMismatch = (command: string, cli: string, daemon: string) =>
  `chad ${command}: refused: this CLI is chad ${cli} and the daemon is chad ${daemon}. Run the command with the daemon's own CLI, for example: docker exec -it chad chad ${command}`

/** The CLI refused an owner command because `CHAD_SESSION` is set (CLI-48, CLI-217). */
export const ownerRefused = (command: string, session: string) =>
  `chad ${command}: refused: '${command}' is an owner command and this shell belongs to agent session ${session}. Ask the owner to run it.`

/** The daemon stopped answering in the middle of a command (CLI-218). */
export const daemonGone = (command: string) =>
  `chad ${command}: the daemon went away during the call`

/** A command that writes with no daemon found no data directory (CLI-219). */
export const volumeMissing = (command: string, data: string) =>
  `chad ${command}: ${data} does not exist. Mount the data volume there or set CHAD_DATA.`

/** A CLI that is older than the volume was asked to write with no daemon (CLI-220). */
export const cliOlder = (command: string, cli: string, volume: string) =>
  `chad ${command}: refused: this CLI is chad ${cli} and the volume was written by chad ${volume}. Use a chad of that version or a newer one.`

/** A daemon took the lock while a command that writes with no daemon was at work (CLI-221). */
export const daemonStarted = (command: string) =>
  `chad ${command}: a daemon started during the command, run chad ${command} again`

/** A file the command needs could not be read. `detail` is the error's code (CLI-222). */
export const unreadable = (command: string, path: string, detail: string) =>
  `chad ${command}: cannot read ${path} (${detail})`

/** `secrets/connections.json` holds something else than connections (CLI-222). */
export const malformed = (command: string, path: string) =>
  `chad ${command}: ${path} is not a connections file`

/** The stored connections were written by a newer chad (STO-197). */
export const newerFormat = (
  command: string,
  path: string,
  found: string,
  known: number,
) =>
  `chad ${command}: ${path} has format ${found} and this chad reads format ${known}. Use the chad that wrote it.`

/** No token came on stdin, from the file or from the prompt (CLI-223). */
export const noToken = (command: string) =>
  `chad ${command}: no token was given`

/** The prompt of a token typed at a terminal (CLI-223). */
export const tokenPrompt = () => "Discord bot token"

/**
 * Why a `connection` or `owner` command changed nothing (CLI-224). The reason comes from the store, which the CLI
 * and the daemon share, so the line is the same whichever of them refused. For the two reasons about a file, `name`
 * is the file's path.
 */
export const connectionRejected = (
  command: string,
  rejected: {
    readonly reason: Connections.Reason
    readonly name: string
    readonly detail: string
  },
): string => {
  const { name, detail } = rejected
  switch (rejected.reason) {
    case "name-invalid":
      return `chad ${command}: '${name}' is not a connection name. A name is made of lower-case letters, digits and hyphens.`
    case "name-taken":
      return `chad ${command}: there is already a connection named ${name}`
    case "second-local":
      return `chad ${command}: there is already a local connection, ${name}, and run/local.sock serves one`
    case "no-connection":
      return `chad ${command}: there is no connection named ${name}`
    case "no-token":
      return `chad ${command}: ${name} is a local connection and has no token`
    case "last-connection":
      return `chad ${command}: ${name} is the last connection. Pass --force to remove it.`
    case "last-owner":
      return `chad ${command}: ${detail} is the last owner of ${name}. Pass --force to remove it.`
    case "token-refused":
      return `chad ${command}: Discord refused the token (${detail}). Nothing was changed.`
    case "token-unchecked":
      return `chad ${command}: the token could not be checked (${detail}). Nothing was changed.`
    case "newer-format":
      return newerFormat(command, name, detail, Connections.format)
    case "unreadable":
      return unreadable(command, name, detail)
    case "malformed":
      return malformed(command, name)
  }
}

/** `chad serve` could not use the stored connections (STO-197). */
export const connectionsRefused = (rejected: {
  readonly reason: Connections.Reason
  readonly name: string
  readonly detail: string
}) => connectionRejected("serve", rejected)

/** What a `connection` or `owner` command prints when it has made its change (CLI-225). */
export const connectionAdded = (name: string, kind: string) =>
  `connection ${name} added (${kind})`

/** The invite URL of a Discord connection that was added (CLI-208, CLI-225). */
export const connectionInvite = (url: string) => `invite: ${url}`

/** The privileged intents an invite cannot grant (CLI-209, CLI-225). */
export const connectionIntents = (names: ReadonlyArray<string>) =>
  `intents: turn on ${names.join(", ")} for the bot in the Discord developer portal, because an invite URL cannot grant a privileged intent`

export const connectionToken = (name: string) =>
  `connection ${name} has a new token`

export const connectionRemoved = (name: string) => `connection ${name} removed`

export const ownerAdded = (id: string, connection: string) =>
  `owner ${id} added to ${connection}`

/** An owner change that found nothing to change (CLI-233). */
export const ownerListed = (id: string, connection: string) =>
  `owner ${id} is already an owner of ${connection}`

/** What `chad owner remove` prints when it has made its change (CLI-225). */
export const ownerRemoved = (id: string, connection: string) =>
  `owner ${id} removed from ${connection}`

/** An owner change that found nothing to change (CLI-233). */
export const ownerUnlisted = (id: string, connection: string) =>
  `owner ${id} is not an owner of ${connection}`

/** One line of `chad connection list` (CLI-226). */
export const connectionLine = (
  name: string,
  kind: string,
  owners: ReadonlyArray<string>,
) =>
  `${name} (${kind}) owners: ${owners.length === 0 ? "none" : owners.join(", ")}`

/** What `chad connection list` and `chad connection check` print when nothing is stored (CLI-226). */
export const noConnections = () => "no connections"

/** One line of `chad connection check` (CLI-227). */
export const connectionChecked = (
  name: string,
  kind: string,
  result: Connections.Checked["result"],
  detail: string,
): string => {
  switch (result) {
    case "ok":
      return `${name} (${kind}): ok`
    case "token-refused":
      return `${name} (${kind}): failed: Discord refused the token (${detail})`
    case "token-unchecked":
      return `${name} (${kind}): failed: the token could not be checked (${detail})`
    case "no-platform":
      return `${name} (${kind}): failed: nothing accepts a connection on ${detail}`
  }
}

/** A line of Discord subtext, which is how a notice inside a turn's flow is written. */
const subtext = (line: string) => `-# ${line}`

/** A length of time as a notice shows it: `48s`, and `2m 5s` from a minute on. */
export const duration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** A turn was stopped (docs/spec/04-discord.md, DIS-59). */
export const stopped = (milliseconds: number) =>
  subtext(`Stopped after ${duration(milliseconds)}.`)

/** `/stop` found nothing running (DIS-76). */
export const nothingRunning = () => subtext("Nothing is running.")

/** `/new` started a session (DIS-75). */
export const newSession = () =>
  subtext(
    "New session started. Nothing from the earlier conversation carries over.",
  )

/** `/new` or `/stop` in a plain channel, where there is no session (docs/spec/03-sessions-and-turns.md, SES-148). */
export const noSession = () =>
  subtext(
    "There is no session in this channel. Mention me with a message and I'll open a thread for it.",
  )

/** chad could not open a thread on a mention (DIS-77). It is a normal message. */
export const threadFailed = (reason: string) =>
  `I couldn't open a thread on that message (${reason}). I need Create Public Threads here, or you can DM me.`

/** A size in whole binary megabytes, as a notice shows it. */
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

/** A file over the limit was skipped (DIS-64). */
export const fileSkipped = (name: string, bytes: number) =>
  subtext(`Skipped \`${name}\` (${megabytes(bytes)}). The limit is 25 MB.`)

/** A file could not be downloaded and was skipped. */
export const fileFailed = (name: string) =>
  subtext(`Skipped \`${name}\`. I couldn't download it.`)

/** What `/status` posts: the text of `chad status`, kept as it is. */
export const status = (text: string) => `\`\`\`\n${text}\n\`\`\``

/** The lines a prompt gets about the files on the owner's message. The model reads them. */
export const promptFileSaved = (name: string, path: string) =>
  `The owner attached the file ${name}. It is saved at ${path}.`

export const promptFileSkipped = (name: string, bytes: number) =>
  `The owner attached the file ${name} (${megabytes(bytes)}). It is over the 25 MB limit and was not saved.`

export const promptFileFailed = (name: string) =>
  `The owner attached the file ${name}. It could not be downloaded and was not saved.`
