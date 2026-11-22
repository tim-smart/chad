/**
 * The names of the bundled plugins. The CLI reads them without loading the plugins themselves, so `chad plugin new`
 * can refuse one. `src/Bundled.ts` lists the plugins under these names.
 */
export const plugins = [
  "send-file",
  "send-message",
  "cron",
  "asphodel",
  "request-secret",
  "request-mcp-login",
] as const

export type Plugin = (typeof plugins)[number]

/**
 * The bundled plugins that are off until `chad.json` turns them on with `"enabled": true`, each because it needs a
 * service next to chad that a chad on its own does not have. Safe mode reads no settings,
 * so it never loads one of these.
 */
export const offByDefault: ReadonlyArray<Plugin> = ["asphodel"]

/**
 * Bundled plugins chad no longer has. A volume from before may still name one in `chad.json`, so an entry for one is
 * passed over, at a boot and by a check, as if it were not there, unless a plugin in the repo has the name. `stale-tabs`
 * closed the idle tabs of the Compose deploy's Chromium through DevTools, which browse does itself now.
 */
export const retired: ReadonlyArray<string> = ["stale-tabs"]
