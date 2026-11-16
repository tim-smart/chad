// The bundled plugins, which ship in the image (LOAD-74).
import type * as BundledNames from "./BundledNames.ts"
import type * as Plugins from "./daemon/Plugins.ts"
import cron from "./plugins/cron/index.ts"
import sendFile from "./plugins/send-file.ts"

export const bundled: ReadonlyArray<
  Plugins.Entry & { readonly name: BundledNames.Plugin }
> = [
  { name: "send-file", plugin: sendFile },
  { name: "cron", plugin: cron },
]
