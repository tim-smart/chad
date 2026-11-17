/**
 * What chad posts in chat, its CLI errors and the messages the model reads as tool results. Each template is pinned to
 * its wording by a test, and a scenario refers to a message by its name here.
 */
import * as BundledNames from "./BundledNames.ts"
import * as Connections from "./Connections.ts"
import type * as Failed from "./daemon/Failed.ts"
import type { Format } from "./daemon/Format.ts"
import type * as Repo from "./Repo.ts"

/** The start-up check found no data directory. */
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

/** The shard count guard found a database made with another count. */
export const shardCountChanged = (stored: number, now: number) =>
  `chad serve: this database was made with ${stored} shards and this chad uses ${now}. Messages stored under the old count would never be delivered, so chad will not start.`

/** Another `chad serve` holds the daemon lock on the volume. */
export const lockHeld = (data: string) =>
  `chad serve: another chad serve holds the lock on ${data}.`

/** The socket path is longer than a unix socket path may be. `chad serve` and the CLI print the same line. */
export const socketPathTooLong = (path: string, bytes: number, limit: number) =>
  `chad serve: the socket path ${path} is ${bytes} bytes and a unix socket path holds ${limit}. Set CHAD_SOCKET to a shorter path, for example /tmp/chad.sock.`

/** The socket could not be created for a reason that is not the filesystem. */
export const socketFailed = (path: string, code: string) =>
  `chad serve: cannot create the socket ${path} (${code}).`

/** The filesystem under the socket's directory cannot hold a unix socket. */
export const socketUnsupported = (
  path: string,
  code: string,
  directory: string,
  type: string,
  data: string,
) =>
  `chad serve: cannot create the socket ${path} (${code}). ${directory} is on ${type}, which cannot hold a unix socket. chad needs a local filesystem under ${data}.`

/** The volume is on a network or FUSE filesystem. */
export const filesystemNetwork = (data: string, type: string) =>
  `${data} is on ${type}. chad needs a local filesystem: SQLite's lock and write-ahead log are not safe on a network or FUSE filesystem.`

/** The volume is on the container's own layer. */
export const filesystemContainer = (data: string) =>
  `${data} is on the container's own filesystem, not on a volume. Everything chad writes is lost when the container is removed. Mount a volume at ${data}.`

/** The volume is on tmpfs or ramfs. */
export const filesystemMemory = (data: string, type: string) =>
  `${data} is on ${type}, which is memory. Everything chad writes is lost when the container stops.`

/** One of `HOME`, `NPM_CONFIG_PREFIX` and `XDG_CACHE_HOME` is on the container's own layer or on tmpfs. */
export const filesystemInstall = (
  name: string,
  value: string,
  where: string,
  data: string,
) =>
  `${name}=${value} is on ${where}, not on the volume at ${data}. What is installed there is lost with the container. In the chad image the volume is mounted at /data.`

/** `chad db query` or `chad db check` found no database file on the volume. */
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

/** What `--level` of `chad logs` takes, which the usage error for any other value names. */
export const logsLevel = () =>
  "one of all, trace, debug, info, warn, error, fatal or none"

/** What `--since` of `chad logs` takes, which the usage error for any other value names. */
export const logsSince = () =>
  "a duration such as 15m or 2h, or an ISO 8601 time"

/** A command needs the daemon and the lock is free. */
export const noDaemon = (command: string, lock: string) =>
  `chad ${command}: no daemon (lock ${lock} is free)`

/** The lock is held and the daemon gave no answer in time. */
export const daemonSilent = (
  command: string,
  socket: string,
  seconds: number,
) =>
  `chad ${command}: daemon is starting or frozen (lock held, no answer on ${socket} in ${seconds}s)`

/** The one line of a `chad health` that passed. */
export const healthy = () => "chad health: ok"

/** The daemon refused a command because the CLI is of another chad version. */
export const versionMismatch = (command: string, cli: string, daemon: string) =>
  `chad ${command}: refused: this CLI is chad ${cli} and the daemon is chad ${daemon}. Run the command with the daemon's own CLI, for example: docker exec -it chad chad ${command}`

/** The CLI refused an owner command because `CHAD_SESSION` is set. */
export const ownerRefused = (command: string, session: string) =>
  `chad ${command}: refused: '${command}' is an owner command and this shell belongs to agent session ${session}. Ask the owner to run it.`

/** The daemon stopped answering in the middle of a command. */
export const daemonGone = (command: string) =>
  `chad ${command}: the daemon went away during the call`

/** A command that writes with no daemon found no data directory. */
export const volumeMissing = (command: string, data: string) =>
  `chad ${command}: ${data} does not exist. Mount the data volume there or set CHAD_DATA.`

/** A CLI that is older than the volume was asked to write with no daemon. */
export const cliOlder = (command: string, cli: string, volume: string) =>
  `chad ${command}: refused: this CLI is chad ${cli} and the volume was written by chad ${volume}. Use a chad of that version or a newer one.`

/** A daemon took the lock while a command that writes with no daemon was at work. */
export const daemonStarted = (command: string) =>
  `chad ${command}: a daemon started during the command, run chad ${command} again`

/** A file the command needs could not be read. `detail` is the error's code. */
export const unreadable = (command: string, path: string, detail: string) =>
  `chad ${command}: cannot read ${path} (${detail})`

/** `secrets/connections.json` holds something else than connections. */
export const malformed = (command: string, path: string) =>
  `chad ${command}: ${path} is not a connections file`

/** The stored connections were written by a newer chad. */
export const newerFormat = (
  command: string,
  path: string,
  found: string,
  known: number,
) =>
  `chad ${command}: ${path} has format ${found} and this chad reads format ${known}. Use the chad that wrote it.`

/** No token came on stdin, from the file or from the prompt. */
export const noToken = (command: string) =>
  `chad ${command}: no token was given`

/** The prompt of a token typed at a terminal. */
export const tokenPrompt = () => "Discord bot token"

/**
 * Why a `connection` or `owner` command changed nothing. The reason comes from the store, which the CLI
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

/** `chad serve` could not use the stored connections. */
export const connectionsRefused = (rejected: {
  readonly reason: Connections.Reason
  readonly name: string
  readonly detail: string
}) => connectionRejected("serve", rejected)

/** What a `connection`, `owner` or `channel` command prints when it has made its change. */
export const connectionAdded = (name: string, kind: string) =>
  `connection ${name} added (${kind})`

/** The invite URL of a Discord connection that was added. */
export const connectionInvite = (url: string) => `invite: ${url}`

/** The privileged intents an invite cannot grant. */
export const connectionIntents = (names: ReadonlyArray<string>) =>
  `intents: turn on ${names.join(", ")} for the bot in the Discord developer portal, because an invite URL cannot grant a privileged intent`

export const connectionToken = (name: string) =>
  `connection ${name} has a new token`

export const connectionRemoved = (name: string) => `connection ${name} removed`

export const ownerAdded = (id: string, connection: string) =>
  `owner ${id} added to ${connection}`

/** An owner change that found nothing to change. */
export const ownerListed = (id: string, connection: string) =>
  `owner ${id} is already an owner of ${connection}`

/** What `chad owner remove` prints when it has made its change. */
export const ownerRemoved = (id: string, connection: string) =>
  `owner ${id} removed from ${connection}`

/** An owner change that found nothing to change. */
export const ownerUnlisted = (id: string, connection: string) =>
  `owner ${id} is not an owner of ${connection}`

/** What `chad channel add` prints when it has made its change. */
export const channelAdded = (id: string, connection: string) =>
  `channel ${id} on ${connection} needs no mention now`

/** A channel change that found nothing to change. */
export const channelListed = (id: string, connection: string) =>
  `channel ${id} on ${connection} already needs no mention`

/** What `chad channel remove` prints when it has made its change. */
export const channelRemoved = (id: string, connection: string) =>
  `channel ${id} on ${connection} needs a mention again`

/** A channel change that found nothing to change. */
export const channelUnlisted = (id: string, connection: string) =>
  `channel ${id} on ${connection} is not on the list of channels that need no mention`

/** One line of `chad connection list`. A connection with channels that need no mention names them too. */
export const connectionLine = (
  name: string,
  kind: string,
  owners: ReadonlyArray<string>,
  channels: ReadonlyArray<string> = [],
) =>
  `${name} (${kind}) owners: ${owners.length === 0 ? "none" : owners.join(", ")}` +
  (channels.length === 0
    ? ""
    : `, channels without a mention: ${channels.join(", ")}`)

/** What `chad connection list` and `chad connection check` print when nothing is stored. */
export const noConnections = () => "no connections"

/** One line of `chad connection check`. */
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

/** A length of time as a notice shows it: `48s`, and `2m 5s` from a minute on. */
export const duration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** A turn was stopped. */
export const stopped = (format: Format, milliseconds: number) =>
  format.subtext(`Stopped after ${duration(milliseconds)}.`)

/**
 * The prompt of a turn that a restart cut, which a resumed start sends in place of the owner's message
 *. The model reads it, and the owner never sees it.
 */
export const restartNote = () =>
  "[chad restarted while this turn was running. A script that was cut off may already have had its side effects. Check before you repeat anything, then finish the request above.]"

/** The line every failed-turn message and the give-up message end with, as the formatter's subtext. */
export const turnLine = (format: Format, turn: string) =>
  format.subtext(
    `Turn ${turn}. \`chad logs --turn ${turn}\` shows what it did.`,
  )

/** chad gave up on a turn that two kills cut. */
export const gaveUp = (format: Format, turn: string) =>
  `This turn was cut off by a crash twice, so I've stopped retrying it. Whatever its scripts already did is done. Send a message to carry on.\n${turnLine(format, turn)}`

/** The most of an action's text that its line in the status message shows. */
const statusLineChars = 120

/** How many actions the status message shows, the newest last. */
export const statusActions = 5

/** An action's text cut to its first line and to `statusLineChars`, with the cut marked. */
const oneLine = (text: string) => {
  const trimmed = text.trim()
  const points = Array.from(trimmed.split("\n", 1)[0] ?? "")
  const cut = points.length > statusLineChars || trimmed.includes("\n")
  return points.slice(0, statusLineChars).join("").trimEnd() + (cut ? "…" : "")
}

/** A code span around text that may hold a backtick of its own. */
const codeSpan = (text: string) =>
  text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``

/**
 * The status message: a header with the turn's start as the formatter's relative time, and the last actions, each as
 * its subtext.
 */
export const statusMessage = (
  format: Format,
  at: number,
  lines: ReadonlyArray<string>,
) =>
  [
    format.subtext(`Working, started ${format.relativeTime(at)}`),
    ...lines.slice(-statusActions).map((line) => format.subtext(line)),
  ].join("\n")

