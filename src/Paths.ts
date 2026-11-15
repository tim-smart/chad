import { join } from "node:path"

/**
 * Where the daemon and the CLI find the volume and the socket. Both take the environment as an argument, so each side
 * reads its own in its one place.
 */

/** The data directory, which is `CHAD_DATA` and `/data` without it. */
export const data = (env: NodeJS.ProcessEnv): string =>
  env["CHAD_DATA"] ?? "/data"

/** The unix socket, which is `CHAD_SOCKET` and `run/chad.sock` on the volume without it. */
export const socket = (env: NodeJS.ProcessEnv): string =>
  env["CHAD_SOCKET"] ?? join(data(env), "run/chad.sock")

/** The daemon lock's file. */
export const lock = (data: string): string => join(data, "state/daemon.lock")

/** The database. */
export const database = (data: string): string => join(data, "db/chad.db")

/** The daemon's log file. */
export const log = (data: string): string => join(data, "logs/chad.log")

/** How many rotated log files are kept, `chad.log.1` to `chad.log.3` (FAIL-32). */
export const logKept = 3

/** The log files, oldest first: the rotated ones and then `chad.log` itself. */
export const logFiles = (data: string): ReadonlyArray<string> => [
  ...Array.from(
    { length: logKept },
    (_, index) => `${log(data)}.${logKept - index}`,
  ),
  log(data),
]

/** The thread a notice outside a turn is posted in, as one JSON line (STO-121, FAIL-159). */
export const noticeThread = (data: string): string =>
  join(data, "state/notice-thread")

/** The mark that the unusable database's notice was sent, so that a restart does not send it again (STO-186, FAIL-225). */
export const dbUnusable = (data: string): string =>
  join(data, "state/db-unusable")

/** The file that holds the chad version that last wrote the volume. */
export const version = (data: string): string => join(data, "state/version")

/**
 * The most bytes a unix socket path holds on the platform chad runs on. It is 103 on macOS and 107 on Linux, and never
 * a fixed 107.
 */
export const socketLimit = (
  platform: NodeJS.Platform = process.platform,
): number => (platform === "darwin" ? 103 : 107)

/** The length of a socket path in bytes when it passes the platform's limit. */
export const socketTooLong = (
  path: string,
  platform: NodeJS.Platform = process.platform,
): { readonly bytes: number; readonly limit: number } | undefined => {
  const bytes = Buffer.byteLength(path)
  const limit = socketLimit(platform)
  return bytes > limit ? { bytes, limit } : undefined
}
