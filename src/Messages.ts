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