/** A script's line in the status message: the script's own source, cut. */
export const statusScript = (source: string) => {
  const line = oneLine(source)
  return line.endsWith("…") ? `${codeSpan(line.slice(0, -1))}…` : codeSpan(line)
}

/** A sub-agent's line in the status message: the start of its prompt. */
export const statusSubagent = (prompt: string) =>
  `Sub-agent: ${oneLine(prompt)}`

/** A compaction's line in the status message. */
export const statusCompaction = () => "Compacted the history"

/** The line of a model error clanka retries: its cause and the count of the turn's retries so far. */
export const statusRetry = (cause: string, retry: number) =>
  `Model error (${cause}), retrying (${retry} so far in this turn)`

/** The line of a steering message the agent has read: its first 60 characters, on one line. */
export const statusRead = (text: string) =>
  `Read your message: ${Array.from(text.trim().replace(/\s+/g, " ")).slice(0, 60).join("")}`

/** The line of a turn that is resumed after a restart. */
export const statusRestarted = () => "Restarted mid-turn, picking it back up."

/** The first line of an error's text, cut at 200 characters, because a provider's message can be a page of JSON. */
export const firstLine = (text: string): string =>
  (text.trim().split("\n", 1)[0] ?? "").trim().slice(0, 200)

/** The reasons whose failed turn posts the failed-turn message, and what that message says of each. */
export type Posted = Extract<
  Failed.Reason,
  { readonly _tag: "ModelError" | "Internal" | "LoginFailed" | "UsageLimit" }
>

/** The reason of a turn chad ended at the silence bound. */
export const silenceReason = "the model did not answer for 15 minutes"

const failedReason = (
  reason: Extract<Posted, { readonly _tag: "ModelError" | "Internal" }>,
) =>
  reason._tag === "Internal"
    ? `chad hit an error (${firstLine(reason.message)})`
    : reason.reason === "TurnTimeout"
      ? silenceReason
      : reason.retries === 0
        ? `the model request failed (${reason.reason}: ${firstLine(reason.message)})`
        : `the model kept failing after ${reason.retries} retries (${reason.reason}: ${firstLine(reason.message)})`

/**
 * The message of a turn that hit the usage limit, in place of the failed-turn message. The reset time is a timestamp
 * of the platform, which takes seconds, and it is left out when the error carried none.
 */
export const usageLimitReached = (format: Format, resetsAt?: number) =>
  `You've reached the usage limit on this login.${resetsAt === undefined ? "" : ` It resets ${format.relativeTime(resetsAt)}.`} Wait, or move to another provider with \`/model\`.`

/**
 * The text of the `usage-limit` row, which its notice and its line under "Problems" both print. The reset time is in
 * UTC to the second, as the line's recorded time is.
 */
export const usageLimitNotice = (resetsAt?: number) =>
  `This login has reached its usage limit. Scheduled runs are skipped until it resets.${resetsAt === undefined ? "" : ` It resets at ${new Date(resetsAt).toISOString().slice(0, 19)}Z.`}`

/**
 * A failed turn, as a normal message in its thread. A failed login and a usage limit have their own messages in place
 * of it.
 */
export const failedTurn = (
  format: Format,
  milliseconds: number,
  reason: Posted,
  turn: string,
) =>
  reason._tag === "UsageLimit"
    ? usageLimitReached(format, reason.resetsAt)
    : reason._tag === "LoginFailed"
      ? reason.reason === "TimedOut"
        ? loginTimedOut
        : loginFailed(reason.reason)
      : `That turn failed after ${duration(milliseconds)}: ${failedReason(reason)}. The conversation is intact, send a message to carry on.\n${turnLine(format, turn)}`

/** One line of `session_updates`, as the update message reads it. */
export type Update =
  | {
      readonly turn: string
      /** How the turn ended. An `answered` line is an answer that could not be posted. */
      readonly outcome: "answered" | "failed" | "stopped"
      /** The reason's tag, on a failed turn's line. */
      readonly failure?: string | undefined
    }
  | { readonly notice: string; readonly text: string }

type TurnUpdate = Extract<Update, { readonly turn: string }>

const endedAs = (line: TurnUpdate) =>
  line.outcome === "answered"
    ? "answered, but the answer could not be posted in the thread, so the owner has not read it"
    : line.outcome === "stopped"
      ? "was stopped, and chad posted that in the thread"
      : `failed with ${line.failure ?? "Internal"}, and chad posted that in the thread in place of an answer`

const counted = (line: TurnUpdate, count: number) =>
  line.outcome === "answered"
    ? `${count} ${count === 1 ? "answer" : "answers"} could not be posted`
    : line.outcome === "stopped"
      ? `${count} ${count === 1 ? "turn was" : "turns were"} stopped`
      : `${count} ${count === 1 ? "turn" : "turns"} failed with ${line.failure ?? "Internal"}`

/** Whether a step was running when the turn ended, which a stop, a give-up and a defect cut. */
const cut = (line: TurnUpdate) =>
  line.outcome === "stopped" ||
  (line.outcome === "failed" &&
    (line.failure === "GaveUp" || line.failure === "Internal"))

/**
 * The update message that tells the model what chad posted in the session's thread since the last turn it answered
 * and the owner read. It is clanka's `<environment-update>` form, which a compaction
 * drops. Nothing is sent when there is no line.
 */
export const update = (lines: ReadonlyArray<Update>): string | undefined => {
  const body = updateBody(lines)
  return body === undefined ? undefined : environmentUpdate([body])
}

/** One `<environment-update>` message of several sections, which a compaction drops. */
export const environmentUpdate = (sections: ReadonlyArray<string>) =>
  `<environment-update>\n${sections.join("\n\n")}\n</environment-update>`

/** The section of the update message that tells what chad posted in the thread, or nothing when there is no line. */
export const updateBody = (
  lines: ReadonlyArray<Update>,
): string | undefined => {
  const turns = lines.filter((line): line is TurnUpdate => "turn" in line)
  const notices = lines.filter(
    (line): line is Exclude<Update, TurnUpdate> => !("turn" in line),
  )
  if (turns.length === 0 && notices.length === 0) return undefined
  const body: Array<string> = []
  const latest = turns.at(-1)
  if (latest !== undefined) {
    body.push(`Your last turn, ${latest.turn}, ${endedAs(latest)}.`)
    if (cut(latest)) {
      body.push(
        "The steps before the cut are in the history above. The step that was running was cut and may have partly run.",
      )
    }
    // The older turns are a count for each way they ended, in the order each way first came.
    const earlier = new Map<string, Array<TurnUpdate>>()
    for (const line of turns.slice(0, -1)) {
      const key = `${line.outcome}:${line.failure ?? ""}`
      earlier.set(key, [...(earlier.get(key) ?? []), line])
    }
    if (earlier.size > 0) {
      const counts = [...earlier.values()].map((same) =>
        counted(same[0]!, same.length),
      )
      body.push(
        `Before it, since the last answer the owner read: ${counts.join("; ")}.`,
      )
    }
  }
  if (notices.length > 0) {
    body.push("chad also posted these notices in the thread:")
    for (const notice of notices) body.push(`- ${notice.text}`)
  }
  return `# What chad posted in this thread\n\n${body.join("\n")}`
}

/** `/stop` found nothing running. */
export const nothingRunning = (format: Format) =>
  format.subtext("Nothing is running.")

/** `/new` started a session. */
export const newSession = (format: Format) =>
  format.subtext(
    "New session started. Nothing from the earlier conversation carries over.",
  )

/** `/new` or `/stop` in a plain channel, where there is no session. */
export const noSession = (format: Format) =>
  format.subtext(
    "There is no session in this channel. Mention me with a message and I'll open a thread for it.",
  )

/** The descriptions the platform shows for chad's slash commands, 100 characters at most. */
export const commandDescriptions = {
  new: "Start a new session in this thread",
  stop: "Stop the turn that is running",
  status: "Show chad's status",
  model: "Show the model, or change it",
  safe: "Show safe mode, or turn it on or off",
} as const

/** The descriptions of the slash commands' one argument each. */
export const commandArguments = {
  model: "A model, and --subagent, --summarizer or --fast with their values",
  safe: "on or off",
} as const

/** A slash command from someone who is not an owner. Only they see it. */
export const commandNotOwner = "Only an owner can use chad's commands."

/**
 * The private answer to a slash command, which the platform needs at once. What the command posts follows in the
 * thread, as it does for the typed command.
 */
export const commandTaken = (command: string) => `Running /${command}.`

/** chad could not open a thread on a mention. It is a normal message. */
export const threadFailed = (reason: string) =>
  `I couldn't open a thread on that message (${reason}). I need Create Public Threads here, or you can DM me.`

/** A size in whole binary megabytes, as a notice shows it. */
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

/** A file over the limit was skipped. */
export const fileSkipped = (format: Format, name: string, bytes: number) =>
  format.subtext(
    `Skipped \`${name}\` (${megabytes(bytes)}). The limit is 25 MB.`,
  )

/** The data volume is short of space, the notice of the key `disk-low`. */
export const diskLow = (bytes: number) =>
  `The data volume has ${megabytes(bytes)} free.`

/** chad's reply when the owner's message could not be saved because the data volume is full. */
export const diskFull =
  "The data volume is full, so I stopped. Free some space and send that again."

/**
 * The answer to every owner message, and the notice at boot, while the database cannot be opened or migrated.
 * "Problems" shows the same text.
 */
export const databaseUnusable = (error: string) =>
  `chad's database can't be used: ${error}. Sessions are off until it is fixed. \`chad status\` has the detail.`

/**
 * The line "Problems" prints for a table key: the row's text, and when chad recorded the condition as holding, in UTC
 * to the second.
 */
export const heldProblem = (text: string, recorded: number) =>
  `${text} (recorded ${new Date(recorded).toISOString().slice(0, 19)}Z)`

/** A file could not be downloaded and was skipped. */
export const fileFailed = (format: Format, name: string) =>
  format.subtext(`Skipped \`${name}\`. I couldn't download it.`)

/** What `/status` posts: the text of `chad status`, kept as it is. */
export const status = (text: string) => `\`\`\`\n${text}\n\`\`\``

/** The lines a prompt gets about the files on the owner's message. The model reads them. */
export const promptFileSaved = (name: string, path: string) =>
  `The owner attached the file ${name}. It is saved at ${path}.`

export const promptFileSkipped = (name: string, bytes: number) =>
  `The owner attached the file ${name} (${megabytes(bytes)}). It is over the 25 MB limit and was not saved.`

export const promptFileFailed = (name: string) =>
  `The owner attached the file ${name}. It could not be downloaded and was not saved.`

