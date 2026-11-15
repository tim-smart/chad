// PROTOTYPE (TIM-554). The daemon's RPC group, as in the TIM-550 prototype: ndjson over a unix socket.
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"

/** A call that ends the command with a non-zero exit and a line on stderr. */
export const Ended = Schema.Struct({ _tag: Schema.Literal("Ended"), exit: Schema.Number, message: Schema.String })

export class ChadRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: Schema.String }),
  // The one call that carries a value to the daemon. Nothing comes back but flags.
  Rpc.make("SecretSet", {
    payload: { name: Schema.String, value: Schema.String, totp: Schema.Boolean, note: Schema.optional(Schema.String) },
    success: Schema.Struct({ replaced: Schema.Boolean, short: Schema.Boolean, restarted: Schema.Array(Schema.String), buttons: Schema.Number }),
    error: Ended
  }),
  Rpc.make("SecretRm", { payload: { name: Schema.String }, success: Schema.Boolean, error: Ended }),
  // Returns no stored value. `code` is what the owner typed for --code and is stored nowhere.
  Rpc.make("SecretRequest", {
    payload: {
      name: Schema.optional(Schema.String),
      kind: Schema.Literals(["plain", "totp", "code"]),
      note: Schema.optional(Schema.String),
      why: Schema.optional(Schema.String),
      noWait: Schema.Boolean
    },
    success: Schema.Struct({ result: Schema.Literals(["saved", "code", "asked"]), code: Schema.optional(Schema.String), message: Schema.String }),
    error: Ended
  })
) {}
