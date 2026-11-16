/**
 * What chad posts in chat, its CLI errors and the messages the model reads as tool results. Each template is pinned to
 * the spec's wording by a test, and a scenario refers to a message by its name here.
 */
import * as Connections from "./Connections.ts"
import type * as Failed from "./daemon/Failed.ts"
import type { Format } from "./daemon/Format.ts"

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
  `chad serve: another chad serve holds the lock on ${data}.`

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

/** What `--level` of `chad logs` takes, which the usage error for any other value names. */
export const logsLevel = () =>
  "one of all, trace, debug, info, warn, error, fatal or none"

/** What `--since` of `chad logs` takes, which the usage error for any other value names. */
export const logsSince = () =>
  "a duration such as 15m or 2h, or an ISO 8601 time"

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

/** A length of time as a notice shows it: `48s`, and `2m 5s` from a minute on. */
export const duration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** A turn was stopped (docs/spec/04-discord.md, DIS-59). */
export const stopped = (format: Format, milliseconds: number) =>
  format.subtext(`Stopped after ${duration(milliseconds)}.`)

/**
 * The prompt of a turn that a restart cut, which a resumed start sends in place of the owner's message
 * (docs/spec/03-sessions-and-turns.md, SES-102). The model reads it, and the owner never sees it.
 */
export const restartNote = () =>
  "[chad restarted while this turn was running. A script that was cut off may already have had its side effects. Check before you repeat anything, then finish the request above.]"

/** The line every failed-turn message and the give-up message end with, as the formatter's subtext (FAIL-65). */
export const turnLine = (format: Format, turn: string) =>
  format.subtext(
    `Turn ${turn}. \`chad logs --turn ${turn}\` shows what it did.`,
  )

/** chad gave up on a turn that two kills cut (docs/spec/03-sessions-and-turns.md, SES-106, FAIL-63). */
export const gaveUp = (format: Format, turn: string) =>
  `This turn was cut off by a crash twice, so I've stopped retrying it. Whatever its scripts already did is done. Send a message to carry on.\n${turnLine(format, turn)}`

/** The most of an action's text that its line in the status message shows (DIS-20). */
const statusLineChars = 120

/** How many actions the status message shows, the newest last (DIS-20). */
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
 * its subtext (DIS-20, DIS-22).
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

/** A script's line in the status message: the script's own source, cut (DIS-24). */
export const statusScript = (source: string) => {
  const line = oneLine(source)
  return line.endsWith("…") ? `${codeSpan(line.slice(0, -1))}…` : codeSpan(line)
}

/** A sub-agent's line in the status message: the start of its prompt (DIS-26). */
export const statusSubagent = (prompt: string) =>
  `Sub-agent: ${oneLine(prompt)}`

/** A compaction's line in the status message (DIS-27). */
export const statusCompaction = () => "Compacted the history"

/** The line of a model error clanka retries: its cause and the count of the turn's retries so far (DIS-28, FAIL-80). */
export const statusRetry = (cause: string, retry: number) =>
  `Model error (${cause}), retrying (${retry} so far in this turn)`

/** The line of a steering message the agent has read: its first 60 characters, on one line (DIS-30). */
export const statusRead = (text: string) =>
  `Read your message: ${Array.from(text.trim().replace(/\s+/g, " ")).slice(0, 60).join("")}`

/** The line of a turn that is resumed after a restart (DIS-32). */
export const statusRestarted = () => "Restarted mid-turn, picking it back up."

/** The first line of an error's text, cut at 200 characters, because a provider's message can be a page of JSON (FAIL-59). */
export const firstLine = (text: string): string =>
  (text.trim().split("\n", 1)[0] ?? "").trim().slice(0, 200)

/** The reasons whose failed turn posts the failed-turn message, and what that message says of each (FAIL-55 to FAIL-58). */
export type Posted = Extract<
  Failed.Reason,
  { readonly _tag: "ModelError" | "Internal" | "LoginFailed" | "UsageLimit" }
>

