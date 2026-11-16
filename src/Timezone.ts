/**
 * The owner's timezone (docs/spec/10-cli.md, "Timezone"): the zone stored in `state/timezone` by `chad timezone`, else a
 * `TZ` that names a valid zone, else UTC. The file holds one line, the IANA name, written by temporary file and rename
 * (IMG-27, IMG-138, STO-16, STO-144, CLI-35, CLI-113, CLI-182 to CLI-185). The CLI and the daemon read it the same way.
 */
import { dirname, join } from "node:path"
import { DateTime, Effect, FileSystem } from "effect"

export const file = (data: string): string => join(data, "state/timezone")

/** Where the zone in force came from: the stored file, the `TZ` variable or the UTC fallback. */
export type Source = "stored" | "variable" | "fallback"

/** The zone in force and where it came from. `ignored` is a `TZ` that names no valid zone (CLI-185). */
export interface InForce {
  readonly zone: string
  readonly source: Source
  readonly ignored?: string | undefined
}

/**
 * The name `Intl` resolves a zone to, or nothing when it is no valid zone. An offset such as `+05:00` is refused,
 * though `Intl` takes it, because it is no IANA name and is wrong as a process's `TZ` (CLI-182, CLI-183).
 */
export const canonical = (zone: string): string | undefined => {
  const trimmed = zone.trim()
  if (trimmed === "" || /^[+-]/.test(trimmed)) return undefined
  try {
    const resolved = new Intl.DateTimeFormat("en-US", {
      timeZone: trimmed,
    }).resolvedOptions().timeZone
    return /^[+-]/.test(resolved) ? undefined : resolved
  } catch {
    return undefined
  }
}

/** The zone in force when nothing is stored: a valid `TZ`, else UTC. */
export const fallback = (tz: string | undefined): InForce => {
  if (tz === undefined || tz === "") return { zone: "UTC", source: "fallback" }
  const zone = canonical(tz)
  return zone === undefined
    ? { zone: "UTC", source: "fallback", ignored: tz }
    : { zone, source: "variable" }
}

/**
 * The zone in force, from the file and then `tz`. A file that is missing, cannot be read or holds no valid zone is
 * nothing stored, so a damaged file never stops a boot or a command.
 */
export const read = Effect.fnUntraced(function* (
  data: string,
  tz: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs
    .readFileString(file(data))
    .pipe(Effect.orElseSucceed(() => undefined))
  const stored = text === undefined ? undefined : canonical(text)
  const inForce: InForce =
    stored === undefined ? fallback(tz) : { zone: stored, source: "stored" }
  return inForce
})

/** Stores a zone, which is a canonical name, by temporary file and rename. */
export const write = Effect.fnUntraced(function* (data: string, zone: string) {
  const fs = yield* FileSystem.FileSystem
  const target = file(data)
  yield* fs.makeDirectory(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  yield* fs.writeFileString(temporary, zone + "\n")
  yield* fs.rename(temporary, target)
})

/** The start of the day that holds `now`, in the zone, in milliseconds since the epoch (FAIL-115). */
export const startOfDay = (now: number, zone: string): number =>
  DateTime.toEpochMillis(
    DateTime.startOf(DateTime.makeZonedUnsafe(now, { timeZone: zone }), "day"),
  )
