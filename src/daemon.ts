// `chad serve`. Everything the daemon does is in `runDaemon`, and this file hands it the real outside world.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Chat from "./daemon/Chat.ts"
import { runDaemon } from "./daemon/runDaemon.ts"
import { defaults } from "./Timings.ts"

process.exitCode = await runDaemon({
  chat: Chat.layer,
  httpClient: NodeHttpClient.layerUndici,
  webSocketConstructor: NodeSocket.layerWebSocketConstructor,
  timings: defaults,
})
