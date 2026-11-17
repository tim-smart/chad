import { CodexAuth } from "clanka/CodexAuth"
import { DeviceCodeHandler } from "clanka/DeviceCodeHandler"
import { Console, Context, Effect, Option, Result, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { KeyValueStore } from "effect/persistence"
import * as Errno from "../../Errno.ts"
import * as Messages from "../../Messages.ts"
import type * as ModelSpec from "../../ModelSpec.ts"
import { clear, flagValue } from "../../ModelText.ts"
import * as Paths from "../../Paths.ts"
import type { ModelRequest } from "../../Rpcs.ts"
import * as Status from "../../Status.ts"
import { Timings } from "../../Timings.ts"
import * as Account from "../Account.ts"
import * as Daemon from "../Daemon.ts"
import { Environment } from "../Environment.ts"
import { ExitCode, Failure } from "../Failure.ts"
import * as Files from "../Files.ts"
import * as Owner from "../Owner.ts"
import * as Login from "./login.ts"

const unchanged = (error: { readonly text: string }) =>
  new Failure({ code: ExitCode.failed, message: error.text })

/**
 * `chad model` through a running daemon, which runs the change and prints what `/model` would post. The code of a login
 * the change needs is printed as `chad login` prints it. A killed CLI ends the change before its store.
 */
const throughDaemon = (request: typeof ModelRequest.Type) =>
  Effect.gen(function* () {
    const client = yield* Daemon.reach("model")
    yield* Daemon.call(
      "model",
      client
        .Model({ request })
        .pipe(
          Stream.runForEach((event) =>
            Console.log(
              event._tag === "Code"
                ? Messages.loginPrompt(event.verifyUrl, event.code)
                : event.text,
            ),
          ),
        ),
    ).pipe(
      Effect.catchTag("ModelUnchanged", (error) =>
        Effect.fail(unchanged(error)),
      ),
    )
  })

/**
 * `chad model` with no daemon: the settings from the files, and a change that the CLI tries itself before it stores it
 * under the daemon's lock. A login it needs runs in the terminal as `chad login` runs it.
 */
const alone = (request: ModelSpec.Request) =>
  Effect.gen(function* () {
    // The model layer is loaded here and nowhere else in the CLI, so that no other command pays for it at its start.
    const Spec = yield* Effect.promise(() => import("../../ModelSpec.ts"))
    const environment = yield* Environment
    const inputs = {
      model: environment.model,
      openaiApiUrl: environment.openaiApiUrl,
      openaiApiKey: environment.openaiApiKey,
    }
    const settings = Spec.read(environment.data, inputs).pipe(
      Effect.mapError(
        (error) =>
          new Failure({
            code: ExitCode.failed,
            message: Messages.unreadable(
              "model",
              Paths.model(environment.data),
              Errno.code(error),
            ),
          }),
      ),
    )
    const current = yield* settings
    if (Spec.isShow(request)) {
      const state = yield* Account.fromFiles
      return yield* Console.log(Spec.shown(current, Status.logins[state.login]))
    }
    yield* Files.writable("model")
    const timings = yield* Timings
    const { auth, store, handler } = yield* Login.terminal("model")
    yield* Spec.prepare({
      current,
      request,
      endpoint: inputs,
      deadline: timings.modelTrial,
      login: Effect.asVoid(
        Login.run(
          auth,
          (reason) =>
            new Spec.Unchanged({
              text: Messages.modelLoginFailed(reason),
            }),
        ),
      ),
    }).pipe(
      Effect.provideContext(
        Context.make(CodexAuth, auth).pipe(
          Context.add(KeyValueStore.KeyValueStore, store),
          Context.add(DeviceCodeHandler, handler),
        ),
      ),
    )
    // Another change may have been stored while the trials ran, so the change is planned again under the lock on what
    // the files hold now. The models to try come from the request alone, so they are the ones just tried, and a main
    // model that moved to another provider refuses an override of the old one.
    const stored = yield* Files.locked(
      "model",
      Effect.gen(function* () {
        const again = Spec.plan(yield* settings, request, inputs)
        if (Result.isFailure(again)) return yield* again.failure
        yield* Spec.store(environment.data, again.success)
        return again.success
      }),
    )
    yield* Console.log(stored.text)
  }).pipe(
    Effect.catchTag("ModelUnchanged", (error) => Effect.fail(unchanged(error))),
  )

const spec = Argument.String("spec").pipe(
  Argument.withDescription("The model, as <provider>/<model>[/<effort>]"),
  Argument.optional,
)

/** One of the two override flags, whose value `none` clears it. */
const override = (name: string, what: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(
      `The ${what} model, or ${clear} to run it on the main model`,
    ),
    Flag.optional,
  )

/** `--fast on|off`, which turns fast mode on or off. */
const fast = Flag.ChoiceWithValue("fast", [
  ["on", true],
  ["off", false],
] as const).pipe(
  Flag.withDescription(
    "Fast mode, on or off: OpenAI requests ask for the priority service tier",
  ),
  Flag.optional,
)

/**
 * `chad model`: shows the model and the login state, or changes the model after a trial request.
 * It is an owner command, with no argument too, since `chad status` shows the agent the model.
 */
export const model = Command.make(
  "model",
  {
    spec,
    subagent: override("subagent", "sub-agent"),
    summarizer: override("summarizer", "summarizer"),
    fast,
  },
  Effect.fn("model")(function* ({ spec, subagent, summarizer, fast }) {
    yield* Owner.only("model")
    const request = {
      ...(Option.isSome(spec) ? { main: spec.value } : {}),
      ...(Option.isSome(subagent)
        ? { subagent: flagValue(subagent.value) }
        : {}),
      ...(Option.isSome(summarizer)
        ? { summarizer: flagValue(summarizer.value) }
        : {}),
      ...(Option.isSome(fast) ? { fast: fast.value } : {}),
    }
    return yield* (yield* Daemon.lock) === "held"
      ? throughDaemon(request)
      : alone(request)
  }),
).pipe(Command.withDescription("Show or change the model chad runs on"))
