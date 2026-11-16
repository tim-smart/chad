// The bundled plugins, which ship in the image (LOAD-74). cron arrives with the timers-cron slice.
import type * as BundledNames from "./BundledNames.ts"
import type * as Plugins from "./daemon/Plugins.ts"
import sendFile from "./plugins/send-file.ts"

export const bundled: ReadonlyArray<
  Plugins.Entry & { readonly name: BundledNames.Plugin }
> = [{ name: "send-file", plugin: sendFile }]
