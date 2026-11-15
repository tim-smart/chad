import { CodexAuth } from "clanka/CodexAuth"
import { DeviceCodeHandler } from "clanka/DeviceCodeHandler"
import { Console, Context, Effect, Option, Stream } from "effect"
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
 * the change needs is printed as `chad login` prints it (MOD-92). A killed CLI ends the change before its store.
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
 * under the daemon's lock (MOD-22, MOD-90). A login it needs runs in the terminal as `chad login` runs it.
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
    const current = yield* Spec.read(environment.data, inputs).pipe(
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
    if (Spec.isShow(request)) {
      const state = yield* Account.fromFiles
      return yield* Console.log(Spec.shown(current, Status.logins[state.login]))
    }
    yield* Files.writable("model")
    const timings = yield* Timings
    const { auth, store, handler } = yield* Login.terminal
    const planned = yield* Spec.prepare({
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
    yield* Files.locked("model", Spec.store(environment.data, planned))
    yield* Console.log(planned.text)
  }).pipe(
    Effect.catchTag("ModelUnchanged", (error) => Effect.fail(unchanged(error))),
  )

const spec = Argument.String("spec").pipe(
  Argument.withDescription("The model, as <provider>/<model>[/<effort>]"),
  Argument.optional,
)

/** One of the two override flags, whose value `none` clears it (MOD-82, MOD-83, MOD-123). */
const override = (name: string, what: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(
      `The ${what} model, or ${clear} to run it on the main model`,
    ),
    Flag.optional,
  )

/**
 * `chad model`: shows the model and the login state, or changes the model after a trial request (MOD-15 to MOD-22).
 * It is an owner command, with no argument too, since `chad status` shows the agent the model (MOD-21, CLI-179).
 */
export const model = Command.make(
  "model",
  {
    spec,
    subagent: override("subagent", "sub-agent"),
    summarizer: override("summarizer", "summarizer"),
  },
  Effect.fn("model")(function* ({ spec, subagent, summarizer }) {
    yield* Owner.only("model")
    const request = {
      ...(Option.isSome(spec) ? { main: spec.value } : {}),
      ...(Option.isSome(subagent)
        ? { subagent: flagValue(subagent.value) }
        : {}),
      ...(Option.isSome(summarizer)
        ? { summarizer: flagValue(summarizer.value) }
        : {}),
    }
    return yield* (yield* Daemon.lock) === "held"
      ? throughDaemon(request)
      : alone(request)
  }),
).pipe(Command.withDescription("Show or change the model chad runs on"))
