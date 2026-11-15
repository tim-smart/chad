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