/** A model setting that is not `<provider>/<model>[/<effort>]` with a provider clanka knows. */
export const modelUnparsable = (text: string) =>
  `The model setting \`${text}\` is not <provider>/<model>[/<effort>] with a provider chad knows.`

/** The provider `claude`, which chad refuses. */
export const modelClaudeRefused =
  "chad does not run the provider claude, because clanka reaches Claude only through an installed Claude Code, which chad does not ship. Reach Claude through an OpenAI-compatible gateway with openai-compat/<model>."

/** `openai-compat` with no endpoint. */
export const modelCompatNoUrl =
  "The provider openai-compat needs CHAD_OPENAI_API_URL."

/** An override that names another provider than the main model. */
export const modelOverrideProvider = (text: string, provider: string) =>
  `The override \`${text}\` names another provider than the main model, which runs on ${provider}.`

export { modelTrial } from "./Trial.ts"

export { titlePrompt } from "./Title.ts"

/** A title request whose answer holds no title. */
export const titleEmpty = "the answer holds no title"

/** A title for a thread whose connection no longer renames threads, because it is being taken down. */
export const titleNoRename = "the connection renames no thread now"

/** A check, a trial or a thread's title that had no answer by its deadline. */
export const modelTrialTimedOut = "no answer within the deadline"

/** One model's sentence of the `model-check-failed` notice. */
export const modelCheckFailed = (spec: string, error: string) =>
  `The model \`${spec}\` failed its check at start (${error}). If turns fail, set another with \`/model\`.`

/** The usage line of `/model`, for words it does not take. */
export const modelUsage =
  "Use /model [<provider>/<model>[/<effort>]] [--subagent <provider>/<model>[/<effort>]|none] [--summarizer <provider>/<model>[/<effort>]|none] [--fast on|off]."

/** What `chad model` and `/model` print with no argument, one fact to a line. */
export const modelShown = (lines: {
  readonly main: string
  readonly subagent: string | undefined
  readonly summarizer: string | undefined
  readonly ignored: ReadonlyArray<string>
  readonly fast: string
}) =>
  [
    `model: ${lines.main}`,
    `sub-agents: ${lines.subagent ?? "the main model"}`,
    `summarizer: ${lines.summarizer ?? "the main model"}`,
    `fast mode: ${lines.fast}`,
    ...lines.ignored,
  ].join("\n")

/** Fast mode's value in what `chad model` shows. `ignoredBy` is the provider of a main model that ignores it. */
export const modelFastShown = (on: boolean, ignoredBy: string | undefined) =>
  on
    ? ignoredBy === undefined
      ? "on"
      : `on (ignored: ${ignoredBy} has no fast mode)`
    : "off"

/** The main model's value in what `chad model` shows, when it cannot run. */
export const modelCannotRun = (spec: string, error: string) =>
  `${spec} (cannot run: ${error})`

/** A stored override this run leaves out, in what `chad model` shows. */
export const modelIgnored = (
  override: "subagent" | "summarizer",
  spec: string,
  error: string,
) =>
  `ignored: the ${override === "subagent" ? "sub-agent" : "summarizer"} override ${spec} (${error})`

/** A changed main model. */
export const modelNow = (spec: string) => `The model is now ${spec}.`

/** A set or cleared override. */
export const modelOverrideNow = (
  override: "subagent" | "summarizer",
  spec: string | undefined,
) =>
  override === "subagent"
    ? `Sub-agents now run on ${spec ?? "the main model"}.`
    : `The summarizer now runs on ${spec ?? "the main model"}.`

/** Fast mode turned on or off. `ignoredBy` is the provider of a main model that ignores it. */
export const modelFastNow = (on: boolean, ignoredBy: string | undefined) =>
  on
    ? ignoredBy === undefined
      ? "Fast mode is now on: OpenAI requests ask for the priority service tier."
      : `Fast mode is now on, but ${ignoredBy} has no fast mode, so it applies once the main model is on openai again.`
    : "Fast mode is now off."

/** The overrides a change of provider cleared. */
export const modelOverridesCleared = (
  cleared: ReadonlyArray<"subagent" | "summarizer">,
  provider: string,
) =>
  `${cleared.length === 2 ? "The sub-agent and summarizer overrides were" : cleared[0] === "subagent" ? "The sub-agent override was" : "The summarizer override was"} cleared, because the main model left ${provider}.`

/** A change refused before any request, so nothing was stored. */
export const modelRefused = (reason: string) => `Nothing was changed: ${reason}`

/** A change whose trial request failed, so nothing was stored. */
export const modelTrialFailed = (spec: string, error: string) =>
  `The model ${spec} failed its trial request (${error}). Nothing was changed.`

/** A change whose login did not complete, so nothing was stored. */
export const modelLoginFailed = (reason: string) =>
  reason === "TimedOut"
    ? "The login timed out. Nothing was changed."
    : `The login failed (${reason}). Nothing was changed.`

/** A change whose file could not be written. The files written before it stay, and the daemon reads them again. */
export const modelNotStored = (path: string, code: string) =>
  `The change was not stored in full: ${path} could not be written (${code}).`

/** A model call needed a Codex login while chad has none and cannot post a code for one. */
export const loginUnavailable = "chad is not logged in to Codex."

/** The login prompt, in a thread and in the terminal. */
export const loginPrompt = (verifyUrl: string, code: string) =>
  `To log chad in to Codex, open ${verifyUrl} and enter the code ${code}. The code is good for 15 minutes.`

/** The notice in a thread whose turn waits on a login another thread has the code of. */
export const loginWaitingIn = (link: string) =>
  `Waiting for the login in ${link}`

/** The status line of a turn that waits on a login. */
export const statusLoginWait = "Waiting for login"

/** A waiting turn's message when the login's time ran out. */
export const loginTimedOut = "Login timed out. Send a message to try again."

/** A waiting turn's message when the login failed in any other way. */
export const loginFailed = (reason: string) =>
  `Login failed (${reason}). Send a message to try again.`

/** `chad login` with no daemon, when a daemon took the lock while the owner logged in. */
export const loginRaced =
  "a daemon started during the login, run chad login again"

/** `chad login` when the model in force needs no login. */
export const loginNotNeeded = (spec: string) =>
  `The model ${spec} needs no login.`

/** `chad login` when the login did not complete. */
export const loginCliFailed = (reason: string) =>
  reason === "TimedOut"
    ? "chad login: the login timed out, run chad login again"
    : `chad login: the login failed (${reason}), run chad login again`

/** `chad login` once the login completed. */
export const loggedIn = "chad is logged in to Codex."

/** `chad login` when the stored token is good, which a new login does not replace. */
export const alreadyLoggedIn =
  "chad is already logged in to Codex. To log in with another account, run chad logout and then chad login."

/** `chad logout`, which stops no running turn. */
export const loggedOut =
  "chad is logged out of Codex. A turn that is running is not stopped: it finishes on the connection it has, and the next one asks for a login."

/** A hook ran past its budget, as the first line of its failure. */
export const hookTimedOut = "ran past its budget"

/** The same hook failed 3 times in a row. */
export const hookFailing = (plugin: string, hook: string, first: string) =>
  `\`${plugin}\`'s \`${hook}\` hook has failed 3 times in a row (${first}). It stays on.`

/** A plugin's tool has a name that someone else holds, which fails its load. */
export const toolTaken = (name: string, holder: string) =>
  `The tool name "${name}" is already used by ${holder}.`

/** A plugin-started turn whose thread is gone. */
export const threadGone = (plugin: string, label: string) =>
  `\`${plugin}\` could not run \`${label}\` because its thread is gone.`

/** The update message's part for the chunks that changed or went. */
export const chunksChanged = (
  changes: ReadonlyArray<{
    readonly plugin: string
    readonly text: string | undefined
  }>,
) =>
  [
    "# Plugin context changed",
    ...changes.map((change) =>
      change.text === undefined
        ? `\nThe "${change.plugin}" section of your instructions no longer applies.`
        : `\nThe "${change.plugin}" section of your instructions is replaced by:\n\n${change.text}`,
    ),
  ].join("\n")

/** A `beforeTurn` text, as its own user message. */
export const pluginContext = (plugin: string, text: string) =>
  `<plugin-context plugin="${plugin}">\n${text}\n</plugin-context>`

/** `Turns.start` called from a tool for the thread of its own turn. */
export const startInOwnThread =
  "Turns.start cannot run a turn in the thread of the turn that called this tool, because that turn would wait for this one. Use Turns.queue, which returns once the turn is queued."

/** A `Turns` call whose request could not be saved. */
export const turnNotSaved = (what: "started" | "queued", why: string) =>
  `The turn was not ${what}, because chad could not save the request: ${why}`

/** A `Turns.schedule` or `Turns.cancel` whose change could not be saved. */
export const timerNotSaved = (why: string) =>
  `Nothing was changed, because chad could not save the timer: ${why}`

/** A `Turns.schedule` given a schedule chad cannot read, which changes nothing either. */
export const timerInvalid = (why: string) =>
  `Nothing was changed, because the schedule is not valid: ${why}`

/** The `logged-out` notice. */
export const loggedOutNotice =
  "chad is logged out. Send a message or run `chad login`. Scheduled runs are skipped until then."

/** A background task that ended after the Agent that started it was rebuilt, in clanka's own form. */
export const taskEnded = (task: {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly exitCode?: number | undefined
}) =>
  `<task id="${task.id}" kind="${task.kind}" status="${task.status}"${task.exitCode === undefined ? "" : ` exitCode="${task.exitCode}"`}>
To read the output, call taskOutput(${JSON.stringify(task.id)}).
</task>`

/** A plugin kept both as a file and as a directory. */
export const twoEntries = (name: string, file: string, index: string) =>
  `The plugin "${name}" has two entry files, ${file} and ${index}. Keep one of them.`

/** A plugin whose name breaks the name rule. */
export const pluginName = (name: string, file: string) =>
  `The plugin name "${name}" (${file}) may hold only lower-case letters, digits and hyphens. Rename it.`

/** The line after a TS2307 for a package, and after esbuild's error for one it could not resolve. */
export const importable =
  "A plugin can import chad, effect, Node's built-in modules, such as node:fs, and the packages work/package.json names. To add one, run `npm install --package-lock-only --ignore-scripts <name>` in work/ and apply."

/** `work/package.json` that cannot be read or is not JSON. */
export const manifestUnreadable = (detail: string) =>
  `work/package.json could not be read: ${detail}`

/** `work/package.json` without `"type": "module"`. */
export const manifestNotModule =
  'work/package.json has to say "type": "module", or the type-check reads every plugin file as CommonJS. Add it and apply again.'

