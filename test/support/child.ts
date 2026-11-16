// The entry of a layer 4 daemon (docs/spec/17-testing.md, TST-27). The driver starts it as a child process, which it
// kills or stops and starts again on the same volume. Like the test entry it calls `runDaemon` from the built package,
// with the product's chat layer: the local platform and the scripted gateway live in the driver, behind sockets,
// because a process that is killed cannot hold them (TST-28).
import { writeFileSync } from "node:fs"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Duration, Layer } from "effect"
import { Socket } from "effect/socket"
import * as Chat from "../../dist/daemon/Chat.js"
import * as Plugin from "../../dist/Plugin.js"
import { start } from "./entry.ts"
import { httpClient } from "./http.ts"

/** What the driver hands the child, as JSON in `CHAD_TEST_CHILD`. */
export interface Config {
  /** The fake model server and the fake Discord REST server. */
  readonly model: string
  readonly discord: string
  /** The WebSocket server of the scripted gateway. */
  readonly gateway: string
  /** The session idle time and the message retention in milliseconds, when the scenario sets them (TST-212). */
  readonly timings: {
    readonly sessionIdle?: number | undefined
    readonly messageRetention?: number | undefined
  }
  /**
   * Where the child counts the garbage collections it forces every 200 milliseconds, for the lock check (TST-105),
   * or nothing when it forces none.
   */
  readonly gc: string | undefined
  /**
   * The asphodel fixture's settings when the scenario loads it, its `url` at the fake the driver serves. The fixture
   * gets its own HttpClient, as in layer 3, so its requests never reach the world's (TST-161).
   */
  readonly asphodel?: { readonly settings: unknown } | undefined
}

const config: Config = JSON.parse(process.env["CHAD_TEST_CHILD"] ?? "{}")
delete process.env["CHAD_TEST_CHILD"]

const collect = (globalThis as { gc?: () => void }).gc
let collections = 0
if (config.gc !== undefined && collect !== undefined) {
  const counted = config.gc
  setInterval(() => {
    collect()
    writeFileSync(counted, String(++collections))
  }, 200).unref()
}

const millis = (value: number | undefined) =>
  value === undefined ? {} : { value: Duration.millis(value) }
const idle = millis(config.timings.sessionIdle)
const retention = millis(config.timings.messageRetention)

const plugins =
  config.asphodel === undefined
    ? []
    : [
        {
          name: "asphodel",
          plugin: Plugin.make(
            (await import("../fixtures/asphodel/asphodel.ts")).default.pipe(
              Layer.provide(NodeHttpClient.layerUndici),
            ),
          ),
          settings: config.asphodel.settings,
        },
      ]

const code = await start(
  {
    chat: Chat.layer,
    plugins,
    httpClient: httpClient({ model: config.model, discord: config.discord }),
    // dfx asks for Discord's gateway, and the socket goes to the driver's server with that URL as a parameter.
    webSocketConstructor: Layer.succeed(
      Socket.WebSocketConstructor,
      (url) =>
        new WebSocket(`${config.gateway}/?url=${encodeURIComponent(url)}`),
    ),
  },
  {
    ...("value" in idle ? { sessionIdle: idle.value } : {}),
    ...("value" in retention ? { messageRetention: retention.value } : {}),
  },
)
process.exit(code)
