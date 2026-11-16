import * as Messages from "./Messages.ts"
import type { ModelState, Report } from "./Rpcs.ts"

/**
 * The text of `chad status`. It is one fact to a line, as `<name>: <value>`, so that a model reads it as easily as a
 * person does.
 */

/**
 * Safe mode, the applied commit and the draft (CLI-125b to CLI-125d). A daemon that answers gives them in its report,
 * and with none the CLI reads them from `state/safe-mode`, its own `CHAD_SAFE_MODE` and the repo.
 */
export type Repository = NonNullable<Report["repository"]>

/** What `chad status` knows when it prints. */
export type View =
  /** The daemon answered. */
  (
    | { readonly daemon: "up"; readonly report: Report }
    /** The lock is free, so there is no daemon, and the rest is read from files. */
    | {
        readonly daemon: "none"
        readonly lock: string
        /** The CLI's own chad version. */
        readonly version: string
        /** What `state/version` holds, when the file is there. */
        readonly volume: string | undefined
        /** The connections `secrets/connections.json` holds. */
        readonly connections?: ReadonlyArray<Connection>
        /** The main model and the login state, as the files and the environment give them (CLI-125). */
        readonly model?: ModelState
      }
    /** The lock is held and the daemon gave no answer in time. */
    | {
        readonly daemon: "silent"
        readonly socket: string
        readonly seconds: number
        readonly version: string
        readonly volume: string | undefined
        readonly connections?: ReadonlyArray<Connection>
        readonly model?: ModelState
      }
  ) & { readonly repository?: Repository }

const safeLines: Record<Repository["safe"], string> = {
  off: "safe mode: off",
  variable: "safe mode: on (CHAD_SAFE_MODE=1)",
  toggle: "safe mode: on (chad safe on)",
}

/** Safe mode, the applied commit and the draft, a line each (CLI-125b to CLI-125d). */
const repositoryLines = (
  repository: Repository | undefined,
): ReadonlyArray<string> =>
  repository === undefined
    ? []
    : [
        safeLines[repository.safe],
        ...(repository.applied === undefined
          ? []
          : [
              `applied: ${repository.applied.commit} ${repository.applied.message}`,
            ]),
        ...(repository.draft === undefined
          ? []
          : [
              repository.draft
                ? "work: holds changes that are not applied"
                : "work: no changes since the applied commit",
            ]),
      ]

interface Connection {
  readonly name: string
  readonly kind: string
}

/** A connection as status shows it, which is its name and kind and nothing else of it. */
const named = (list: ReadonlyArray<Connection> = []) =>
  list.map(({ name, kind }) => ({ name, kind }))

const connections = (list: ReadonlyArray<Connection> = []) =>
  list.map(
    (connection) => `connection: ${connection.name} (${connection.kind})`,
  )

/** A login state as `chad status` and `chad model` write it (CLI-125, MOD-19). */
export const logins: Record<ModelState["login"], string> = {
  "logged-in": "logged in",
  "logged-out": "not logged in",
  pending: "login pending",
  "not-needed": "needs no login",
}

/** The model and the login state, as one line (CLI-125). */
const model = (state: ModelState | undefined) =>
  state === undefined ? [] : [`model: ${state.spec} (${logins[state.login]})`]

const files = (version: string, volume: string | undefined) =>
  `version: chad ${version}, volume ${volume === undefined ? "not written yet" : `written by chad ${volume}`}`

