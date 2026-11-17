import { Effect, Layer } from "effect"
import * as Discord from "./Discord.ts"
import type { DaemonInputs } from "./runDaemon.ts"
import * as LocalChat from "./LocalChat.ts"
import { Volume } from "./Volume.ts"

/** The product's chat layer, which `chad serve` passes to `runDaemon`. */
export const layer: DaemonInputs["chat"] = (connection) => {
  switch (connection.kind) {
    case "local":
      return Layer.unwrap(
        Effect.gen(function* () {
          const volume = yield* Volume
          return LocalChat.layerClient(volume.localSocket)
        }),
      )
    case "discord":
      return Discord.layer(connection)
  }
}
