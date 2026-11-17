// The bundled plugins, which ship in the image.
import type * as BundledNames from "./BundledNames.ts"
import type * as Plugins from "./daemon/Plugins.ts"
import asphodel from "./plugins/asphodel/index.ts"
import cron from "./plugins/cron/index.ts"
import requestMcpLogin from "./plugins/request-mcp-login/index.ts"
import requestSecret from "./plugins/request-secret/index.ts"
import sendFile from "./plugins/send-file.ts"
import sendMessage from "./plugins/send-message.ts"

export const bundled: ReadonlyArray<
  Plugins.Entry & { readonly name: BundledNames.Plugin }
> = [
  { name: "send-file", plugin: sendFile },
  { name: "send-message", plugin: sendMessage },
  { name: "cron", plugin: cron },
  { name: "asphodel", plugin: asphodel },
  { name: "request-secret", plugin: requestSecret },
  { name: "request-mcp-login", plugin: requestMcpLogin },
]
