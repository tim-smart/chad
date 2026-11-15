import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"

export const VERSION = "0.1.0-proto"

export const Refused = Schema.Struct({
  _tag: Schema.Literal("Refused"),
  reason: Schema.Literals(["version", "owner"]),
  message: Schema.String
})

export class ChadRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: Schema.String }),
  Rpc.make("Status", { success: Schema.Struct({ pid: Schema.Number, version: Schema.String, queue: Schema.String }) }),
  Rpc.make("Tail", {
    payload: { count: Schema.Number, intervalMs: Schema.Number },
    success: Schema.String,
    error: Refused,
    stream: true
  }),
  Rpc.make("Apply", {
    payload: { label: Schema.String, loadMs: Schema.Number, swapDelayMs: Schema.Number },
    success: Schema.String,
    error: Refused,
    stream: true
  }),
  Rpc.make("Reload", { success: Schema.String, error: Refused })
) {}