export const render = (view: View): string => {
  if (view.daemon === "none") {
    return [
      `daemon: not running (lock ${view.lock} is free)`,
      files(view.version, view.volume),
      ...repositoryLines(view.repository),
      ...model(view.model),
      ...connections(view.connections),
    ].join("\n")
  }
  if (view.daemon === "silent") {
    return [
      `daemon: starting or frozen (lock held, no answer on ${view.socket} in ${view.seconds}s)`,
      files(view.version, view.volume),
      ...repositoryLines(view.repository),
      ...model(view.model),
      ...connections(view.connections),
    ].join("\n")
  }
  const { report } = view
  return [
    `daemon: up (${report.phase})`,
    `version: chad ${report.version}, effect ${report.effect}`,
    ...report.filesystem.map((warning) => `filesystem: ${warning}`),
    ...repositoryLines(report.repository),
    ...model(report.model),
    ...connections(report.connections),
    ...plugins(report.plugins),
    ...(report.off ?? []).map((name) =>
      Messages.offPlugin(
        name,
        report.held?.find(({ plugin }) => plugin === name)?.count ?? 0,
      ),
    ),
    ...(report.held ?? [])
      .filter(({ plugin }) => !(report.off ?? []).includes(plugin))
      .map(({ plugin, count }) => Messages.timersDeletedPlugin(plugin, count)),
    ...(report.skipped ?? []).map(
      ({ name, reason }) => `plugin: ${name}, skipped (${reason})`,
    ),
    // A repo skill that hides a bundled one is marked (MCP-12, SELF-121, MCP-147).
    ...(report.hiding ?? []).map(Messages.skillHidesMark),
    ...(report.mcp ?? []).map(mcp),
    ...blocks(report),
  ].join("\n")
}

/** One line per loaded plugin, with its warnings and errors since it loaded and the latest of them (FAIL-117). */
const plugins = (list: Report["plugins"]): ReadonlyArray<string> =>
  (list ?? [])
    .map(
      ({ name, warnings, errors, latest, previous }) =>
        `plugin: ${name}, ${previous === undefined ? "" : `${previous}, `}${warnings} warnings, ${errors} errors${latest === undefined ? "" : ` (latest: ${latest})`}`,
    )
    .flatMap((line, index) => {
      const settings = (list ?? [])[index]?.settings ?? []
      return settings.length === 0
        ? [line]
        : [line, `  settings: ${Messages.settingsStatus(settings)}`]
    })

/** One line per MCP server, with its tool count or the first line of its error (CLI-125f, MCP-144). */
const mcp = (server: NonNullable<Report["mcp"]>[number]) =>
  server.state === "connected"
    ? `mcp: ${server.name}, connected, ${server.tools ?? 0} tools`
    : server.state === "failed"
      ? `mcp: ${server.name}, failed (${Messages.firstLine(server.error ?? "")})`
      : `mcp: ${server.name}, starting`

/** A time as the blocks print it: UTC, to the second. */
const time = (at: number) => `${new Date(at).toISOString().slice(0, 19)}Z`

/**
 * The "Problems" and "Recent" blocks, each a heading and then one fact to a line, after a blank line (FAIL-110,
 * FAIL-333). A daemon that sends neither block gets none.
 */
const blocks = (report: Report): ReadonlyArray<string> => {
  if (report.problems === undefined && report.recent === undefined) return []
  const problems = report.problems ?? []
  const lines = [
    "",
    "Problems",
    ...(problems.length === 0 ? ["none"] : problems),
    "",
    "Recent",
  ]
  const recent = report.recent
  if (recent === undefined || "unavailable" in recent) {
    lines.push(
      `turns: not available (${recent?.unavailable ?? "the daemon sent none"})`,
    )
  } else {
    lines.push(
      `failed in the last 24h: ${
        recent.failed.length === 0
          ? "none"
          : recent.failed
              .map((group) => `${group.count} ${group.reason}`)
              .join(", ")
      }`,
      ...recent.last.map(
        (turn) =>
          `failed turn: ${turn.turn} ${turn.reason} at ${time(turn.at)}`,
      ),
      `tokens: ${recent.today} today, ${recent.week} in the last 7 days`,
    )
  }
  if (report.started !== undefined) {
    lines.push(`started: ${time(report.started)}`)
  }
  return lines
}

/**
 * The same facts as one JSON object on one line, for `chad status --json`. `daemon` says which of the three it is,
 * and a volume that no chad has written yet is `null`.
 */
export const json = (view: View): string =>
  JSON.stringify(
    view.daemon === "up"
      ? {
          daemon: view.daemon,
          ...view.report,
          connections: named(view.report.connections),
        }
      : {
          ...view,
          volume: view.volume ?? null,
          connections: named(view.connections),
        },
  )
