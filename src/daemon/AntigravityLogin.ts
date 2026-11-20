import {
  AntigravityAuth,
  AntigravityAuthError,
  type TokenData,
} from "clanka/AntigravityAuth"
import { AuthCodeHandler, AuthCodeHandlerError } from "clanka/AuthCodeHandler"
import {
  Cause,
  Context,
  Data,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
} from "effect"
import { HttpClient } from "effect/http"
import * as Messages from "../Messages.ts"
import { antigravityModelIds } from "../ModelSpec.ts"
import * as Logger from "./Logger.ts"

/**
 * The one Antigravity sign-in of the daemon. The owner starts it with `chad login antigravity`, which gets Google's
 * link from `start`, and hands back the code Google showed through `finish`. The PKCE verifier stays in the daemon.
 * Nothing else signs in: a turn, a trial or the check at start with no usable token fails at once.
 */

/** Why a sign-in did not complete, as the text `chad login antigravity` prints. */
export class SignInFailed extends Data.TaggedError("AntigravitySignInFailed")<{
  readonly message: string
}> {}

/** One sign-in that `start` began. */
interface Flow {
  /** Google's link, once clanka has made it. */
  readonly url: Deferred.Deferred<string>
  /** The code the owner pastes, which `finish` hands over. */
  readonly code: Deferred.Deferred<string>
  readonly done: Deferred.Deferred<TokenData, SignInFailed>
  fiber: Fiber.Fiber<unknown, unknown> | undefined
}

/** Set on the fiber of the sign-in that `start` began, which is the only one the handler hands a code to. */
const Current = Context.Reference<Flow | undefined>(
  "chad/AntigravityLogin/Current",
  { defaultValue: () => undefined },
)

export class AntigravityLogin extends Context.Service<
  AntigravityLogin,
  {
    /** What chad provides as `AntigravityAuth` to every model layer. It never signs in. */
    readonly auth: AntigravityAuth["Service"]
    /** Begins a sign-in, in place of one that is waiting, and gives Google's link. */
    readonly start: Effect.Effect<string, SignInFailed>
    /** Hands the code to the sign-in that is waiting and gives the account's model ids, or nothing when they could not be listed. */
    readonly finish: (
      code: string,
    ) => Effect.Effect<ReadonlyArray<string> | undefined, SignInFailed>
    readonly logout: Effect.Effect<void>
    /** Whether a sign-in waits for its code, as `chad status` shows it. */
    readonly pending: () => boolean
  }
>()("chad/AntigravityLogin") {}

/**
 * The sign-in over the token store and the daemon's `HttpClient`. A sign-in runs in a fiber of the daemon's scope,
 * under the daemon's timeout, so a CLI that goes between `start` and `finish` leaves it waiting until a newer `start`
 * or the timeout ends it.
 */
export const make = Effect.fnUntraced(function* (options: {
  readonly timeout: Duration.Duration
  /** How long listing the account's models may take. */
  readonly listing: Duration.Duration
  /** What a sign-in that completes clears, which is the usage limit's condition. */
  readonly signedIn: Effect.Effect<void>
}) {
  const scope = yield* Effect.scope
  const http = yield* HttpClient.HttpClient
  let flow: Flow | undefined
  /** The token the last sign-in or request gave, which a turn takes with no wait while it is good. */
  let token: TokenData | undefined
  /** Moves on each logout, so that a request that ends after it does not put its token back. */
  let epoch = 0

  const handler = AuthCodeHandler.of({
    request: Effect.fnUntraced(function* ({ url }) {
      const current = yield* Current
      if (current === undefined || current !== flow) {
        return yield* new AuthCodeHandlerError({
          message: Messages.antigravityNotSignedIn,
        })
      }
      yield* Deferred.succeed(current.url, url)
      return yield* Deferred.await(current.code)
    }),
  })
  const inner = yield* AntigravityAuth.make.pipe(
    Effect.provideService(AuthCodeHandler, handler),
  )

  /** Ends the sign-in that waits, whose `finish` hears that it was replaced. */
  const cancel = Effect.suspend(() => {
    const current = flow
    flow = undefined
    return current?.fiber === undefined
      ? Effect.void
      : Fiber.interrupt(current.fiber)
  })

  const ended = Effect.fnUntraced(function* (
    current: Flow,
    exit: Exit.Exit<TokenData, unknown>,
  ) {
    if (flow === current) flow = undefined
    if (Exit.isSuccess(exit)) {
      token = exit.value
      yield* Logger.event("model.logged-in", "A login completed", {
        login: "antigravity",
      })
      yield* options.signedIn
      return yield* Deferred.succeed(current.done, exit.value)
    }
    const error = Cause.findErrorOption(exit.cause)
    yield* Deferred.fail(
      current.done,
      new SignInFailed({
        message:
          error._tag === "Some" && error.value instanceof AntigravityAuthError
            ? Messages.antigravityLoginFailed(error.value.message)
            : error._tag === "Some" && error.value === "TimedOut"
              ? Messages.antigravityLoginTimedOut
              : Messages.antigravityLoginReplaced,
      }),
    )
  })

  const start = Effect.gen(function* () {
    yield* cancel
    const current: Flow = {
      url: Deferred.makeUnsafe(),
      code: Deferred.makeUnsafe(),
      done: Deferred.makeUnsafe(),
      fiber: undefined,
    }
    flow = current
    current.fiber = yield* inner.authenticate.pipe(
      Effect.provideService(Current, current),
      Effect.timeoutOrElse({
        duration: options.timeout,
        orElse: () => Effect.fail("TimedOut" as const),
      }),
      Effect.onExit((exit) => ended(current, exit)),
      Effect.forkIn(scope),
    )
    // The link, or how the sign-in ended before clanka made one.
    return yield* Effect.raceFirst(
      Deferred.await(current.url),
      Effect.andThen(Deferred.await(current.done), Effect.never),
    )
  })

  const finish = Effect.fnUntraced(function* (code: string) {
    const current = flow
    if (
      current === undefined ||
      !(yield* Deferred.isDone(current.url)) ||
      !(yield* Deferred.succeed(current.code, code))
    ) {
      return yield* new SignInFailed({
        message: Messages.antigravityLoginNotStarted,
      })
    }
    yield* Deferred.await(current.done)
    return yield* antigravityModelIds(auth, options.listing).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    )
  })

  /** What a caller that would need a sign-in gets, since only `start` makes one. */
  const notSignedIn = Effect.failSync(
    () =>
      new AntigravityAuthError({
        reason: "LoginFailed",
        message: Messages.antigravityNotSignedIn,
      }),
  )

  const auth = AntigravityAuth.of({
    get: Effect.suspend(() => {
      if (token !== undefined && !token.isExpired())
        return Effect.succeed(token)
      // The store's semaphore is the sign-in's until it ends, and a turn does not wait on the owner.
      if (flow !== undefined) return notSignedIn
      const started = epoch
      return inner.get.pipe(
        Effect.tap((got) =>
          Effect.sync(() => {
            if (started === epoch) token = got
          }),
        ),
      )
    }),
    authenticate: notSignedIn,
    logout: Effect.gen(function* () {
      epoch++
      token = undefined
      yield* cancel
      yield* inner.logout
    }),
  })

  return AntigravityLogin.of({
    auth,
    start,
    finish,
    logout: auth.logout,
    pending: () => flow !== undefined,
  })
})