/** A manifest that names packages, with no lockfile. */
export const lockMissing =
  "work/package.json names packages and work/package-lock.json is missing. Run `npm install --package-lock-only --ignore-scripts` in work/ and apply again."

/** A lockfile that does not match the manifest, or that npm 6 or older wrote. */
export const lockStale =
  "work/package-lock.json does not match work/package.json. Run `npm install --package-lock-only --ignore-scripts` in work/ and apply again."

/** One package that asks for a version of a host package that chad does not have. */
export const hostConflictLine = (
  asking: string,
  name: string,
  range: string,
  version: string,
) => `  ${asking} needs ${name} ${range}, and chad has ${name} ${version}`

/** One package that asks for a host package by an alias or a spec that is not a semver range. */
export const hostUncheckedLine = (
  asking: string,
  key: string,
  spec: string,
  name: string,
  version: string,
) =>
  `  ${asking} asks for ${key} as "${spec}", which chad cannot check against its own ${name} ${version}`

/** The packages that ask for versions of host packages that chad does not have. */
export const hostConflict = (lines: ReadonlyArray<string>) =>
  [
    "A plugin's packages get chad's own copy of chad, effect and chad's other dependencies, and these ask for a version chad does not have, or ask in a way chad cannot check:",
    ...lines,
    "Pick versions of them that work with chad's, ask for a host package by its own name and a version range, or remove them from work/package.json, and run `npm install --package-lock-only --ignore-scripts` in work/.",
  ].join("\n")

/** An install that npm failed, with the lines of npm's output that say why. */
export const installFailed = (lines: ReadonlyArray<string>) =>
  [
    "The packages of work/package-lock.json could not be installed:",
    ...lines.map((line) => `  ${line}`),
    "A package that npm's cache does not hold is fetched from the registry, which needs the network.",
  ].join("\n")

/** An install that ran past its deadline. */
export const installTimedOut = (seconds: number) =>
  installFailed([
    `npm ci did not finish in ${seconds} seconds and was stopped.`,
  ])

/** The lines of a check or an apply about the packages its lockfile adds, removes and changes. */
export const packageChanges = (options: {
  readonly added: ReadonlyArray<readonly [string, string]>
  readonly removed: ReadonlyArray<readonly [string, string]>
  readonly changed: ReadonlyArray<readonly [string, string, string]>
}) => [
  ...(options.added.length === 0
    ? []
    : [
        `Packages added: ${options.added.map(([name, version]) => `${name} ${version}`).join(", ")}.`,
      ]),
  ...(options.changed.length === 0
    ? []
    : [
        `Packages changed: ${options.changed.map(([name, from, to]) => `${name} ${from} -> ${to}`).join(", ")}.`,
      ]),
  ...(options.removed.length === 0
    ? []
    : [
        `Packages removed: ${options.removed.map(([name, version]) => `${name} ${version}`).join(", ")}.`,
      ]),
]

/** The last line of a failed type-check of plugins. */
export const effectGuide = (path: string) =>
  `Read ${path} before you write Effect code.`

/** A plugin with top-level await. */
export const topLevelAwait = (name: string, at: string) =>
  `${name}: top-level await at ${at}. A plugin runs as a CommonJS bundle, which has no top-level await. Move the awaited work into the plugin's Layer, for example inside Layer.effect(Effect.gen(...)).`

/** A plugin esbuild could not bundle. */
export const notBundled = (name: string, errors: ReadonlyArray<string>) =>
  [`${name}: could not be bundled`, ...errors].join("\n")

/** A plugin that imports a package of a tree whose packages could not be installed, with esbuild's errors and why. */
export const notInstalled = (name: string, errors: ReadonlyArray<string>) =>
  [
    `${name}: imports a package that is not installed, because the packages of work/package-lock.json could not be installed. chad logs has npm's error.`,
    ...errors,
  ].join("\n")

/** A bundle that threw when it ran, with the error's stack. */
export const notLoaded = (name: string, stack: string) =>
  `${name} could not be loaded: ${stack}`

/**
 * A default export that is not a `Plugin`. A file directly in `plugins/` with no default export is most
 * likely a helper file, and the error says where one goes.
 */
export const notPlugin = (name: string, file: string, helper: boolean) =>
  helper
    ? `${name}: ${file} has no default export. Every .ts file directly in plugins/ is a plugin's entry file, so a helper file goes in a subdirectory, such as plugins/<plugin>/<helper>.ts.`
    : `${name}: the default export of ${file} is not a Plugin. Wrap it in Plugin.make(...).`

/** A plugin's Layer that did not build in time. */
export const buildTimedOut = (seconds: number) =>
  `The plugin's Layer did not build within ${seconds} seconds. A Turns call made while it builds never returns, so make it in Plugin.background.`

/** The notice of a plugin skipped at boot, one for each plugin. */
export const pluginSkipped = (name: string, reason: string) =>
  `Skipped at start: \`${name}\` (${reason})\n\`chad status\` has the rest.`

/** The line of `boot.moved-aside`. */
export const movedAside = (path: string, to: string) =>
  `${path} was not a link, so it was moved to ${to}`

/** Whether a bundled plugin is off until `chad.json` turns it on, which is the one a repo copy of it is replaced by. */
const offByDefault = (name: string) =>
  (BundledNames.offByDefault as ReadonlyArray<string>).includes(name)

/**
 * A repo plugin that has a bundled plugin's name, which is skipped at boot. A boot only says so while the bundled one is
 * on. A copy of a plugin that is off by default is the bundled plugin itself, so the line says to delete it.
 */
export const bundledName = (name: string) =>
  offByDefault(name)
    ? `${name}: the bundled ${name} plugin loads and this copy of it is skipped. Delete its file or directory under work/plugins/ and run chad apply. The bundled one uses the same key-value table, so it keeps the data.`
    : `${name}: a bundled plugin has this name, so the bundled one loads and this one is skipped. The two share one key-value table, and renaming this plugin does not move its data.`

/** The refusal of a call to a tool whose version a swap took out of service. */
export const toolRefused = (
  why: "changed" | "removed" | "safe",
  tool: string,
  subagents: boolean,
) =>
  why === "safe"
    ? toolSafeMode(tool)
    : why === "removed"
      ? toolRemoved(tool)
      : subagents
        ? toolChangedSubagent(tool)
        : toolChanged(tool)

/** The refusal of a call to a tool an apply changed. */
export const toolChanged = (tool: string) =>
  `${tool} was changed by an apply. The new version is in your next turn.`

/** The refusal of a call to a tool an apply changed, while the turn has a sub-agent running. */
export const toolChangedSubagent = (tool: string) =>
  `${tool} was changed by an apply. The new version is in your next turn, which cannot start while this turn has a sub-agent running.`

/** The refusal of a call to a tool an apply removed. */
export const toolRemoved = (tool: string) =>
  `${tool} was removed by an apply and is gone from your next turn.`

/** The refusal of a call to a tool of a plugin that safe mode turned off. */
export const toolSafeMode = (tool: string) => `${tool} is off in safe mode.`

/** A call the drain interrupted, which stopped within the wait or did not. */
export const toolCut = (tool: string, stopped: boolean) =>
  stopped
    ? `${tool} was interrupted by an apply, it may have partly run.`
    : `${tool} did not stop when an apply interrupted it and may still be running.`

/** The line of `swap.overrun` for a tool call. */
export const overrunTool = (plugin: string, tool: string) =>
  `${tool} of ${plugin} did not stop when the swap interrupted it, so two versions of ${plugin} now overlap`

/** The line of `swap.overrun` for a hook. */
export const overrunHook = (plugin: string, hook: string) =>
  `The ${hook} hook of ${plugin} did not stop when the swap interrupted it, and the plugin's hook queue has moved on to the new version`

/** The line of `swap.overrun-ended`. */
export const overrunEnded = (plugin: string, name: string) =>
  `${name} of ${plugin} ended after the swap moved on`

/** The line of `swap.close-abandoned`. */
export const closeAbandoned = (plugin: string) =>
  `The close of the old version of ${plugin} ran past its deadline, and its finalizers were abandoned`

/** An apply's refusal of a repo plugin with a bundled plugin's name. */
export const bundledNameRefused = (name: string) =>
  offByDefault(name)
    ? `The plugin "${name}" is bundled with chad now. Delete its file or directory under work/plugins/ and turn the bundled one on with "enabled": true under plugins.${name} in work/chad.json, keeping its settings. It uses the same key-value table, so it keeps the data.`
    : `The plugin "${name}" has the name of a bundled plugin. Rename it: the two would share one key-value table.`

/** The refusal of `AGENTS.md`, `.agents` and `.kiro` in the repo, which names where their content goes. */
export const instructionsRefused = (paths: ReadonlyArray<string>) =>
  `The repo holds ${paths.map((path) => `work/${path}`).join(", ")}. chad refuses AGENTS.md, .agents and .kiro in the repo, because clanka would read them without an apply. Put a skill under skills/<name>/SKILL.md and standing instructions in persona.md, then delete these.`

// Skills. A check names the file as `work/skills/<dir>/SKILL.md`, the file the agent edits, and a boot's notice names
// the skill by its directory.

/** What is wrong with a `SKILL.md`, as a phrase that follows the file's name. */
export const skillProblems = {
  /** No front matter, or front matter that is not YAML. */
  noFrontMatter: (dir: string) =>
    `has no front matter. Start it with a line "---", then 'name: "${dir}"', "description: <when to read the skill>" and "---"`,
  /** A missing or empty `name`. */
  noName: (dir: string) =>
    `has no name in its front matter. Set 'name: "${dir}"'`,
  /** A missing or empty `description`. */
  noDescription:
    "has no description in its front matter. Say when a session should read the skill",
  /** A name that differs from the directory. */
  otherName: (name: string, dir: string) =>
    `has the name "${name}", which differs from its directory. Set 'name: "${dir}"'`,
  /** A `SKILL.md` that resolves outside the applied tree. */
  outside:
    "links to a file outside the repo. An applied skill holds only what the apply committed, so put the file itself in skills/",
  /** Other files of the skill that resolve outside the applied tree or to nothing. */
  outsideFiles: (paths: ReadonlyArray<string>) =>
    `has files that link outside the repo or to nothing: ${paths.join(", ")}. An applied skill holds only what the apply committed, so put the files themselves in its directory`,
  /** A file that cannot be read. */
  unreadable: (error: string) => `cannot be read: ${error}`,
} as const

/** A malformed skill in a check or an apply, which names the file. */
export const skillRefused = (dir: string, problem: string) =>
  `work/skills/${dir}/SKILL.md ${problem}.`

/** The notice of a skill a boot skipped. */
export const skillSkipped = (name: string, problem: string) =>
  `Skipped skill \`${name}\`: SKILL.md ${problem}.`

