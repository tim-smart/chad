import { Console, Effect, FileSystem, Option } from "effect"
import { Command } from "effect/cli"
import * as Messages from "../../Messages.ts"
import * as TokenStore from "../../TokenStore.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import * as Files from "../Files.ts"
import * as Owner from "../Owner.ts"
import { inForce, which } from "./login.ts"

/**
 * `chad logout [codex|antigravity]`: clears the stored token of the login it names, or of the model in force's login,
 * and Codex's when that needs none. It goes through the daemon when one runs, and stops no running turn, and says so.
 */
export const logout = Command.make(
  "logout",
  { which },
  Effect.fn("logout")(function* ({ which }) {
    yield* Owner.only("logout")
    const login =
      Option.getOrUndefined(which) ??
      (yield* inForce("logout")).login ??
      "codex"
    if ((yield* Daemon.lock) === "held") {
      const client = yield* Daemon.reach("logout")
      yield* Daemon.call("logout", client.Logout({ login }))
    } else {
      yield* Files.writable("logout")
      const environment = yield* Environment
      const fs = yield* FileSystem.FileSystem
      yield* Files.locked(
        "logout",
        Effect.orDie(
          fs.remove(TokenStore.file(environment.data, login), { force: true }),
        ),
      )
    }
    yield* Console.log(Messages.loggedOut(login))
  }),
).pipe(Command.withDescription("Clear chad's Codex or Antigravity login"))
