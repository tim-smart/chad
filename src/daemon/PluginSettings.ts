/**
 * What the daemon does with `chad.json`: the read a boot makes with its notices, and the
 * entries each plugin loads as. The file's own rules are in `src/Settings.ts`.
 */
import { Effect, FileSystem, Option } from "effect"
import * as Messages from "../Messages.ts"
import * as Secrets from "../Secrets.ts"
import * as Settings from "../Settings.ts"
import type * as Loader from "./Loader.ts"
import * as Logger from "./Logger.ts"
import type * as Notices from "./Notices.ts"
import type * as Plugins from "./Plugins.ts"

/** The notice keys of a file a boot could not parse and of what a boot ignored. */
export const unparsableKey = "settings-unparsable"
export const ignoredKey = "settings-ignored"

/**
 * The applied `chad.json` as a boot reads it. Nothing in it stops the boot: a file that cannot be read or parsed counts
 * as empty, and what does not fit is ignored, each with a notice and a log line. In safe mode only `"enabled": false`
 * of a bundled plugin is used, a bad `enabled` counts as on, and nothing is announced, since the file is not otherwise
 * read.
 */
export const atBoot = Effect.fnUntraced(function* (options: {
  /** The applied tree, or nothing when there is none. */
  readonly tree: string | undefined
  /** Every plugin's name, bundled or in the tree. */
  readonly known: ReadonlySet<string>
  readonly safe: boolean
  readonly notices: Notices.Notices["Service"]
}) {
  const read =
    options.tree === undefined
      ? { _tag: "Text" as const, text: undefined }
      : yield* Settings.read(options.tree)
  const result =
    read._tag === "Unreadable"
      ? { file: Settings.empty, unparsable: read.error, ignored: [] }
      : Settings.lenient(read.text, options.safe ? undefined : options.known)
  if (options.safe) return result.file
  yield* announce(options.notices, result)
  return result.file
})

/** Raises or clears the two notices for what a boot made of the file. */
export const announce = (
  notices: Notices.Notices["Service"],
  result: {
    readonly unparsable: string | undefined
    readonly ignored: ReadonlyArray<string>
  },
) =>
  Effect.gen(function* () {
    if (result.unparsable === undefined) {
      yield* notices.clear(unparsableKey)
    } else {
      yield* Logger.event(
        "settings.unparsable",
        "chad.json could not be parsed at boot",
        { error: result.unparsable },
      )
      yield* notices.raise({
        key: unparsableKey,
        text: Messages.settingsUnparsable(result.unparsable),
      })
    }
    if (result.ignored.length === 0) {
      yield* notices.clear(ignoredKey)
    } else {
      yield* Logger.event(
        "settings.ignored",
        "Entries in chad.json were ignored at boot",
        { ignored: result.ignored.join(",") },
      )
      yield* notices.raise({
        key: ignoredKey,
        text: Messages.settingsIgnored(result.ignored),
      })
    }
  })

/**
 * The plugins that load, each with its settings from the file: the bundled ones and those of the tree, less those the
 * file turns off or that are off by default. In safe mode only the bundled ones load, on their defaults, less those that
 * are off by default.
 * A bundled entry given its settings by the caller keeps them when the file gives none, which is how a test hands a
 * bundled plugin its settings.
 */
export const entries = (options: {
  readonly file: Settings.File
  readonly bundled: ReadonlyArray<Plugins.Entry>
  readonly repo: ReadonlyArray<Loader.Loaded>
  readonly safe: boolean
}): ReadonlyArray<Plugins.Entry> => {
  const off = Settings.off(options.file, options.safe)
  const all: ReadonlyArray<Plugins.Entry> = options.safe
    ? options.bundled
    : [
        ...options.bundled,
        ...options.repo.map(({ name, plugin, bundle }) => ({
          name,
          plugin,
          bundle,
        })),
      ]
  return all
    .filter(({ name }) => !off.has(name))
    .map((entry) => {
      const settings = options.safe
        ? undefined
        : options.file.plugins[entry.name]?.settings
      return settings === undefined ? entry : { ...entry, settings }
    })
}

/**
 * The lookup of a `${NAME}`: the secret store on the volume, read at each lookup, then the daemon's environment
 * as it started. A store value is only returned and never put in the environment.
 */
export const lookup =
  (
    data: string,
    env: Readonly<Record<string, string | undefined>>,
    fs: FileSystem.FileSystem,
  ) =>
  (
    variable: string,
  ): Effect.Effect<
    Option.Option<{ readonly value: string; readonly from: Settings.From }>,
    Secrets.SecretsError
  > =>
    Secrets.lookup(
      data,
      env,
    )(variable).pipe(Effect.provideService(FileSystem.FileSystem, fs))

/**
 * The plugins whose settings in a file name a secret, before expansion, which a secret change reloads. A plugin that
 * is off is left out.
 */
export const users = (
  file: Settings.File,
  secret: string,
): ReadonlyArray<string> => {
  const off = Settings.off(file)
  return Object.entries(file.plugins)
    .filter(
      ([plugin, entry]) =>
        !off.has(plugin) && Settings.names(entry.settings).has(secret),
    )
    .map(([plugin]) => plugin)
    .sort()
}
