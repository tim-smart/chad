import {
  CodexAuth,
  type CodexAuthError,
  type TokenData,
} from "clanka/CodexAuth"
import { DeviceCodeHandler } from "clanka/DeviceCodeHandler"
import { Context, Data, Deferred, type Duration, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import * as Messages from "../Messages.ts"
import * as Logger from "./Logger.ts"

/**
 * Set on a fiber that asks the login for a token with no owner present, as the check at start does. Such a fiber
 * starts no device flow and joins none: clanka answers a refresh that failed by clearing the token and asking for a
 * device code, and the client below refuses that request before it leaves (MOD-94).
 */
export const Unattended = Context.Reference<boolean>("chad/Login/Unattended", {
  defaultValue: () => false,
})

/** The device flow's endpoints on the issuer, whatever base URL the login puts in front of them. */
const deviceFlow = "/api/accounts/deviceauth/"

/** The `HttpClient` of the one Codex login: the daemon's own, refusing a device flow on an unattended fiber. */
export const client = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.mapRequestEffect(
      client,
      Effect.fnUntraced(function* (request) {
        const unattended = yield* Unattended
        if (unattended && request.url.includes(deviceFlow)) {
          return yield* Effect.die(new Error(Messages.loginUnavailable))
        }
        return request
      }),
    ),
  ),
)

/**
 * The handler of clanka's other logins, which chad does not run (MOD-7, MOD-G34). Such a login ends as a defect and
 * nothing is posted.
 */
export const otherLogins = DeviceCodeHandler.of({
  onCode: () => Effect.die(new Error(Messages.loginUnavailable)),
})

/** The session a turn runs in, as the login sees it: where its code and its notices go. */
export interface SessionRef {
  readonly id: string
  /** Whether an owner's message started the turn. Only such a turn is told of a login (MOD-42). */
  readonly ownerPresent: boolean
  /** A link to the session's thread, as its platform writes one. */
  readonly link: string
  /** Posts a message in the session's thread. */
  readonly post: (markdown: string) => Effect.Effect<void>
  /** Posts a notice in subtext in the session's thread. */
  readonly notice: (line: string) => Effect.Effect<void>
  /** The session's running turn waits on a login that has a code: its status line and its log line (MOD-100). */
  readonly waiting: Effect.Effect<void>
}

/**
 * The session whose turn asks for a token, set around the build of its model layer and around the turn, so that the
 * handler knows which thread asked (MOD-34, MOD-35). It is nothing outside a turn, and the code then goes by the
 * notice route (MOD-36).
 */
export const CurrentSession = Context.Reference<SessionRef | undefined>(
  "chad/Login/CurrentSession",
  { defaultValue: () => undefined },
)

/** What the owner opens and enters to log in. */
export interface Prompt {
  readonly verifyUrl: string
  readonly code: string
}

/** chad's own end of a login whose time ran out (MOD-44, MOD-75), which is no `CodexAuthError` (MOD-G23). */
export class TimedOut extends Data.TaggedError("LoginTimedOut")<{}> {
  override get message() {
    return Messages.loginTimedOut
  }
}

/** How a `chad login` through the daemon ended: a new login, or the token that was good already (MOD-119). */
export type Outcome = "logged-in" | "already"

/** One waiter on a login: a turn's session, or a `chad login` that prints the code. */
interface Waiter {
  readonly session: SessionRef | undefined
  readonly print: ((prompt: Prompt) => Effect.Effect<void>) | undefined
  told: boolean
}

/** The one login of the process while it runs (MOD-41). */
interface Flow {
  readonly done: Deferred.Deferred<TokenData, CodexAuthError | TimedOut>
  /** The session that started it, whose thread gets the code, or nothing for a `chad login` (MOD-38, MOD-118). */
  readonly leader: SessionRef | undefined
  prompt: Prompt | undefined
  /** The link to the thread the code went to, which the other threads' notice names (MOD-42, MOD-118). */
  link: string | undefined
  readonly waiters: Set<Waiter>
  /** The sessions told of this login already, which get no second notice. */
  readonly noticed: Set<string>
}

export class Login extends Context.Service<
  Login,
  {
    /** What chad provides as `CodexAuth` to every model layer: clanka's login behind the one shared wait. */
    readonly auth: CodexAuth["Service"]
    /**
     * `chad login`, and a `chad model` or `/model` that needs the login: joins a pending login or starts one, and
     * prints the code (MOD-56, MOD-92, MOD-107). A login it starts posts its code to `leader` when there is one, which
     * is where a `/model` was typed (MOD-91), and by the notice route when there is none (MOD-118).
     */
    readonly login: (
      print: (prompt: Prompt) => Effect.Effect<void>,
      leader?: SessionRef,
    ) => Effect.Effect<Outcome, CodexAuthError | TimedOut>
    /** `chad logout` through the daemon (MOD-60). */
    readonly logout: Effect.Effect<void>
    /** Whether a login with a code is pending for a session, which hides its retries (MOD-50, MOD-102). */
    readonly pendingFor: (session: string) => boolean
    /** Whether a login with a code is pending at all, as `chad status` shows it (CLI-125). */
    readonly pending: () => boolean
  }
>()("chad/Login") {}

/**
 * The one Codex login of the daemon (05-model-and-login.md). The first caller that needs a token starts clanka's
 * `get` in a fiber of the daemon's scope, and every other caller awaits the same result. The timeout is on that one
 * fiber, so a waiter that goes, a killed CLI or a stopped turn, never ends the login and never starts a second one
 * (MOD-41, MOD-45, MOD-51, MOD-101). It needs the daemon's `HttpClient` and the token store.
 */