/** The one-off notice of a bundled skill that changed while a repo skill hides it. */
export const bundledSkillChanged = (name: string) =>
  `The bundled skill \`${name}\` changed in this image. The repo's copy still hides it.`

/** The sentence chad appends to a repo skill's content. */
export const repoSkillWhere = (live: string, work: string) =>
  `This skill's files are in ${live}. To change the skill, edit its copy in ${work} and run chad apply. An edit under ${live} is lost at the next apply.`

/** The sentence chad appends to a bundled skill's content. */
export const bundledSkillWhere = (image: string, work: string) =>
  `This skill is bundled with chad and its files are in ${image}, which is read-only. To change the skill, copy its directory to ${work}, edit it there and run chad apply. The repo's copy then hides the bundled one.`

/** An apply's lines for the repo skills it added, changed and removed. */
export const skillChanges = (changes: {
  readonly added: ReadonlyArray<string>
  readonly changed: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
}) => [
  ...(changes.added.length === 0
    ? []
    : [`Skills added: ${changes.added.join(", ")}.`]),
  ...(changes.changed.length === 0
    ? []
    : [`Skills changed: ${changes.changed.join(", ")}.`]),
  ...(changes.removed.length === 0
    ? []
    : [`Skills removed: ${changes.removed.join(", ")}.`]),
]

/** An apply's line for a repo skill that hides a bundled one. */
export const skillHides = (name: string) =>
  `The repo skill ${name} hides the bundled skill of the same name.`

/** `chad status`'s mark on a repo skill that hides a bundled one. */
export const skillHidesMark = (name: string) =>
  `skill: ${name}, from the repo, hides the bundled one`

/** `chad skill new` wrote its file. */
export const skillWritten = (name: string) =>
  `Wrote work/skills/${name}/SKILL.md. Fill in its description and instructions. It is a draft until chad apply.`

/** The body of the `SKILL.md` that `chad skill new` writes. */
export const skillBody =
  "Write the instructions here: what the task is, the steps, and the commands to run."

/** `chad skill new` with a name that breaks the name rule. */
export const skillNameRule = (name: string) =>
  `"${name}" is not a skill name. Use lower-case letters, digits and hyphens.`

/** `chad skill new` with a name the repo already has. */
export const skillTaken = (name: string) =>
  `work/skills/${name} exists already. Pick another name, or edit the skill that is there.`

/** `chad skill new` with a bundled skill's name. */
export const skillBundledName = (name: string) =>
  `${name} is the name of a bundled skill. Pick another name. To change the bundled one, copy its directory into work/skills/${name}.`

/** `chad skill new` with no `repo/work`, which only `chad serve` creates. */
export const skillNoRepo = (work: string) =>
  `${work} does not exist yet. Start chad serve once, which creates the repo.`

/** The count of the errors a failed check does not print. */
export const moreErrors = (count: number) => `... and ${count} more errors.`

/** A plugin whose Layer did not build, in a failed apply. */
export const couldNotLoad = (name: string, error: string) =>
  `${name} could not be loaded: ${error}`

/** `chad check` on a tool that `chad apply` refuses. */
export const replaceMeCheck = (tool: string) =>
  `The tool ${tool} has a description that starts with "Replace me". chad apply will refuse it: describe the tool or delete it.`

/** `chad apply` refusing that tool. */
export const replaceMeRefused = (tool: string) =>
  `The tool ${tool} has a description that starts with "Replace me". Describe the tool or delete it.`

/** A check that passed. */
export const checkPassed = "The check passed. Nothing was applied."

/** An apply or a revert with nothing changed. */
export const nothingChanged = "Nothing changed. No commit was made."

/** A revert with no applied commit before the current one. */
export const revertNoEarlier =
  "There is no applied commit before the current one to revert to."

/** A revert to a commit that is not on the `applied` branch. */
export const revertNotApplied = (commit: string) =>
  `${commit} is not an applied commit. \`chad log\` lists them.`

/** A revert that would write over files its save did not capture, such as ignored ones. */
export const revertObstructed = (paths: ReadonlyArray<string>, saved: string) =>
  `The revert would write over ${paths.join(", ")} in work/, which the save at ${saved} does not hold. Nothing was reverted. Move ${paths.length === 1 ? "it" : "them"} away and run chad revert again.`

/** The files a revert left in work/ as they were, since they changed or appeared after its save. */
export const revertLeft = (paths: ReadonlyArray<string>) =>
  `These files in work/ changed or appeared after the save, so the revert left them as they are: ${paths.join(", ")}. git diff in work/ shows how the tracked ones differ from the revert.`

/** Where a revert keeps, as they were, the files it moved out of work/. */
export const revertKept = (directory: string) =>
  `The files the revert replaced or deleted in work/ are kept as they were under ${directory}. chad never deletes them, so remove that directory once nothing in it is needed.`

/** The message of a revert's commit, which names the commit it went back to. */
export const revertMessage = (commit: string) => `Revert to ${commit}`

/** The session line of an apply. */
export const appliedLine = (commit: string, message: string) =>
  `Applied \`${commit}\`: ${message}`

/** The session line of a revert. */
export const revertedLine = (commit: string, from: string) =>
  `Reverted \`${from}\` as \`${commit}\`.`

/** The session line of `chad safe on|off`. */
export const safeLine = (on: boolean) =>
  on ? "Safe mode is on." : "Safe mode is off."

/** The session line of `chad timezone`, which names the plugins kept on their previous version. */
export const timezoneLine = (zone: string, kept: ReadonlyArray<string>) =>
  kept.length === 0
    ? `Timezone set to ${zone}.`
    : `Timezone set to ${zone}. Still on the previous timezone: ${kept.join(", ")}.`

/** What `chad timezone <zone>` prints once the zone is stored. */
export const timezoneSet = (zone: string) => `Timezone set to ${zone}.`

/** What `chad secret set` prints once the value is stored, with the plugins that reloaded. */
export const secretSaved = (
  name: string,
  replaced: boolean,
  restarted: ReadonlyArray<string>,
) => `${replaced ? "Replaced" : "Saved"} ${name}${restartedSuffix(restarted)}`

/** What `chad secret rm` prints once the secret is gone, with the plugins that reloaded. */
export const secretRemoved = (name: string, restarted: ReadonlyArray<string>) =>
  `Removed ${name}${restartedSuffix(restarted)}`

const restartedSuffix = (restarted: ReadonlyArray<string>) =>
  restarted.length === 0 ? "" : `, restarted ${restarted.join(", ")}`

/** `chad secret set` with a name the store cannot hold, which exits 2. */
export const secretNameInvalid = () =>
  "chad secret set: the name must match [A-Z_][A-Z0-9_]* and be 64 characters at most"

/** `chad secret set CHAD_DOLLAR`, which exits 2. */
export const secretNameReserved = () =>
  "chad secret set: the name CHAD_DOLLAR is reserved for writing a literal ${ in configuration"

/** `chad secret set` with an empty value, which exits 2. */
export const secretNoValue = () => "chad secret set: no value on stdin"

/** The prompt of a value typed at a terminal, which echoes nothing. */
export const secretPrompt = (name: string) => `Value of ${name}`

/** A name the store does not hold: `rm` exits 1 and `run` 125. */
export const secretMissing = (command: "rm" | "run", name: string) =>
  `chad secret ${command}: no secret named ${name}`

/** A store that cannot be read or holds no store. It never carries what the file holds, which may be a value. */
export const secretStoreBroken = (command: string, problem: string) =>
  `chad secret ${command}: ${problem}`

/** An `--env` that is no `VAR=NAME` pair, which exits 125. */
export const secretEnvPair = (pair: string) =>
  `chad secret run: --env takes VAR=NAME, got ${pair}`

/** A command `chad secret run` did not find, which exits 127. */
export const secretNotFound = (command: string) =>
  `chad secret run: ${command}: command not found`

/** A command `chad secret run` found and could not execute, with the error code, which exits 126. */
export const secretNotExecutable = (command: string, code: string) =>
  `chad secret run: ${command}: cannot execute (${code})`

/** One line of `chad secret list`: the name, the time of the save and the note, never the value. */
export const secretListed = (name: string, date: string, note?: string) =>
  note === undefined ? `${name}  ${date}` : `${name}  ${date}  ${note}`

/** What `chad secret list` prints for an empty store. */
export const secretsNone = () => "No secrets are stored."

/** The session line of `chad secret rm`, which names the plugins kept on their previous version. */
export const secretLine = (name: string, kept: ReadonlyArray<string>) =>
  kept.length === 0
    ? `Secret ${name} removed.`
    : `Secret ${name} removed. Still on the previous secret: ${kept.join(", ")}.`

/** A plugin that failed to build in a reload and kept its running version, with the error. */
export const keptPrevious = (name: string, error: string) =>
  `${name}: ${firstLine(error)}`

/** `chad timezone <zone>` with no named zone, which exits 2. */
export const timezoneInvalid = (zone: string) =>
  `chad timezone: ${JSON.stringify(zone)} is not a named timezone. Give an IANA name such as Europe/Berlin.`

/** What `chad timezone` with no argument prints: the zone in force and where it came from. */
export const timezoneInForce = (
  zone: string,
  source: "stored" | "variable" | "fallback",
  ignored: string | undefined,
) =>
  source === "stored"
    ? `${zone}, set with chad timezone.`
    : source === "variable"
      ? `${zone}, from TZ. Nothing is set with chad timezone.`
      : ignored === undefined
        ? `${zone}, the fallback. Nothing is set with chad timezone and TZ is not set.`
        : `${zone}, the fallback. Nothing is set with chad timezone and TZ=${ignored} is not a valid zone.`

/** What `chad safe` prints: whether safe mode is on and what turned it on. */
export const safeState = (state: "off" | "variable" | "toggle") =>
  state === "off"
    ? "Safe mode is off."
    : state === "variable"
      ? "Safe mode is on, held by CHAD_SAFE_MODE=1. Nothing from the repo is loaded."
      : "Safe mode is on, turned on by chad safe on. Nothing from the repo is loaded."

/** `chad safe off` while `CHAD_SAFE_MODE=1` is set, which changes nothing. */
export const safeForced =
  "CHAD_SAFE_MODE=1 is set and holds safe mode on. Nothing was changed. Unset it on the container and restart chad to turn safe mode off."

/** The two fixed sentences of the core prompt, which send the agent to the `self-edit` skill. */
export const selfEditPrompt =
  "Your plugins, skills, MCP servers, settings and persona are files you can change with the `chad` CLI. Read the `self-edit` skill before you do."

/** The line the system prompt has while safe mode is on. */
export const safePrompt =
  "Safe mode is on. Nothing from the repo is loaded: no repo plugins, skills, MCP servers or persona."

