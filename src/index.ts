/**
 * The chad plugin API. A plugin file imports `Plugin`, `Session` and `Turns`
 * from here, or each module by its own path: `chad/Plugin`, `chad/Session`
 * and `chad/Turns`. Nothing else in the package can be imported.
 */

/** What a plugin file exports, the functions that add to chad, and the services chad supplies. */
export * as Plugin from "./Plugin.ts"

/** The values chad hands to hooks and tool handlers: sessions, turns and how they ended. */
export * as Session from "./Session.ts"

/** The service a plugin uses to start a turn now or on a schedule. */
export * as Turns from "./Turns.ts"
