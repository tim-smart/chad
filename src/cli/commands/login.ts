import { dirname } from "node:path"
import { CodexAuth } from "clanka/CodexAuth"
import { DeviceCodeHandler } from "clanka/DeviceCodeHandler"
import { Console, Duration, Effect, FileSystem, Stream } from "effect"
import { Command } from "effect/cli"
import { KeyValueStore } from "effect/persistence"
import * as Lock from "../../Lock.ts"
import * as Messages from "../../Messages.ts"
import { Timings } from "../../Timings.ts"
import * as TokenStore from "../../TokenStore.ts"
import * as Account from "../Account.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Files from "../Files.ts"
import * as Owner from "../Owner.ts"

const failed = (reason: string) =>
  new Failure({
    code: ExitCode.failed,
    message: Messages.loginCliFailed(reason),
  })

/**
 * The login through a running daemon, which runs it and owns its timeout. The CLI prints the code it hears and waits
 * with no deadline of its own, and a CLI that is killed ends only its own wait (MOD-56, MOD-59, MOD-107).
 */
const throughDaemon = Effect.gen(function* () {
  const client = yield* Daemon.reach("login")
  yield* Daemon.call(
    "login",
    client
      .Login()
      .pipe(
        Stream.runForEach((event) =>
          Console.log(
            event._tag === "Code"
              ? Messages.loginPrompt(event.verifyUrl, event.code)
              : event.outcome === "not-needed"
                ? Messages.loginNotNeeded(event.spec)
                : event.outcome === "already"
                  ? Messages.alreadyLoggedIn
                  : Messages.loggedIn,
          ),
        ),
      ),
  ).pipe(
    Effect.catchTag("LoginFailed", (error) =>
      Effect.fail(failed(error.reason)),
    ),
  )
})

/**
 * The login with no daemon. The CLI runs the device flow itself over the token store, and takes the daemon's lock
 * only to store the token, so a daemon that started meanwhile wins and the command fails (MOD-57, MOD-58). Its
 * timeout is the daemon's, from `Timings` (MOD-108). `chad model <spec>` with no daemon runs the same login (MOD-90).
 */
export const alone = Effect.gen(function* () {
  yield* Files.writable("login")
  const { spec, needsLogin } = yield* Account.model
  if (!needsLogin) return yield* Console.log(Messages.loginNotNeeded(spec))
  const environment = yield* Environment
  const timings = yield* Timings
  const fs = yield* FileSystem.FileSystem
  yield* Effect.orDie(
    fs.makeDirectory(dirname(environment.lock), { recursive: true }),
  )
  const store = yield* Effect.orDie(
    Effect.gen(function* () {
      return yield* KeyValueStore.KeyValueStore
    }).pipe(Effect.provide(TokenStore.layer(environment.data))),
  )
  const raced = new Failure({
    code: ExitCode.failed,
    message: Messages.loginRaced,
  })
  const guarded = TokenStore.guarded(
    store,
    Effect.suspend(() => {
      const release = Lock.take(environment.lock, Duration.zero)
      return release === undefined ? Effect.die(raced) : Effect.succeed(release)
    }),
  )
  let told = false
  const auth = yield* CodexAuth.make.pipe(
    Effect.provideService(KeyValueStore.KeyValueStore, guarded),
    Effect.provideService(
      DeviceCodeHandler,
      DeviceCodeHandler.of({
        onCode: ({ verifyUrl, deviceCode }) => {
          told = true
          return Console.log(Messages.loginPrompt(verifyUrl, deviceCode))
        },
      }),
    ),
  )
  yield* auth.get.pipe(
    Effect.timeoutOrElse({
      duration: timings.modelLogin,
      orElse: () => Effect.fail(failed("TimedOut")),
    }),
    Effect.catchTag("CodexAuthError", (error) =>
      Effect.fail(failed(error.reason)),
    ),
    // The lock taken when the token is stored dies inside clanka, which stores with `orDie`.
    Effect.catchDefect((defect) =>
      defect instanceof Failure ? Effect.fail(defect) : Effect.die(defect),
    ),
  )
  yield* Console.log(told ? Messages.loggedIn : Messages.alreadyLoggedIn)
})

/** `chad login`: the Codex login, through the daemon when one runs (MOD-55 to MOD-58, MOD-62, MOD-64). */
export const login = Command.make(
  "login",
  {},
  Effect.fn("login")(function* () {
    yield* Owner.only("login")
    return yield* (yield* Daemon.lock) === "held" ? throughDaemon : alone
  }),
).pipe(Command.withDescription("Log chad in to Codex"))