/** The reason of a turn chad ended at the silence bound (FAIL-57). */
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
 * The message of a turn that hit the usage limit, in place of the failed-turn message (FAIL-60). The reset time is a
 * timestamp of the platform, which takes seconds (FAIL-209), and it is left out when the error carried none (FAIL-90).
 */
export const usageLimitReached = (format: Format, resetsAt?: number) =>
  `You've reached the usage limit on this login.${resetsAt === undefined ? "" : ` It resets ${format.relativeTime(resetsAt)}.`} Wait, or move to another provider with \`/model\`.`

/**
 * The text of the `usage-limit` row, which its notice and its line under "Problems" both print (FAIL-174, FAIL-310,
 * FAIL-321, FAIL-342). The reset time is in UTC to the second, as the line's recorded time is (FAIL-336).
 */
export const usageLimitNotice = (resetsAt?: number) =>
  `This login has reached its usage limit. Scheduled runs are skipped until it resets.${resetsAt === undefined ? "" : ` It resets at ${new Date(resetsAt).toISOString().slice(0, 19)}Z.`}`

/**
 * A failed turn, as a normal message in its thread (FAIL-54, FAIL-65, DIS-104). A failed login and a usage limit have
 * their own messages in place of it (FAIL-60 to FAIL-62).
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

/** One line of `session_updates`, as the update message reads it (STO-170). */
export type Update =
  | {
      readonly turn: string
      /** How the turn ended. An `answered` line is an answer that could not be posted (FAIL-129). */
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

/** Whether a step was running when the turn ended, which a stop, a give-up and a defect cut (FAIL-130). */
const cut = (line: TurnUpdate) =>
  line.outcome === "stopped" ||
  (line.outcome === "failed" &&
    (line.failure === "GaveUp" || line.failure === "Internal"))

/**
 * The update message that tells the model what chad posted in the session's thread since the last turn it answered
 * and the owner read (FAIL-125 to FAIL-130, FAIL-332). It is clanka's `<environment-update>` form, which a compaction
 * drops. Nothing is sent when there is no line.
 */
export const update = (lines: ReadonlyArray<Update>): string | undefined => {
  const body = updateBody(lines)
  return body === undefined ? undefined : environmentUpdate([body])
}

/** One `<environment-update>` message of several sections, which a compaction drops (SWAP-117). */
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

/** `/stop` found nothing running (DIS-76). */
export const nothingRunning = (format: Format) =>
  format.subtext("Nothing is running.")

/** `/new` started a session (DIS-75). */
export const newSession = (format: Format) =>
  format.subtext(
    "New session started. Nothing from the earlier conversation carries over.",
  )

/** `/new` or `/stop` in a plain channel, where there is no session (docs/spec/03-sessions-and-turns.md, SES-148). */
export const noSession = (format: Format) =>
  format.subtext(
    "There is no session in this channel. Mention me with a message and I'll open a thread for it.",
  )

/** chad could not open a thread on a mention (DIS-77). It is a normal message. */
export const threadFailed = (reason: string) =>
  `I couldn't open a thread on that message (${reason}). I need Create Public Threads here, or you can DM me.`

/** A size in whole binary megabytes, as a notice shows it. */
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

/** A file over the limit was skipped (DIS-64). */
export const fileSkipped = (format: Format, name: string, bytes: number) =>
  format.subtext(
    `Skipped \`${name}\` (${megabytes(bytes)}). The limit is 25 MB.`,
  )

/** The data volume is short of space, the notice of the key `disk-low` (FAIL-171). */
export const diskLow = (bytes: number) =>
  `The data volume has ${megabytes(bytes)} free.`

/** chad's reply when the owner's message could not be saved because the data volume is full (FAIL-136, FAIL-219). */
export const diskFull =
  "The data volume is full, so I stopped. Free some space and send that again."

/**
 * The answer to every owner message, and the notice at boot, while the database cannot be opened or migrated (FAIL-148,
 * FAIL-149). "Problems" shows the same text.
 */
export const databaseUnusable = (error: string) =>
  `chad's database can't be used: ${error}. Sessions are off until it is fixed. \`chad status\` has the detail.`

/**
 * The line "Problems" prints for a table key: the row's text, and when chad recorded the condition as holding, in UTC
 * to the second (FAIL-320, FAIL-336).
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

/** A model setting that is not `<provider>/<model>[/<effort>]` with a provider clanka knows (MOD-8, MOD-G27). */
export const modelUnparsable = (text: string) =>
  `The model setting \`${text}\` is not <provider>/<model>[/<effort>] with a provider chad knows.`

/** The provider `claude`, which chad refuses (MOD-5). */
export const modelClaudeRefused =
  "chad does not run the provider claude, because clanka reaches Claude only through an installed Claude Code, which chad does not ship. Reach Claude through an OpenAI-compatible gateway with openai-compat/<model>."

/** `openai-compat` with no endpoint (MOD-4, MOD-G27). */
export const modelCompatNoUrl =
  "The provider openai-compat needs CHAD_OPENAI_API_URL."

/** An override that names another provider than the main model (MOD-81). */
export const modelOverrideProvider = (text: string, provider: string) =>
  `The override \`${text}\` names another provider than the main model, which runs on ${provider}.`

export { modelTrial } from "./Trial.ts"

/** A check or a trial request that had no answer by its deadline (MOD-88). */
export const modelTrialTimedOut = "no answer within the deadline"

/** One model's sentence of the `model-check-failed` notice (MOD-25, FAIL-168). */
export const modelCheckFailed = (spec: string, error: string) =>
  `The model \`${spec}\` failed its check at start (${error}). If turns fail, set another with \`/model\`.`

/** The usage line of `/model`, for words it does not take (MOD-82, MOD-123). */
export const modelUsage =
  "Use /model [<provider>/<model>[/<effort>]] [--subagent <provider>/<model>[/<effort>]|none] [--summarizer <provider>/<model>[/<effort>]|none]."

/** What `chad model` and `/model` print with no argument, one fact to a line (MOD-19, MOD-124). */
export const modelShown = (lines: {
  readonly main: string
  readonly subagent: string | undefined
  readonly summarizer: string | undefined
  readonly ignored: ReadonlyArray<string>
}) =>
  [
    `model: ${lines.main}`,
    `sub-agents: ${lines.subagent ?? "the main model"}`,
    `summarizer: ${lines.summarizer ?? "the main model"}`,
    ...lines.ignored,
  ].join("\n")

/** The main model's value in what `chad model` shows, when it cannot run (MOD-G27). */
export const modelCannotRun = (spec: string, error: string) =>
  `${spec} (cannot run: ${error})`

/** A stored override this run leaves out, in what `chad model` shows (MOD-G31, MOD-124). */
export const modelIgnored = (
  override: "subagent" | "summarizer",
  spec: string,
  error: string,
) =>
  `ignored: the ${override === "subagent" ? "sub-agent" : "summarizer"} override ${spec} (${error})`

/** A changed main model (MOD-15, MOD-124). */
export const modelNow = (spec: string) => `The model is now ${spec}.`

/** A set or cleared override (MOD-82, MOD-83, MOD-124). */
export const modelOverrideNow = (
  override: "subagent" | "summarizer",
  spec: string | undefined,
) =>
  override === "subagent"
    ? `Sub-agents now run on ${spec ?? "the main model"}.`
    : `The summarizer now runs on ${spec ?? "the main model"}.`

/** The overrides a change of provider cleared (MOD-85). */
export const modelOverridesCleared = (
  cleared: ReadonlyArray<"subagent" | "summarizer">,
  provider: string,
) =>
  `${cleared.length === 2 ? "The sub-agent and summarizer overrides were" : cleared[0] === "subagent" ? "The sub-agent override was" : "The summarizer override was"} cleared, because the main model left ${provider}.`

/** A change refused before any request, so nothing was stored (MOD-5, MOD-81, MOD-124). */
export const modelRefused = (reason: string) => `Nothing was changed: ${reason}`

/** A change whose trial request failed, so nothing was stored (MOD-16, MOD-84, MOD-88). */
export const modelTrialFailed = (spec: string, error: string) =>
  `The model ${spec} failed its trial request (${error}). Nothing was changed.`

/** A change whose login did not complete, so nothing was stored (MOD-17). */
export const modelLoginFailed = (reason: string) =>
  reason === "TimedOut"
    ? "The login timed out. Nothing was changed."
    : `The login failed (${reason}). Nothing was changed.`

/** A change whose file could not be written. The files written before it stay, and the daemon reads them again. */
export const modelNotStored = (path: string, code: string) =>
  `The change was not stored in full: ${path} could not be written (${code}).`

/** A model call needed a Codex login while chad has none and cannot post a code for one (MOD-2). */
export const loginUnavailable = "chad is not logged in to Codex."

/** The login prompt, in a thread and in the terminal (MOD-38, MOD-55, MOD-120). */
export const loginPrompt = (verifyUrl: string, code: string) =>
  `To log chad in to Codex, open ${verifyUrl} and enter the code ${code}. The code is good for 15 minutes.`

/** The notice in a thread whose turn waits on a login another thread has the code of (MOD-42, DIS-72). */
export const loginWaitingIn = (link: string) =>
  `Waiting for the login in ${link}`

/** The status line of a turn that waits on a login (MOD-100, DIS-29). */
export const statusLoginWait = "Waiting for login"

/** A waiting turn's message when the login's time ran out (MOD-45, MOD-49, MOD-75). */
export const loginTimedOut = "Login timed out. Send a message to try again."

/** A waiting turn's message when the login failed in any other way (MOD-76). */
export const loginFailed = (reason: string) =>
  `Login failed (${reason}). Send a message to try again.`

/** `chad login` with no daemon, when a daemon took the lock while the owner logged in (MOD-58, CLI-34). */
export const loginRaced =
  "a daemon started during the login, run chad login again"

/** `chad login` when the model in force needs no login (MOD-109). */
export const loginNotNeeded = (spec: string) =>
  `The model ${spec} needs no login.`

/** `chad login` when the login did not complete (MOD-108). */
export const loginCliFailed = (reason: string) =>
  reason === "TimedOut"
    ? "chad login: the login timed out, run chad login again"
    : `chad login: the login failed (${reason}), run chad login again`

/** `chad login` once the login completed (MOD-55). */
export const loggedIn = "chad is logged in to Codex."

/** `chad login` when the stored token is good, which a new login does not replace (MOD-119). */
export const alreadyLoggedIn =
  "chad is already logged in to Codex. To log in with another account, run chad logout and then chad login."

/** `chad logout`, which stops no running turn (MOD-61, CLI-111, MOD-121). */
export const loggedOut =
  "chad is logged out of Codex. A turn that is running is not stopped: it finishes on the connection it has, and the next one asks for a login."

/** A hook ran past its budget, as the first line of its failure (API-43). */
export const hookTimedOut = "ran past its budget"

/** The same hook failed 3 times in a row (FAIL-163). */
export const hookFailing = (plugin: string, hook: string, first: string) =>
  `\`${plugin}\`'s \`${hook}\` hook has failed 3 times in a row (${first}). It stays on.`

/** A plugin's tool has a name that someone else holds, which fails its load (API-33). */
export const toolTaken = (name: string, holder: string) =>
  `The tool name "${name}" is already used by ${holder}.`

/** A plugin-started turn whose thread is gone (FAIL-173). */
export const threadGone = (plugin: string, label: string) =>
  `\`${plugin}\` could not run \`${label}\` because its thread is gone.`

/** The update message's part for the chunks that changed or went (SWAP-31, SWAP-33). */
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

/** A `beforeTurn` text, as its own user message (SES-60). */
export const pluginContext = (plugin: string, text: string) =>
  `<plugin-context plugin="${plugin}">\n${text}\n</plugin-context>`

/** `Turns.start` called from a tool for the thread of its own turn (API-79, API-G17). */
export const startInOwnThread =
  "Turns.start cannot run a turn in the thread of the turn that called this tool, because that turn would wait for this one. Use Turns.queue, which returns once the turn is queued."

/** A `Turns` call whose request could not be saved (API-130, API-135, API-133, API-G17). */
export const turnNotSaved = (what: "started" | "queued", why: string) =>
  `The turn was not ${what}, because chad could not save the request: ${why}`

/** The `logged-out` notice (FAIL-175). */
export const loggedOutNotice =
  "chad is logged out. Send a message or run `chad login`. Scheduled runs are skipped until then."

/** A background task that ended after the Agent that started it was rebuilt, in clanka's own form (SWAP-134). */
export const taskEnded = (task: {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly exitCode?: number | undefined
}) =>
  `<task id="${task.id}" kind="${task.kind}" status="${task.status}"${task.exitCode === undefined ? "" : ` exitCode="${task.exitCode}"`}>
To read the output, call taskOutput(${JSON.stringify(task.id)}).
</task>`

/** A plugin kept both as a file and as a directory (LOAD-72). */
export const twoEntries = (name: string, file: string, index: string) =>
  `The plugin "${name}" has two entry files, ${file} and ${index}. Keep one of them.`

/** A plugin whose name breaks the name rule (LOAD-92). */
export const pluginName = (name: string, file: string) =>
  `The plugin name "${name}" (${file}) may hold only lower-case letters, digits and hyphens. Rename it.`

/** The line after a TS2307 for a package (LOAD-22, SELF-64). */
export const importable =
  "A plugin has no packages of its own. It can import chad, effect and Node's built-in modules, such as node:fs."

/** The last line of a failed type-check of plugins (LOAD-31). */
export const effectGuide = (path: string) =>
  `Read ${path} before you write Effect code.`

/** A plugin with top-level await (LOAD-23, SELF-63). */
export const topLevelAwait = (name: string, at: string) =>
  `${name}: top-level await at ${at}. A plugin runs as a CommonJS bundle, which has no top-level await. Move the awaited work into the plugin's Layer, for example inside Layer.effect(Effect.gen(...)).`

/** A plugin esbuild could not bundle. */
export const notBundled = (name: string, errors: ReadonlyArray<string>) =>
  [`${name}: could not be bundled`, ...errors].join("\n")

/** A bundle that threw when it ran, with the error's stack (LOAD-41). */
export const notLoaded = (name: string, stack: string) =>
  `${name} could not be loaded: ${stack}`

/**
 * A default export that is not a `Plugin` (LOAD-6). A file directly in `plugins/` with no default export is most
 * likely a helper file, and the error says where one goes (LOAD-73).
 */
export const notPlugin = (name: string, file: string, helper: boolean) =>
  helper
    ? `${name}: ${file} has no default export. Every .ts file directly in plugins/ is a plugin's entry file, so a helper file goes in a subdirectory, such as plugins/<plugin>/<helper>.ts.`
    : `${name}: the default export of ${file} is not a Plugin. Wrap it in Plugin.make(...).`

/** A plugin's Layer that did not build in time (LOAD-14, API-131). */
export const buildTimedOut = (seconds: number) =>
  `The plugin's Layer did not build within ${seconds} seconds. A Turns call made while it builds never returns, so make it in Plugin.background.`

/** The notice of a plugin skipped at boot, one for each plugin (FAIL-161, REC-101). */
export const pluginSkipped = (name: string, reason: string) =>
  `Skipped at start: \`${name}\` (${reason})\n\`chad status\` has the rest.`

/** The line of `boot.moved-aside` (IMG-46, FAIL-289). */
export const movedAside = (path: string, to: string) =>
  `${path} was not a link, so it was moved to ${to}`

/** A repo plugin that has a bundled plugin's name, which is skipped at boot (REC-42). */
export const bundledName = (name: string) =>
  `${name}: a bundled plugin has this name, so the bundled one loads and this one is skipped. The two share one key-value table, and renaming this plugin does not move its data.`

/** The refusal of a call to a tool whose version a swap took out of service (SWAP-69 to SWAP-72, REC-59). */
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

/** Message 1 (SWAP-69). */
export const toolChanged = (tool: string) =>
  `${tool} was changed by an apply. The new version is in your next turn.`

/** Message 2 (SWAP-70). */
export const toolChangedSubagent = (tool: string) =>
  `${tool} was changed by an apply. The new version is in your next turn, which cannot start while this turn has a sub-agent running.`

/** Message 3 (SWAP-71, SWAP-140). */
export const toolRemoved = (tool: string) =>
  `${tool} was removed by an apply and is gone from your next turn.`

/** Message 4 (SWAP-72, REC-59). */
export const toolSafeMode = (tool: string) => `${tool} is off in safe mode.`

/** Message 5 and message 6: a call the drain interrupted, which stopped within the wait or did not (SWAP-113, SWAP-114). */
export const toolCut = (tool: string, stopped: boolean) =>
  stopped
    ? `${tool} was interrupted by an apply, it may have partly run.`
    : `${tool} did not stop when an apply interrupted it and may still be running.`

/** The line of `swap.overrun` for a tool call (SWAP-53). */
export const overrunTool = (plugin: string, tool: string) =>
  `${tool} of ${plugin} did not stop when the swap interrupted it, so two versions of ${plugin} now overlap`

/** The line of `swap.overrun` for a hook (SWAP-53). */
export const overrunHook = (plugin: string, hook: string) =>
  `The ${hook} hook of ${plugin} did not stop when the swap interrupted it, and the plugin's hook queue has moved on to the new version`

/** The line of `swap.overrun-ended`. */
export const overrunEnded = (plugin: string, name: string) =>
  `${name} of ${plugin} ended after the swap moved on`

/** The line of `swap.close-abandoned` (FAIL-265). */
export const closeAbandoned = (plugin: string) =>
  `The close of the old version of ${plugin} ran past its deadline, and its finalizers were abandoned`

/** An apply's refusal of a repo plugin with a bundled plugin's name (SET-54, CLI-67). */
export const bundledNameRefused = (name: string) =>
  `The plugin "${name}" has the name of a bundled plugin. Rename it: the two would share one key-value table.`

/** The refusal of `AGENTS.md`, `.agents` and `.kiro` in the repo, which names where their content goes (LOAD-94, LOAD-95). */
export const instructionsRefused = (paths: ReadonlyArray<string>) =>
  `The repo holds ${paths.map((path) => `work/${path}`).join(", ")}. chad refuses AGENTS.md, .agents and .kiro in the repo, because clanka would read them without an apply. Put a skill under skills/<name>/SKILL.md and standing instructions in persona.md, then delete these.`

/** The count of the errors a failed check does not print (CLI-47). */
export const moreErrors = (count: number) => `... and ${count} more errors.`

/** A plugin whose Layer did not build, in a failed apply (REC-G13). */
export const couldNotLoad = (name: string, error: string) =>
  `${name} could not be loaded: ${error}`

/** `chad check` on a tool that `chad apply` refuses (CLI-163, CLI-164). */
export const replaceMeCheck = (tool: string) =>
  `The tool ${tool} has a description that starts with "Replace me". chad apply will refuse it: describe the tool or delete it.`

/** `chad apply` refusing that tool (SELF-54, CLI-68). */
export const replaceMeRefused = (tool: string) =>
  `The tool ${tool} has a description that starts with "Replace me". Describe the tool or delete it.`

/** A check that passed. */
export const checkPassed = "The check passed. Nothing was applied."

/** An apply or a revert with nothing changed (CLI-64, REC-142). */
export const nothingChanged = "Nothing changed. No commit was made."

/** A revert with no applied commit before the current one (REC-140). */
export const revertNoEarlier =
  "There is no applied commit before the current one to revert to."

/** A revert to a commit that is not on the `applied` branch (REC-141). */
export const revertNotApplied = (commit: string) =>
  `${commit} is not an applied commit. \`chad log\` lists them.`

/** A revert that would write over files its save did not capture, such as ignored ones (REC-139, REC-154). */
export const revertObstructed = (paths: ReadonlyArray<string>, saved: string) =>
  `The revert would write over ${paths.join(", ")} in work/, which the save at ${saved} does not hold. Nothing was reverted. Move ${paths.length === 1 ? "it" : "them"} away and run chad revert again.`

/** The message of a revert's commit, which names the commit it went back to (REC-136). */
export const revertMessage = (commit: string) => `Revert to ${commit}`

/** The session line of an apply (FAIL-177). */
export const appliedLine = (commit: string, message: string) =>
  `Applied \`${commit}\`: ${message}`

/** The session line of a revert (REC-G17). */
export const revertedLine = (commit: string, from: string) =>
  `Reverted \`${from}\` as \`${commit}\`.`

/** The session line of `chad safe on|off` (REC-G17). */
export const safeLine = (on: boolean) =>
  on ? "Safe mode is on." : "Safe mode is off."

/** What `chad safe` prints: whether safe mode is on and what turned it on (REC-129, REC-G10). */
export const safeState = (state: "off" | "variable" | "toggle") =>
  state === "off"
    ? "Safe mode is off."
    : state === "variable"
      ? "Safe mode is on, held by CHAD_SAFE_MODE=1. Nothing from the repo is loaded."
      : "Safe mode is on, turned on by chad safe on. Nothing from the repo is loaded."

/** `chad safe off` while `CHAD_SAFE_MODE=1` is set, which changes nothing (REC-128, CLI-169). */
export const safeForced =
  "CHAD_SAFE_MODE=1 is set and holds safe mode on. Nothing was changed. Unset it on the container and restart chad to turn safe mode off."

/** The line the system prompt has while safe mode is on (SELF-38, REC-58, SWAP-G10). */
export const safePrompt =
  "Safe mode is on. Nothing from the repo is loaded: no repo plugins, skills, MCP servers or persona."

/** A command that waits behind another in the queue (CLI-40). */
export const queueWaiting = (command: string) =>
  `Waiting for ${command} to finish.`

/** `chad plugin reload` of a plugin that is neither loaded nor skipped. */
export const reloadUnknown = (name: string) =>
  `No plugin named ${name} is loaded or skipped.`

/** `chad plugin reload` of a repo plugin in safe mode, which loads nothing from the repo. */
export const reloadSafe = (name: string) =>
  `Safe mode is on, so ${name} from the repo is not loaded. Turn safe mode off first.`

/** `chad plugin reload` that swapped. */
export const reloaded = (name: string) =>
  `Reloaded ${name}. Sessions pick it up on their next message.`

/** An apply that failed from its commit on (CLI-66, REC-120). */
export const failedAfterCommit = (commit: string, error: string) =>
  `The commit ${commit} was made, but the apply failed after it: ${error}. It loads at the next start.`

/** What a successful apply or revert prints (CLI-70, CLI-71, REC-62, REC-82, SWAP-78, SWAP-112). */
export const appliedOutput = (options: {
  readonly kind: "apply" | "revert" | "check"
  readonly commit: string
  readonly files: ReadonlyArray<string>
  readonly safe: boolean
  readonly saved: string | undefined
  readonly restored: boolean
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
}) => [
  `${options.kind === "revert" ? "Reverted" : "Applied"} ${options.commit}.`,
  ...(options.saved === undefined
    ? []
    : [`What work/ held is saved at ${options.saved}.`]),
  ...(options.restored
    ? []
    : [
        "A file in work/ changed or appeared after the save, so no file was put back. git diff in work/ shows how the tracked files differ from the revert.",
      ]),
  "Changed files:",
  ...options.files.map((file) => `  ${file}`),
  ...(options.safe
    ? [
        "Safe mode is on, so nothing was loaded. The change loads when safe mode goes off.",
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
          "Sessions pick the change up on their next message. This turn keeps the tools it has.",
        ]),
]

/** `chad log` when the repo has no applied commit to read. */
export const logMissing =
  "There is no applied commit yet. The repo is made when chad first starts."

/** The mark `chad status` gives a plugin that kept its running version when a reload failed to build it (SWAP-141, SWAP-142). */
export const runningPrevious = (what: "owners" | "instance", error: string) =>
  `running with the previous ${what}: ${firstLine(error)}`

/** The line of `boot.setup-needed`, written when `chad serve` starts with no chat connection (IMG-33, FAIL-288). */
export const setupNeeded =
  "chad has no chat connection. Add one with chad connection add."