/** A command that waits behind another in the queue. */
export const queueWaiting = (command: string) =>
  `Waiting for ${command} to finish.`

/** `chad plugin reload` of a plugin that is neither loaded nor skipped. */
export const reloadUnknown = (name: string) =>
  `No plugin named ${name} is loaded or skipped.`

/** `chad plugin reload` of a repo plugin in safe mode, which loads nothing from the repo. */
export const reloadSafe = (name: string) =>
  `Safe mode is on, so ${name} from the repo is not loaded. Turn safe mode off first.`

/** A name `chad plugin new` refuses as bad usage, which exits 2. */
export const pluginNameInvalid = (name: string) =>
  `"${name}" is not a plugin name. Use lower-case letters, digits and hyphens.`

/** A name `chad plugin new` refuses because a bundled plugin holds it, which exits 1. */
export const pluginNameBundled = (name: string) =>
  `"${name}" is the name of a bundled plugin. Pick another name.`

/** A name `chad plugin new` refuses because a plugin in work/ has it, which exits 1. */
export const pluginNameTaken = (name: string) =>
  `work/plugins/ already holds a plugin named "${name}". Edit it, or pick another name.`

/** `chad plugin new` and `chad skill new` before `chad serve` made the repo, which exits 4. */
export const workMissing = (work: string) =>
  `${work} does not exist yet. chad serve creates the repo the first time it starts.`

/** `chad plugin new` that could not write its file. */
export const notWritten = (command: string, path: string, detail: string) =>
  `chad ${command}: cannot write ${path} (${detail})`

/** What `chad plugin new` prints once the file is written. */
export const pluginWritten = (path: string, agents: string, examples: string) =>
  [
    `Wrote ${path}.`,
    `Before you change it, read the self-edit skill and ${agents}.`,
    `Working plugins to read: ${examples}`,
    `Its tool's description starts with "Replace me", which chad apply refuses. Describe the tool, then run chad check and chad apply -m "<why>".`,
  ].join("\n")

/** `chad plugin purge` of a plugin still in the applied repo, which exits 1. */
export const purgeInRepo = (name: string) =>
  `${name} is still in the applied repo, so its data stays. Delete its file in work/, run chad apply, then purge it.`

/** `chad plugin purge` of a bundled plugin that is on, which exits 1. */
export const purgeBundledOn = (name: string) =>
  `${name} is a bundled plugin and it is on, so its data stays. Turn it off with "enabled": false in work/chad.json, run chad apply, then purge it.`

/** `chad plugin purge` of a plugin chad holds no data for, which exits 0. */
export const purgeNothing = (name: string) => `Nothing is stored for ${name}.`

/** What `chad plugin purge` prints once it dropped the plugin's table. */
export const purged = (name: string, keys: number, timers = 0) =>
  timers === 0
    ? `Purged ${name}: its key-value table and its ${keys} ${keys === 1 ? "key" : "keys"} are deleted.`
    : `Purged ${name}: its key-value table, its ${keys} ${keys === 1 ? "key" : "keys"} and its ${timersCount(timers)} are deleted.`

/** A purge of a plugin that had timers and no table. */
export const purgedTimers = (name: string, timers: number) =>
  `Purged ${name}: its ${timersCount(timers)} ${timers === 1 ? "is" : "are"} deleted.`

const timersCount = (count: number) =>
  `${count} ${count === 1 ? "timer" : "timers"}`

/** The apply line of a plugin back on, or back in the repo, with overdue held timers. */
export const timersWillFire = (name: string, overdue: number) =>
  `${name}: ${overdue} overdue held ${overdue === 1 ? "timer fires" : "timers fire"} once now.`

/** The apply line of a plugin the apply unloaded that has timers, which are kept and held. */
export const timersHeldLine = (name: string, count: number) =>
  `${name}: its ${timersCount(count)} ${count === 1 ? "is" : "are"} kept and held until it loads again. chad plugin purge ${name} deletes them.`

/** The "Problems" line of timers held for a plugin that is not loaded, and neither off nor deleted. */
export const timersHeldProblem = (name: string, count: number) =>
  `${timersCount(count)} held for plugin ${name}, which is not loaded`

/** The `chad status` line of a plugin deleted from the repo that still has timers. */
export const timersDeletedPlugin = (name: string, count: number) =>
  `plugin: ${name}, deleted from the repo, ${timersCount(count)} held (chad plugin purge ${name} deletes them)`

/** The `chad status` line of a plugin that is off, with its held timers. */
export const offPlugin = (name: string, count: number) =>
  `plugin: ${name}, off${count === 0 ? "" : `, ${timersCount(count)} held`}`

/** The session line of `chad plugin purge`. */
export const purgedLine = (name: string) => `Purged the data of plugin ${name}.`

/** `chad plugin reload` that swapped. */
export const reloaded = (name: string) =>
  `Reloaded ${name}. Sessions pick it up on their next message.`

/** An apply that failed from its commit on. */
export const failedAfterCommit = (commit: string, error: string) =>
  `The commit ${commit} was made, but the apply failed after it: ${error}. It loads at the next start.`

/** What a successful apply or revert prints. */
/** The line an apply ends with, after the MCP servers' lines when `mcp.json` changed. */
export const appliedClosing =
  "Sessions pick the change up on their next message. This turn keeps the tools it has."

export const appliedOutput = (options: {
  readonly kind: "apply" | "revert" | "check"
  readonly commit: string
  readonly files: ReadonlyArray<string>
  readonly safe: boolean
  readonly saved: string | undefined
  readonly restored: Repo.Restored | undefined
  readonly swapped:
    | {
        readonly swapped: ReadonlyArray<string>
        readonly removed: ReadonlyArray<string>
        readonly waited: number
        readonly interrupted: ReadonlyArray<string>
        readonly affected: ReadonlyArray<{
          readonly session: string
          readonly subagents: number
          readonly tasks: number
        }>
      }
    | undefined
  /** In safe mode, the bundled plugins whose `enabled` flip took effect at once. */
  readonly flipped?:
    | {
        readonly on: ReadonlyArray<string>
        readonly off: ReadonlyArray<string>
        readonly failed: ReadonlyArray<{
          readonly name: string
          readonly error: string
        }>
      }
    | undefined
  /** The settings listing of the plugins the apply built. */
  readonly settings?: ReadonlyArray<string>
  /** The lines of the skills the apply added, changed or removed, and of the repo skills that hide a bundled one. */
  readonly skills?: ReadonlyArray<string>
}) => [
  `${options.kind === "revert" ? "Reverted" : "Applied"} ${options.commit}.`,
  ...(options.saved === undefined
    ? []
    : [`What work/ held is saved at ${options.saved}.`]),
  ...(options.restored === undefined || options.restored.left.length === 0
    ? []
    : [revertLeft(options.restored.left)]),
  ...(options.restored?.kept === undefined
    ? []
    : [revertKept(options.restored.kept)]),
  "Changed files:",
  ...options.files.map((file) => `  ${file}`),
  ...(options.settings ?? []),
  ...(options.skills ?? []),
  ...(options.safe
    ? [
        "Safe mode is on, so nothing was loaded. The change loads when safe mode goes off.",
        ...(options.flipped === undefined
          ? []
          : [
              ...(options.flipped.on.length === 0
                ? []
                : [
                    `Turned on now, on its defaults: ${options.flipped.on.join(", ")}.`,
                  ]),
              ...(options.flipped.off.length === 0
                ? []
                : [
                    `Turned off now: ${options.flipped.off.join(", ")}. Their data and timers are kept.`,
                  ]),
              ...options.flipped.failed.map(({ name, error }) =>
                couldNotLoad(name, firstLine(error)),
              ),
            ]),
      ]
    : options.swapped === undefined
      ? []
      : [
          ...(options.swapped.swapped.length === 0
            ? []
            : [`Rebuilt: ${options.swapped.swapped.join(", ")}.`]),
          ...(options.swapped.removed.length === 0
            ? []
            : [
                `Unloaded: ${options.swapped.removed.join(", ")}. Their data and timers are kept.`,
              ]),
          ...(options.swapped.swapped.length +
            options.swapped.removed.length ===
          0
            ? []
            : [`Waited ${options.swapped.waited} ms for work in flight.`]),
          ...options.swapped.interrupted.map((call) => `Interrupted: ${call}.`),
          ...options.swapped.affected.map(
            ({ session, subagents, tasks }) =>
              `${session} loses the changed tools until its turn ends (${subagents} sub-agents and ${tasks} background tasks running).`,
          ),
          appliedClosing,
        ]),
]

// chad.json. The apply's errors name the file as `work/chad.json`, the file the agent edits.

/** `chad.json` that is not JSON. */
export const settingsNotJson = (error: string) =>
  `work/chad.json is not JSON: ${error}`

/** `chad.json` whose top level is not an object. */
export const settingsNotObject = "work/chad.json is not a JSON object."

/** A top-level key other than `plugins`. */
export const settingsTopKey = (key: string) =>
  `work/chad.json has the key "${key}". "plugins" is the only top-level key.`

/** A `plugins` that is not an object. */
export const settingsPluginsNotObject =
  'work/chad.json: "plugins" is not a JSON object.'

/** An entry that names no plugin. */
export const settingsUnknownPlugin = (name: string) =>
  `work/chad.json: plugins.${name} names no plugin, bundled or in the repo.`

/** An entry that is not an object. */
export const settingsEntryNotObject = (name: string) =>
  `work/chad.json: plugins.${name} is not a JSON object.`

/** A key in an entry other than `enabled` and `settings`. */
export const settingsEntryKey = (name: string, key: string) =>
  `work/chad.json: plugins.${name} has the key "${key}". An entry has only "enabled" and "settings".`

/** An `enabled` that is not a boolean. */
export const settingsEnabled = (name: string) =>
  `work/chad.json: plugins.${name}.enabled is not true or false.`

/** A `settings` that is not an object. */
export const settingsSettings = (name: string) =>
  `work/chad.json: plugins.${name}.settings is not a JSON object.`

/** A `${NAME}` with no default that resolves nowhere, which fails the plugin's load. */
export const settingUnresolved = (name: string) =>
  `The settings name \${${name}}, which is in neither the secret store nor the daemon's environment. Save it with chad secret set ${name}.`

/** The notice of a `chad.json` that cannot be parsed at a boot. */
export const settingsUnparsable = (error: string) =>
  `\`chad.json\` can't be parsed (${error}), so every plugin is on its defaults.`

/** The notice of what a boot ignored in `chad.json`. */
export const settingsIgnored = (paths: ReadonlyArray<string>) =>
  `Ignored in \`chad.json\`: ${paths.join(", ")}.`

