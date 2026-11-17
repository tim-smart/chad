/**
 * The names of the bundled plugins. The CLI reads them without loading the plugins themselves, so `chad plugin new`
 * can refuse one. `src/Bundled.ts` lists the plugins under these names.
 */
export const plugins = ["send-file", "cron", "asphodel"] as const

export type Plugin = (typeof plugins)[number]

/**
 * The bundled plugins that are off until `chad.json` turns them on with `"enabled": true`. Safe mode reads no settings,
 * so it never loads one of these.
 */
export const offByDefault: ReadonlyArray<Plugin> = ["asphodel"]
