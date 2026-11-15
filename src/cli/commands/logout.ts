import { Console, Effect, FileSystem } from "effect"
import { Command } from "effect/cli"
import * as Messages from "../../Messages.ts"
import * as TokenStore from "../../TokenStore.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import * as Files from "../Files.ts"
import * as Owner from "../Owner.ts"

/**
 * `chad logout`: clears the stored Codex token, through the daemon when one runs, whatever model is in force
 * (MOD-60, MOD-64, MOD-110). It stops no running turn, and says so (MOD-61, CLI-111).
 */
export const logout = Command.make(
  "logout",
  {},
  Effect.fn("logout")(function* () {
    yield* Owner.only("logout")
    if ((yield* Daemon.lock) === "held") {
      const client = yield* Daemon.reach("logout")
      yield* Daemon.call("logout", client.Logout())
    } else {
      yield* Files.writable("logout")
      const environment = yield* Environment
      const fs = yield* FileSystem.FileSystem
      yield* Files.locked(
        "logout",
        Effect.orDie(
          fs.remove(TokenStore.codexFile(environment.data), { force: true }),
        ),
      )
    }
    yield* Console.log(Messages.loggedOut)
  }),
).pipe(Command.withDescription("Clear chad's Codex login"))