export const make = Effect.fnUntraced(function* (options: {
  readonly timeout: Duration.Duration
  /** Posts a text by the notice route and gives the link of the thread it went to, or nothing (MOD-36). */
  readonly announce: (text: string) => Effect.Effect<string | undefined>
}) {
  const scope = yield* Effect.scope
  let flow: Flow | undefined
  /** The token the last login gave, which a turn takes with no wait while it is good. */
  let token: TokenData | undefined
  /** Moves on each logout, so that a login that ends after it does not put its token back. */
  let epoch = 0

  /** A waiter learns of the code: the terminal prints it, and a turn's thread gets its status line and notice. */
  const greet = (current: Flow, waiter: Waiter) =>
    Effect.gen(function* () {
      const prompt = current.prompt
      if (prompt === undefined) return
      waiter.told = true
      if (waiter.print !== undefined) yield* waiter.print(prompt)
      const session = waiter.session
      if (session === undefined) return
      yield* session.waiting
      if (
        session.id === current.leader?.id ||
        !session.ownerPresent ||
        current.noticed.has(session.id) ||
        current.link === undefined ||
        // The thread the code went to by the notice route has it already (MOD-118).
        current.link === session.link
      ) {
        return
      }
      current.noticed.add(session.id)
      yield* session.notice(Messages.loginWaitingIn(current.link))
    })

  /** clanka's handler: the code goes to the leader's thread, or by the notice route, and every waiter is told. */
  const handler = DeviceCodeHandler.of({
    onCode: ({ verifyUrl, deviceCode }) =>
      Effect.gen(function* () {
        const current = flow
        if (current === undefined) return
        current.prompt = { verifyUrl, code: deviceCode }
        const text = Messages.loginPrompt(verifyUrl, deviceCode)
        const leader = current.leader
        if (leader === undefined) {
          current.link = yield* options.announce(text)
        } else {
          current.noticed.add(leader.id)
          yield* leader.post(text)
          current.link = leader.link
        }
        for (const waiter of current.waiters) yield* greet(current, waiter)
      }),
  })

  const inner = yield* CodexAuth.make.pipe(
    Effect.provideService(DeviceCodeHandler, handler),
    Effect.provide(client),
  )

  /** The login that runs, or a new one, and whether it is new. Taken in one step, so two callers cannot both start. */
  const take = (leader: SessionRef | undefined) =>
    Effect.sync(() => {
      if (flow !== undefined) return [flow, false] as const
      const created: Flow = {
        done: Deferred.makeUnsafe(),
        leader,
        prompt: undefined,
        link: undefined,
        waiters: new Set(),
        noticed: new Set(),
      }
      flow = created
      return [created, true] as const
    })

  /** Runs a new login in the daemon's scope, until it ends or its time runs out (MOD-44, MOD-74). */
  const run = (current: Flow) => {
    const started = epoch
    return inner.get.pipe(
      Effect.timeoutOrElse({
        duration: options.timeout,
        orElse: () => Effect.fail(new TimedOut()),
      }),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          flow = undefined
          if (exit._tag === "Success" && started === epoch) token = exit.value
          if (exit._tag === "Success" && current.prompt !== undefined) {
            yield* Logger.event("model.logged-in", "A login completed", {})
          }
          yield* Deferred.done(current.done, exit)
        }),
      ),
      Effect.forkIn(scope),
    )
  }

  /** Waits on a login as one waiter, which goes when the wait ends however it ends. */
  const join = (current: Flow, waiter: Waiter) =>
    Effect.suspend(() => {
      current.waiters.add(waiter)
      return greet(current, waiter)
    }).pipe(
      Effect.andThen(Deferred.await(current.done)),
      Effect.ensuring(Effect.sync(() => current.waiters.delete(waiter))),
    )

  const wait = (waiter: Waiter, leader = waiter.session) =>
    Effect.gen(function* () {
      const [current, fresh] = yield* take(leader)
      if (fresh) yield* run(current)
      return yield* join(current, waiter)
    })

  const get: CodexAuth["Service"]["get"] = Effect.gen(function* () {
    if (token !== undefined && !token.isExpired()) return token
    if (yield* Unattended) {
      // An unattended caller waits on no person: a login that waits for one ends it at once.
      if (flow !== undefined) {
        return yield* Effect.die(new Error(Messages.loginUnavailable))
      }
      return yield* inner.get
    }
    const session = yield* CurrentSession
    return yield* wait({ session, print: undefined, told: false })
  }).pipe(
    // A timeout is no failure of clanka's, and a model call does not retry it (MOD-46).
    Effect.catchTag("LoginTimedOut", (error) => Effect.die(error)),
  )

  /** The token goes from memory and from the store. During a login that has a code there is none to clear. */
  const logout = Effect.gen(function* () {
    epoch++
    token = undefined
    if (flow?.prompt !== undefined) return
    yield* inner.logout
    token = undefined
  })

  return Login.of({
    auth: CodexAuth.of({
      verifyUrl: inner.verifyUrl,
      get,
      authenticate: get,
      logout: logout,
    }),
    login: (print, leader) =>
      Effect.gen(function* () {
        const waiter: Waiter = { session: undefined, print, told: false }
        yield* wait(waiter, leader)
        return waiter.told ? "logged-in" : "already"
      }),
    logout: logout,
    pendingFor: (session) =>
      flow?.prompt !== undefined &&
      [...flow.waiters].some((waiter) => waiter.session?.id === session),
    pending: () => flow?.prompt !== undefined,
  })
})
