import { dirname } from "node:path"
import { AntigravityAuth } from "clanka/AntigravityAuth"
import { AuthCodeHandler } from "clanka/AuthCodeHandler"
import { CodexAuth } from "clanka/CodexAuth"
import { DeviceCodeHandler } from "clanka/DeviceCodeHandler"
import { Console, Effect, FileSystem, Option, Stream } from "effect"
import { Argument, Command } from "effect/cli"
import { KeyValueStore } from "effect/persistence"
import * as Messages from "../../Messages.ts"
import { type LoginKind, loginKinds } from "../../ModelText.ts"
import { Timings } from "../../Timings.ts"
import * as TokenStore from "../../TokenStore.ts"
import * as Account from "../Account.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Files from "../Files.ts"
import * as Owner from "../Owner.ts"
import * as Token from "../Token.ts"

const failed = (reason: string) =>
  new Failure({
    code: ExitCode.failed,
    message: Messages.loginCliFailed(reason),
  })

/**
 * The login through a running daemon, which runs it and owns its timeout. The CLI prints the code it hears and waits
 * with no deadline of its own, and a CLI that is killed ends only its own wait.
 */
export const throughDaemon = Effect.gen(function* () {
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
              : event.outcome === "already"
                ? Messages.alreadyLoggedIn
                : Messages.loggedIn("codex"),
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
 * clanka's login with no daemon, over the token store. The code goes to the terminal, and the daemon's lock is taken
 * only to store the token, so a daemon that started meanwhile wins and the command fails, and so does
 * a `chad restore` that was cut meanwhile. `chad model <spec>` with no daemon runs its login and its trial
 * request on it.
 */
export const terminal = Effect.fnUntraced(function* (command: string) {
  const guarded = yield* tokenStore(command)
  let told = false
  const handler = DeviceCodeHandler.of({
    onCode: ({ verifyUrl, deviceCode }) => {
      told = true
      return Console.log(Messages.loginPrompt(verifyUrl, deviceCode))
    },
  })
  const auth = yield* CodexAuth.make.pipe(
    Effect.provideService(KeyValueStore.KeyValueStore, guarded),
    Effect.provideService(DeviceCodeHandler, handler),
  )
  return {
    auth,
    store: guarded,
    handler,
    /** Whether the login asked for a code. */
    told: () => told,
  }
})

/**
 * The token store with no daemon, whose every write first takes the daemon's lock, so a daemon that started meanwhile
 * wins and the command fails.
 */
const tokenStore = Effect.fnUntraced(function* (command: string) {
  const environment = yield* Environment
  const fs = yield* FileSystem.FileSystem
  yield* Effect.orDie(
    fs.makeDirectory(dirname(environment.lock), { recursive: true }),
  )
  const store = yield* Effect.orDie(
    KeyValueStore.KeyValueStore.pipe(
      Effect.provide(TokenStore.layer(environment.data)),
    ),
  )
  // clanka stores with `orDie`, so a refusal is a defect that `run` turns back into the command's failure.
  return TokenStore.guarded(
    store,
    Files.take(command, Messages.loginRaced).pipe(
      Effect.orDie,
      Effect.provideService(Environment, environment),
      Effect.provideService(FileSystem.FileSystem, fs),
    ),
  )
})

/**
 * A login with no daemon, under the daemon's timeout from `Timings`. The command's own failure comes back out of
 * clanka, which the lock taken when the token is stored dies inside, since clanka stores with `orDie`.
 */
const bounded = Effect.fnUntraced(function* <A, E, R, E2>(
  login: Effect.Effect<A, E, R>,
  timedOut: () => E2,
) {
  const timings = yield* Timings
  return yield* login.pipe(
    Effect.timeoutOrElse({
      duration: timings.modelLogin,
      orElse: () => Effect.fail(timedOut()),
    }),
    Effect.catchDefect((defect) =>
      defect instanceof Failure ? Effect.fail(defect) : Effect.die(defect),
    ),
  )
})

/** The login on `terminal`'s login. It fails with the command's failure for the reason the login did not complete. */
export const run = <E>(
  auth: CodexAuth["Service"],
  failed: (reason: string) => E,
) =>
  bounded(
    auth.get.pipe(
      Effect.catchTag("CodexAuthError", (error) =>
        Effect.fail(failed(error.reason)),
      ),
    ),
    () => failed("TimedOut"),
  )

/** The Codex login with no daemon, which the CLI runs itself on `terminal`. */
export const alone = Effect.gen(function* () {
  yield* Files.writable("login")
  const { auth, told } = yield* terminal("login")
  yield* run(auth, failed)
  yield* Console.log(
    told() ? Messages.loggedIn("codex") : Messages.alreadyLoggedIn,
  )
})

const signInFailed = (message: string) =>
  new Failure({ code: ExitCode.failed, message })

/**
 * The code Google shows once the owner approves, from a prompt that echoes nothing, or from stdin when it is not a
 * terminal. It is never an argument, since it signs chad in.
 */
const readCode = Effect.gen(function* () {
  const code = (yield* Token.entered(Messages.antigravityLoginPrompt)).trim()
  if (code === "") {
    return yield* new Failure({
      code: ExitCode.usage,
      message: Messages.antigravityLoginNoCode,
    })
  }
  return code
})

/**
 * The Antigravity sign-in through a running daemon, in two calls: the first begins it and gives the link, and the
 * second hands over the code. The verifier the code is checked against never leaves the daemon.
 */
const antigravityThroughDaemon = Effect.gen(function* () {
  const client = yield* Daemon.reach("login")
  const { url } = yield* Daemon.call("login", client.AntigravityLoginStart())
  yield* Console.log(Messages.antigravityLoginOpen(url))
  const code = yield* readCode
  const { models } = yield* Daemon.call(
    "login",
    client.AntigravityLoginFinish({ code }),
  )
  yield* Console.log(Messages.antigravitySignedIn(models))
}).pipe(
  Effect.catchTag("AntigravityLoginFailed", (error) =>
    Effect.fail(signInFailed(error.message)),
  ),
)

/** The Antigravity sign-in with no daemon, over the token store, with the daemon's timeout from `Timings`. */
const antigravityAlone = Effect.gen(function* () {
  yield* Files.writable("login")
  const timings = yield* Timings
  const store = yield* tokenStore("login")
  const context = yield* Effect.context<Effect.Services<typeof readCode>>()
  const handler = AuthCodeHandler.of({
    request: ({ url }) =>
      Console.log(Messages.antigravityLoginOpen(url)).pipe(
        Effect.andThen(readCode),
        // The command's own failure, which `bounded` gives back.
        Effect.orDie,
        Effect.provideContext(context),
      ),
  })
  const auth = yield* AntigravityAuth.make.pipe(
    Effect.provideService(KeyValueStore.KeyValueStore, store),
    Effect.provideService(AuthCodeHandler, handler),
  )
  yield* bounded(
    auth.authenticate.pipe(
      Effect.catchTag("AntigravityAuthError", (error) =>
        Effect.fail(
          signInFailed(Messages.antigravityLoginFailed(error.message)),
        ),
      ),
    ),
    () => signInFailed(Messages.antigravityLoginTimedOut),
  )
  // The model layer is loaded here, so that no other command pays for it at its start.
  const { antigravityModelIds } = yield* Effect.promise(
    () => import("../../ModelSpec.ts"),
  )
  yield* Console.log(
    Messages.antigravitySignedIn(
      yield* antigravityModelIds(auth, timings.modelTrial),
    ),
  )
})

/** A login, through the daemon when one runs. */
export const loginTo = Effect.fnUntraced(function* (kind: LoginKind) {
  const held = (yield* Daemon.lock) === "held"
  return yield* kind === "codex"
    ? held
      ? throughDaemon
      : alone
    : held
      ? antigravityThroughDaemon
      : antigravityAlone
})

/** The main model in force and the login it needs: the daemon's when one runs, and the files' otherwise. */
export const inForce = Effect.fnUntraced(function* (command: string) {
  if ((yield* Daemon.lock) === "free") return yield* Account.model
  const client = yield* Daemon.reach(command)
  return yield* Daemon.call(command, client.ModelLogin())
})

/** The login `chad login` and `chad logout` name, which is the login of the model in force when none is named. */
export const which = Argument.Literals("login", loginKinds).pipe(
  Argument.withDescription(
    "codex or antigravity, the login of the model in force when left out",
  ),
  Argument.optional,
)

/** `chad login [codex|antigravity]`: the Codex login or the Antigravity sign-in, through the daemon when one runs. */
export const login = Command.make(
  "login",
  { which },
  Effect.fn("login")(function* ({ which }) {
    yield* Owner.only("login")
    if (Option.isSome(which)) return yield* loginTo(which.value)
    const { spec, login } = yield* inForce("login")
    if (login === undefined) {
      return yield* Console.log(Messages.loginNotNeeded(spec))
    }
    return yield* loginTo(login)
  }),
).pipe(Command.withDescription("Log chad in to Codex or Antigravity"))