/** `chad plugin reload` of a plugin that is off. */
export const reloadOff = (name: string) =>
  offByDefault(name)
    ? `${name} is off until chad.json turns it on, so it is not loaded. Set "enabled": true under plugins.${name} in work/chad.json and run chad apply.`
    : `${name} is off in chad.json ("enabled": false), so it is not loaded. Turn it on in work/chad.json and run chad apply.`

/** Where one setting's value came from, never the value. */
export const settingSource = (
  sources: ReadonlyArray<
    | { readonly from: "file" | "default" }
    | { readonly from: "store" | "env" | "inline"; readonly name: string }
  >,
) =>
  sources
    .map((source) => {
      switch (source.from) {
        case "file":
          return "chad.json"
        case "default":
          return "default"
        case "store":
          return `\${${source.name}} from the secret store`
        case "env":
          return `\${${source.name}} from process env`
        case "inline":
          return `the inline default of \${${source.name}}`
      }
    })
    .join(", ")

/**
 * A plugin's settings in the output of `chad check` and `chad apply`: the keys it read while loading and where each
 * value came from, a key on its default marked "(default)", and a warning for each key it did not read.
 */
export const settingsListing = (
  name: string,
  items: ReadonlyArray<{
    readonly key: string
    readonly sources: Parameters<typeof settingSource>[0]
  }>,
  unread: ReadonlyArray<string>,
) => [
  ...(items.length === 0
    ? []
    : [
        `Settings ${name} read while loading: ${settingsStatus(items.map((item) => ({ ...item, at: "load" })))}.`,
      ]),
  ...unread.map(
    (key) =>
      `Warning: plugins.${name}.settings.${key} was not read while loading. A key that only a handler reads is not known at load, so check the spelling.`,
  ),
]

/** A loaded plugin's settings in `chad status`: the keys read at load, then those read at call time since. */
export const settingsStatus = (
  items: ReadonlyArray<{
    readonly key: string
    readonly sources: Parameters<typeof settingSource>[0]
    readonly at: "load" | "call"
  }>,
) => {
  const list = (at: "load" | "call") =>
    items
      .filter((item) => item.at === at)
      .map(({ key, sources }) =>
        sources.length === 1 && sources[0]!.from === "default"
          ? `${key} (default)`
          : `${key} (${settingSource(sources)})`,
      )
      .join(", ")
  const load = list("load")
  const call = list("call")
  return [
    ...(load === "" ? [] : [load]),
    ...(call === "" ? [] : [`read at call time: ${call}`]),
  ].join("; ")
}

/** `chad log` when the repo has no applied commit to read. */
export const logMissing =
  "There is no applied commit yet. The repo is made when chad first starts."

/** The mark `chad status` gives a plugin that kept its running version when a reload failed to build it. */
export const runningPrevious = (
  what: "owners" | "instance" | "timezone" | "secret",
  error: string,
) => `running with the previous ${what}: ${firstLine(error)}`

/** The line of `boot.setup-needed`, written when `chad serve` starts with no chat connection. */
/** `chad setup` with no terminal and an answer that is neither given nor stored, which exits 2. */
export const setupMissing = (flags: ReadonlyArray<string>) =>
  `chad setup: there is no terminal to ask on, so give ${flags.join(", ")}`

/** The token question of a run after the first, which never prints the token and names the bot. */
export const setupTokenStored = (
  connection: string,
  bot: string | undefined,
) =>
  bot === undefined
    ? `A Discord bot token is stored for connection ${connection}.`
    : `A Discord bot token is stored for connection ${connection}, the bot ${bot}.`

export const setupTokenPrompt =
  "Discord bot token (press Enter to keep the stored one)"

/** The bot a token that setup stored belongs to. */
export const setupBot = (bot: string) => `The token is the bot ${bot}'s.`

/** Whether setup turned the message content intent on, or where the owner clicks. */
export const setupIntent = (
  outcome: "on" | "already" | "portal",
  application: string | undefined,
) =>
  outcome === "on"
    ? "Message Content Intent turned on for the bot."
    : outcome === "already"
      ? "Message Content Intent is on for the bot."
      : `Turn on Message Content Intent under Privileged Gateway Intents at ${application === undefined ? "https://discord.com/developers/applications" : `https://discord.com/developers/applications/${application}/bot`}, because Discord did not let chad do it.`

export const setupOwnerPrompt = (owners: ReadonlyArray<string>) =>
  owners.length === 0
    ? "Your Discord user id"
    : `Your Discord user id (press Enter to keep ${owners.join(", ")})`

export const setupOwnerNeeded = "An owner id is needed."

/** The owner question kept the stored owners. */
export const setupOwnersKept = (
  owners: ReadonlyArray<string>,
  connection: string,
) => `The owners of ${connection} stay ${owners.join(", ")}.`

export const setupTimezonePrompt = (zone: string) =>
  `Your timezone (press Enter to keep ${zone})`

export const setupLoginOffer = "Log chad in to Codex now?"

export const setupLoginSkipped =
  "The Codex login is skipped. Run chad login when you want it."

export const setupLoggedIn = "chad is logged in to Codex."

export const setupNeeded =
  "chad has no chat connection. Add one with chad connection add."

// mcp.json and the MCP layer.

/** A call in flight when a rebuild started. */
export const mcpInterrupted = (key: string) =>
  `mcp.${key} was interrupted by an MCP restart. It may have run in part or in full.`

/** A call made during a rebuild, before the new layer is current. */
export const mcpRestarting =
  "MCP servers are restarting. This call was not sent."

/** A server that is gone from `mcp.json`. */
export const mcpRemoved = (key: string, name: string) =>
  `mcp.${key}: MCP server "${name}" was removed from mcp.json.`

/** A tool its connected server no longer lists. */
export const mcpToolGone = (key: string, name: string) =>
  `mcp.${key}: "${name}" no longer lists this tool.`

/** A server that is configured and not connected. */
export const mcpNotConnected = (key: string, name: string, error: string) =>
  `mcp.${key}: MCP server "${name}" is not connected: ${firstLine(error)}`

/** The prompt of a turn that started at boot before the first layer connected. */
export const mcpStarting =
  "MCP servers were still starting when this turn began. They are available from your next turn."

/** The most tools `mcpNextTurn` names before it counts the rest. */
export const mcpNextTurnShown = 10

/** The tools callable from the next turn, added to a `searchTools` result after a blank line. */
export const mcpNextTurn = (keys: ReadonlyArray<string>) => {
  const shown = keys.slice(0, mcpNextTurnShown).map((key) => `mcp.${key}`)
  const rest = keys.length - shown.length
  return `${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""} ${keys.length === 1 ? "is" : "are"} callable from your next turn.`
}

/** A `searchTools` call when no server of the current layer is connected. */
export const mcpNoServerConnected = "searchTools: no MCP server is connected."

/** A call made when no layer exists and none is being built. */
export const mcpNotRunning = "MCP servers are not running."

/** The status error of an entry with `"type": "sse"`. */
export const mcpSse = "SSE transport is not supported"

/** `mcp.json` that is not JSON. */
export const mcpNotJson = (error: string) => `it is not JSON: ${error}`

/** `mcp.json` whose top level is not an object. */
export const mcpNotObject = "its top level is not a JSON object"

/** An `mcpServers` that is not an object. */
export const mcpServersNotObject = '"mcpServers" is not a JSON object'

/** An entry that clanka's loader would refuse. */
export const mcpEntry = (name: string, error: string) =>
  `MCP server "${name}": ${firstLine(error)}`

/** A file that cannot be read at all. */
export const mcpFileUnreadable = (code: string) => `it cannot be read (${code})`

/** A malformed `mcp.json`, which fails an apply and a check. */
export const mcpRefused = (error: string) => `work/mcp.json: ${error}.`

/** A stdio entry whose `cwd` is relative. */
export const mcpRelativeCwdRefused = (name: string, cwd: string) =>
  `work/mcp.json: MCP server "${name}" has the relative cwd "${cwd}". Give an absolute path.`

/** The status error of a server whose `cwd` expanded to a relative path. */
export const mcpRelativeCwd = (cwd: string) =>
  `its cwd "${cwd}" is not an absolute path`

/** The status error of a server with a `${NAME}` that resolves nowhere. */
export const mcpUnresolved = (name: string) =>
  `\${${name}} is in neither the secret store nor the daemon's environment`

/** `chad check`'s warning for such a name, which leaves the check passing. */
export const mcpCheckUnresolved = (server: string, name: string) =>
  `Warning: MCP server "${server}" names \${${name}}, which is in neither the secret store nor the daemon's environment. An apply lists it as unavailable.`

/** What `chad check` says of `mcp.json` when it changed: the servers an apply would add, remove or change. */
export const mcpCheckLines = (diff: {
  readonly added: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly changed: ReadonlyArray<string>
}) => [
  ...diff.added.map((name) => `MCP server ${name}: an apply adds it.`),
  ...diff.removed.map((name) => `MCP server ${name}: an apply removes it.`),
  ...diff.changed.map((name) => `MCP server ${name}: an apply changes it.`),
  "The check connected no MCP server.",
]

/** The notice of an `mcp.json` that cannot be read at boot. */
export const mcpUnreadable = (error: string) =>
  `\`mcp.json\` can't be read (${firstLine(error)}), so no MCP servers are running.`

/** One MCP server as status and an apply show it. */
export interface McpServerState {
  readonly name: string
  readonly state: "connected" | "failed" | "starting" | "needs-login"
  readonly tools?: number
  readonly error?: string
}

/** One MCP server's line in what an apply, a secret change or `chad mcp restart` prints. */
export const mcpServerLine = (server: McpServerState) =>
  server.state === "connected"
    ? `MCP server ${server.name}: connected, ${server.tools ?? 0} tools.`
    : server.state === "failed"
      ? `MCP server ${server.name}: unavailable: ${firstLine(server.error ?? "")}`
      : server.state === "needs-login"
        ? `MCP server ${server.name}: needs login. The owner signs in with chad mcp login ${server.name}, or from the button requestMcpLogin posts in chat.`
        : `MCP server ${server.name}: starting.`

/** What a rebuild prints: each server's line, or that none is configured. */
export const mcpRebuilt = (servers: ReadonlyArray<McpServerState>) =>
  servers.length === 0
    ? ["No MCP servers are configured."]
    : servers.map(mcpServerLine)

// The OAuth sign-in of an HTTP MCP server.

/**
 * A server with an `oauth` key and no usable sign-in. It is the server's error in the layer, which the model reads in
 * its prompt, and what a call fails with when the server answers 401 and the refresh cannot fix it.
 */
