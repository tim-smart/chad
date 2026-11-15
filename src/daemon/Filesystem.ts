import { basename, dirname, join } from "node:path"
import { Effect, FileSystem } from "effect"
import * as Messages from "../Messages.ts"

/** One line of `/proc/self/mountinfo`: where a filesystem is mounted and what type it is. */
export interface Mount {
  readonly point: string
  readonly type: string
}

/** The mounts of a `mountinfo` text, in the file's order. */
export const mounts = (mountinfo: string): ReadonlyArray<Mount> =>
  mountinfo.split("\n").flatMap((line) => {
    const [before, after] = line.split(" - ")
    const point = before?.split(" ")[4]
    const type = after?.split(" ")[0]
    if (point === undefined || type === undefined) return []
    // The kernel writes a space, a tab, a newline and a backslash in a mount point as an octal escape.
    const unescaped = point.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    )
    return [{ point: unescaped, type }]
  })

/** The mount that holds a path, which is the longest mount point above it and the last one mounted there. */
export const holding = (
  mounts: ReadonlyArray<Mount>,
  path: string,
): Mount | undefined => {
  let found: Mount | undefined
  for (const mount of mounts) {
    const above =
      mount.point === "/" ||
      path === mount.point ||
      path.startsWith(mount.point + "/")
    if (above && mount.point.length >= (found?.point.length ?? 0)) found = mount
  }
  return found
}

/** The mount types chad treats as a network or FUSE filesystem. */
const network = new Set([
  "nfs",
  "nfs4",
  "ceph",
  "cifs",
  "smb3",
  "smbfs",
  "9p",
  "glusterfs",
  "lustre",
  "fuse",
  // A FUSE filesystem over a block device, which is how ntfs-3g mounts.
  "fuseblk",
])

const kind = (type: string): "network" | "container" | "memory" | undefined =>
  network.has(type) || type.startsWith("fuse.")
    ? "network"
    : type === "overlay"
      ? "container"
      : type === "tmpfs" || type === "ramfs"
        ? "memory"
        : undefined

/** The variables whose directories hold what the agent installs. */
const installs = ["HOME", "NPM_CONFIG_PREFIX", "XDG_CACHE_HOME"] as const

/**
 * The warnings of the filesystem check. `real` follows a path to where it really is, so the check lands on the mount
 * that holds it. The data directory warns on a network or FUSE filesystem, the container's own layer and memory. Each
 * of the three install directories warns on the container's own layer and on memory.
 */
export const warnings = (input: {
  readonly mountinfo: string
  readonly data: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly real: (path: string) => string
}): ReadonlyArray<string> => {
  const table = mounts(input.mountinfo)
  const type = (path: string) => holding(table, input.real(path))?.type
  const found: Array<string> = []
  const data = type(input.data)
  if (data !== undefined) {
    const what = kind(data)
    if (what === "network") {
      found.push(Messages.filesystemNetwork(input.data, data))
    } else if (what === "container") {
      found.push(Messages.filesystemContainer(input.data))
    } else if (what === "memory") {
      found.push(Messages.filesystemMemory(input.data, data))
    }
  }
  for (const name of installs) {
    const value = input.env[name]
    if (value === undefined || value === "") continue
    const mounted = type(value)
    const what = mounted === undefined ? undefined : kind(mounted)
    if (what === "container" || what === "memory") {
      const where =
        what === "container" ? "the container's own filesystem" : mounted!
      found.push(Messages.filesystemInstall(name, value, where, input.data))
    }
  }
  return found
}

/** Where a path really is. A part that does not exist yet is kept as it is written, under what does exist. */
export const real: (
  path: string,
) => Effect.Effect<string, never, FileSystem.FileSystem> = Effect.fnUntraced(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem
    const found = yield* fs
      .realPath(path)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (found !== undefined) return found
    const parent = dirname(path)
    return parent === path ? path : join(yield* real(parent), basename(path))
  },
)

/** The mounts of this process. A platform with no such file gets no warning. */
const mountinfo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs
    .readFileString("/proc/self/mountinfo")
    .pipe(Effect.catch(() => Effect.succeed("")))
})

/** The filesystem check as `chad serve` runs it. It reads and writes nothing on the volume. */
export const check = Effect.fnUntraced(function* (
  data: string,
  env: Readonly<Record<string, string | undefined>>,
) {
  // The paths the warnings ask about are followed first, so that the warnings themselves stay a plain function.
  const paths = [data, ...installs.map((name) => env[name] ?? "")]
  const found = new Map<string, string>()
  for (const path of paths) {
    if (path !== "") found.set(path, yield* real(path))
  }
  return warnings({
    mountinfo: yield* mountinfo,
    data,
    env,
    real: (path) => found.get(path) ?? path,
  })
})

/** The type of the filesystem that holds a path, for the message about a socket it cannot hold. */
export const typeOf = Effect.fnUntraced(function* (path: string) {
  return (
    holding(mounts(yield* mountinfo), yield* real(path))?.type ??
    "an unknown filesystem"
  )
})
