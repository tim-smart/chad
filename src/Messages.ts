/**
 * What chad posts in chat, its CLI errors and the messages the model reads as tool results. Each template is pinned to
 * the spec's wording by a test, and a scenario refers to a message by its name here.
 */

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