export const mcpNeedsLogin = (name: string) =>
  `MCP server "${name}" needs the owner to sign in, and nothing you run can do that. Call requestMcpLogin({ server: ${JSON.stringify(name)} }) to post the sign-in button and end your turn, or ask the owner to run chad mcp login ${name}.`

/**
 * Put under the list of servers in the prompt, which was written when they connected, for each that has refused
 * chad's sign-in since. `lines` is what each needs.
 */
export const mcpLoginsLost = (lines: ReadonlyArray<string>) =>
  [
    "Whatever the list above says of them, these servers take no call now:",
    ...lines.map((line) => `- ${line}`),
  ].join("\n")

/**
 * What a connection's requests fail with once the owner has signed out of its server or signed in to it again. The
 * connection is on its way out, and it is given none of the new sign-in.
 */
export const mcpSignInReplaced = (name: string) =>
  `MCP server "${name}": the sign-in this connection ran on was ended by a sign-out or replaced by a newer one, so it sends nothing more`

/** An HTTP server with no `oauth` key that answered 401. */
export const mcpUnauthorized = (name: string) =>
  `the server refused chad as unauthorized (401). If it signs in with OAuth, add "oauth": {} to "${name}" in mcp.json and apply it, and the owner then signs in. If it takes a key, check its headers.`

/** What `chad mcp login` prints before it reads the address. */
export const mcpLoginOpen = (name: string, url: string) => [
  `Open this link in a browser and approve chad for "${name}":`,
  url,
  "The browser then goes to an address that may not load. Copy the whole address from the address bar.",
]

/** The prompt `chad mcp login` reads the address at. */
export const mcpLoginPrompt = "Paste the address (it is not shown)"

/** `chad mcp login` given no address. */
export const mcpLoginNoAddress = () => "chad mcp login: no address on stdin"

/** A sign-in that ended well, before the lines of the rebuild it starts. */
export const mcpLoggedIn = (name: string) => `Signed in to "${name}".`

/** `chad mcp logout` once the stored sign-in is gone, before the lines of the rebuild it starts. */
export const mcpLoggedOut = (name: string) =>
  `Signed out of "${name}". Its tokens and its registered client are dropped.`

/** `chad mcp logout` whose write of the store failed, with the errno code. The sign-in is still stored. */
export const mcpLogoutUnsaved = (name: string, code: string) =>
  `chad mcp logout: the sign-in to "${name}" could not be removed from the volume (${code}), so chad is still signed in. Run chad mcp logout ${name} again once the volume can be written.`

/** `chad mcp logout` of a name that holds no sign-in. */
export const mcpLogoutNothing = (name: string) =>
  `chad mcp logout: "${name}" holds no sign-in`

/** A sign-in to a name the applied `mcp.json` does not list, which safe mode makes of every name. */
export const mcpLoginUnknown = (name: string) =>
  `chad mcp login: the applied mcp.json has no server named "${name}"`

/** A sign-in to a server with no `oauth` key. */
export const mcpLoginNoOAuth = (name: string) =>
  `chad mcp login: "${name}" has no "oauth" key in mcp.json, so it takes no sign-in`

/** A sign-in to a server that expansion left unavailable. */
export const mcpLoginUnavailable = (name: string, error: string) =>
  `chad mcp login: "${name}" is unavailable: ${firstLine(error)}`

/** An address given with no sign-in to finish. */
export const mcpLoginNotStarted = (name: string) =>
  `chad mcp login: no sign-in to "${name}" is waiting for an address. Start one with chad mcp login ${name}.`

/** What was pasted is no URL. */
export const mcpLoginNotAddress = (name: string) =>
  `chad mcp login: that is not an address. Paste the whole address the browser ended on after you approved chad for "${name}".`

/** The address says the server refused. */
export const mcpLoginDenied = (name: string, reason: string) =>
  `chad mcp login: "${name}" refused the sign-in (${reason})`

/** The address carries no code. */
export const mcpLoginNoCode = (name: string) =>
  `chad mcp login: that address carries no code. Paste the whole address the browser ended on after you approved chad for "${name}".`

/** The address belongs to a sign-in a later one replaced, or to none of chad's. */
export const mcpLoginOtherState = (name: string) =>
  `chad mcp login: that address is not from the newest sign-in to "${name}". Open the newest link and paste the address it ends on.`

/** The authorization server registers no client by itself. */
export const mcpLoginNoRegistration = (name: string) =>
  `chad mcp login: the authorization server of "${name}" registers no client by itself. Register chad with it, and put the client's id in "oauth": { "clientId": ... } in mcp.json.`

/** A sign-in that a newer sign-in or a sign-out took the place of while it was under way. */
export const mcpLoginReplaced = (name: string) =>
  `chad mcp login: this sign-in to "${name}" was replaced by a newer one or ended by a sign-out. Start again.`

/** Any other failure of a sign-in's requests. */
export const mcpLoginError = (name: string, reason: string) =>
  `chad mcp login: the sign-in to "${name}" failed (${reason})`

/** Why a sign-in failed when its authorization server refused a request: the OAuth error code, and nothing else of the answer. */
export const mcpLoginAnswered = (code: string) =>
  `its authorization server answered "${code}"`

/** Why a sign-in failed when a request reached no server, with the errno code when there is one. */
export const mcpLoginUnreachable = (code: string | undefined) =>
  `the server or its authorization server could not be reached${code === undefined ? "" : `: ${code}`}`

/** Why a sign-in failed when an answer was none chad could read. The answer is not repeated. */
export const mcpLoginUnusable =
  "the server or its authorization server gave an answer chad could not use"

/** A sign-in whose requests ran past their deadline. */
export const mcpLoginTimedOut = (name: string, seconds: number) =>
  `chad mcp login: "${name}" or its authorization server did not answer in ${seconds} seconds`

export const mcpLoginOpenLabel = "Open the sign-in"

export const mcpLoginPasteLabel = "Paste the address"

/** The message chad posts once the owner pressed the sign-in button, with the link and the button of the form. */
export const mcpLoginSteps = (name: string) =>
  `To sign chad in to "${name}": open the link and approve. Your browser then goes to an address that may not load. Copy the whole address from the address bar, press "${mcpLoginPasteLabel}" and put it in the form. Do not post it in the chat.`

/** The link, in the message itself, when it is too long for a button. */
export const mcpLoginLink = (url: string) => `The link: <${url}>`

/** In place of the sign-in message, when the link fits in no message here or the message could not be posted. */
export const mcpLoginUnposted = (name: string, long: boolean) =>
  `${long ? `The sign-in link for "${name}" is too long for a message here` : `The sign-in link for "${name}" could not be posted here`}. Run \`chad mcp login ${name}\` in a shell on the server instead, which prints the link.`

/**
 * What an older `chad serve` says when `state/version` names a newer chad. `copy` is the copy of the database taken
 * before the last migration and the version written beside it, when the volume holds them. The steps are given only
 * when that version is this chad's own.
 */
export const volumeNewer = (options: {
  readonly data: string
  readonly volume: string
  readonly own: string
  readonly copy:
    { readonly path: string; readonly version: string | undefined } | undefined
}) => {
  const head = `chad serve: this volume was last written by chad ${options.volume}, which is newer than this chad ${options.own}, so chad will not start.`
  const { copy } = options
  if (copy === undefined) {
    return `${head} The volume holds no copy of the database taken before a migration (${options.data}/db/chad.db.before-migration). Run chad ${options.volume} or a newer one.`
  }
  if (copy.version === undefined || copy.version === "") {
    return `${head} ${copy.path} is the copy of the database taken before the last migration, and no version was recorded beside it, so it is not known to be this chad's. Run chad ${options.volume} or a newer one.`
  }
  if (copy.version !== options.own) {
    return `${head} ${copy.path} is the copy of the database taken before the last migration, and it belongs to chad ${copy.version}. Run chad ${options.volume} or a newer one, or chad ${copy.version} to use the copy.`
  }
  return [
    `${head} ${copy.path} is the copy of the database taken before the last migration, and it is this chad's. To go back to it, with chad stopped:`,
    `  1. Delete ${options.data}/db/chad.db-wal and ${options.data}/db/chad.db-shm.`,
    `  2. Put ${copy.path} back as ${options.data}/db/chad.db.`,
    `  3. Write ${options.own} into ${options.data}/state/version.`,
    "Everything chad stored since that migration is lost.",
  ].join("\n")
}

/** The notice of `prune-failed`, a table key, which the next prune that succeeds clears. */
export const pruneFailed = (error: string) =>
  `The nightly prune of old sessions failed: ${firstLine(error)}. chad tries again at the next run.`

/** `chad backup -` with a terminal on standard output. */
export const backupTerminal = () =>
  "chad backup: refused: standard output is a terminal, and the tar holds tokens. Redirect it to a file or a pipe, or give a path."

/** `chad backup` wrote its tar to a path. */
export const backupWritten = (path: string) => `Backup written to ${path}.`

/** `chad backup` failed. */
export const backupFailed = (error: string) =>
  `chad backup: failed: ${firstLine(error)}`

/** `chad restore` with a daemon holding the lock. */
export const restoreDaemon = (data: string) =>
  `chad restore: refused: a chad serve holds the lock on ${data}. Stop it and restore from a one-off container.`

/** `chad restore` onto a volume that holds what an owner made. */
export const restoreNotEmpty = (data: string, what: string) =>
  `chad restore: refused: ${data} is not empty: ${what}. chad restores only onto an empty volume.`

/** The tar given to `chad restore` is not a backup of chad's. */
export const restoreNotBackup = (tar: string, why: string) =>
  `chad restore: ${tar} is not a chad backup: ${why}`

/** The tar given to `chad restore` was made by a newer chad, or in a newer format. */
export const restoreNewer = (made: string, own: string) =>
  `chad restore: refused: the backup was made by chad ${made}, which is newer than this chad ${own}. Restore it with chad ${made} or a newer one.`

/** `chad restore` failed part way. */
export const restoreFailed = (error: string) =>
  `chad restore: failed: ${firstLine(error)}`

/** `chad restore` finished. */
export const restored = (data: string, made: string) =>
  `Restored a backup of chad ${made} into ${data}. Start chad serve: its first start rebuilds repo/versions, repo/live and repo/node_modules from the applied branch, installs the npm packages work/package.json names, which needs the network, and migrates the database when this chad is newer.`

/** A command, or `chad serve` as `serve`, on a volume that a cut `chad restore` left half replaced. */
export const restoreUnfinished = (command: string, data: string) =>
  `chad ${command}: refused: a chad restore into ${data} did not finish, so the volume is half replaced. Run chad restore again with the same tar.`

/** The restore lock was held for longer than the lock's busy time. */
export const restoreBusy = (command: string, data: string) =>
  `chad ${command}: refused: a chad restore or another command is writing ${data}. Try again when it is done.`
