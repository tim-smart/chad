import type { Report } from "./Rpcs.ts"

/**
 * The text of `chad status`. It is one fact to a line, as `<name>: <value>`, so that a model reads it as easily as a
 * person does.
 */

/** What `chad status` knows when it prints. */
export type View =
  /** The daemon answered. */
  | { readonly daemon: "up"; readonly report: Report }
  /** The lock is free, so there is no daemon, and the rest is read from files. */
  | {
      readonly daemon: "none"
      readonly lock: string
      /** The CLI's own chad version. */
      readonly version: string
      /** What `state/version` holds, when the file is there. */
      readonly volume: string | undefined
    }
  /** The lock is held and the daemon gave no answer in time. */
  | {
      readonly daemon: "silent"
      readonly socket: string
      readonly seconds: number
      readonly version: string
      readonly volume: string | undefined
    }

const files = (version: string, volume: string | undefined) =>
  `version: chad ${version}, volume ${volume === undefined ? "not written yet" : `written by chad ${volume}`}`

export const render = (view: View): string => {
  if (view.daemon === "none") {
    return [
      `daemon: not running (lock ${view.lock} is free)`,
      files(view.version, view.volume),
    ].join("\n")
  }
  if (view.daemon === "silent") {
    return [
      `daemon: starting or frozen (lock held, no answer on ${view.socket} in ${view.seconds}s)`,
      files(view.version, view.volume),
    ].join("\n")
  }
  const { report } = view
  return [
    `daemon: up (${report.phase})`,
    `version: chad ${report.version}, effect ${report.effect}`,
    ...report.filesystem.map((warning) => `filesystem: ${warning}`),
    ...report.connections.map(
      (connection) => `connection: ${connection.name} (${connection.kind})`,
    ),
  ].join("\n")
}
