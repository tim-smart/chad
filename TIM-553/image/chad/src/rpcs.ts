import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"
import * as path from "node:path"

export const VERSION = "0.0.0-proto"
export const DATA = process.env.CHAD_DATA ?? "/data"
export const SOCKET = process.env.CHAD_SOCKET ?? path.join(DATA, "run", "chad.sock")

export const Status = Schema.Struct({
  pid: Schema.Number,
  version: Schema.String,
  phase: Schema.String,
  bootCount: Schema.Number,
  fsType: Schema.String,
  fsWarning: Schema.String,
  uptimeMs: Schema.Number,
  mcp: Schema.String
})

export class ChadRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: Schema.String }),
  Rpc.make("Status", { success: Status }),
  // Stand-in for a message arriving: starts a turn that lasts `ms`.
  Rpc.make("Turn", {
    payload: { session: Schema.String, ms: Schema.Number, mode: Schema.String, child: Schema.Boolean },
    success: Schema.String
  })
) {}
