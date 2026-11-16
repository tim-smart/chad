/**
 * Safe mode's state (docs/spec/09-repo-and-recovery.md): the file `state/safe-mode`, which holds the one word `on`
 * and is absent when safe mode is off, and the variable `CHAD_SAFE_MODE=1`, which forces it on whatever the file
 * says. The file is read before SQLite is opened and written by temporary file and rename (STO-13 to STO-15,
 * STO-141, REC-56, REC-57, REC-127).
 */
import { dirname, join } from "node:path"
import { Effect, FileSystem } from "effect"

export const file = (data: string): string => join(data, "state/safe-mode")

/** What turned safe mode on, or `off` (REC-129). */
export type State = "off" | "variable" | "toggle"

/** Whether the variable forces safe mode on. */
export const forced = (env: Readonly<Record<string, string | undefined>>) =>
  env["CHAD_SAFE_MODE"] === "1"

/** Whether the toggle is stored as on. A file that cannot be read is off, so a boot never stops on it. */
export const stored = (data: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file(data))
    return text.trim() === "on"
  }).pipe(Effect.orElseSucceed(() => false))

/** The state from the variable and the file. The variable wins. */
export const read = (
  data: string,
  forced: boolean,
): Effect.Effect<State, never, FileSystem.FileSystem> =>
  forced
    ? Effect.succeed("variable")
    : Effect.map(stored(data), (on) => (on ? "toggle" : "off"))

/** Stores the toggle: `on` written by temporary file and rename, or the file removed. */
export const write = Effect.fnUntraced(function* (data: string, on: boolean) {
  const fs = yield* FileSystem.FileSystem
  const target = file(data)
  if (!on) return yield* fs.remove(target, { force: true })
  yield* fs.makeDirectory(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  yield* fs.writeFileString(temporary, "on\n")
  yield* fs.rename(temporary, target)
})
