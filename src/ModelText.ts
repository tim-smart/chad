import { Effect, FileSystem } from "effect"
import * as Paths from "./Paths.ts"

/**
 * The main model setting as text, which the CLI reads with no daemon without loading the model layer. The daemon
 * parses the same text in `daemon/Model.ts`.
 */

/** The model chad runs when `CHAD_MODEL` is unset and no override is stored (MOD-79). */
export const fallback = "openai/gpt-6-astra/medium"

/** The text of an override file: its one line, or nothing when the file is missing or empty (STO-142). */
export const readLine = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed("")
          : Effect.fail(error),
      ),
    )
  const line = text.split("\n")[0]?.trim() ?? ""
  return line === "" ? undefined : line
})

/** The main setting in force: `state/model`, then `CHAD_MODEL`, then the fallback (MOD-11). */
export const main = (data: string, model: string | undefined) =>
  Effect.map(
    readLine(Paths.model(data)),
    (stored) => stored ?? model ?? fallback,
  )

/** Whether a setting's provider needs the Codex login: `openai` with no API key (MOD-2). */
export const needsLogin = (text: string, apiKey: string | undefined) =>
  text.split("/", 1)[0] === "openai" && apiKey === undefined

/** The word of a flag of `chad model` and `/model` that clears its override (MOD-83, MOD-123). */
export const clear = "none"

/** A flag's value as a change holds it: `none` clears the override, as `null`. */
export const flagValue = (value: string) => (value === clear ? null : value)
