/**
 * The names of the bundled plugins. The CLI reads them without loading the plugins themselves, so `chad plugin new`
 * can refuse one (CLI-85, SET-54). `src/Bundled.ts` lists the plugins under these names.
 */
export const plugins = ["send-file", "cron"] as const

export type Plugin = (typeof plugins)[number]
