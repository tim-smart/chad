// Is a bare Flag.Boolean optional in effect/cli 4.1.4?
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Effect from "effect/Effect"

const cmd = Command.make("probe", { verbose: Flag.Boolean("verbose") }, ({ verbose }) =>
  Effect.sync(() => console.log("ran, verbose =", verbose))
)
NodeRuntime.runMain(Command.run(cmd, { version: "0" }).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<void>, {
  disableErrorReporting: true
})
