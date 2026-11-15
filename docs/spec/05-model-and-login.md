# Model provider and login

This part covers which model chad runs on, how the owner changes it, and how chad logs in to the model provider from a container that has no terminal. It also covers how chad sits on clanka's login code, where the tokens are kept, and what chad sends so that the provider's prompt cache keeps working. It leans on 03-sessions-and-turns.md for what a session and a turn are, on 04-discord.md for the status message and the form of a notice, on 08-apply-and-swap.md for the generation bump that makes a session rebuild, on 10-cli.md for how the `chad` command reaches the daemon, on 02-storage.md for the volume layout, on 16-failures-logs-status.md for the reasons a turn fails with and the rule for notices outside a turn, and on 17-testing.md for the daemon's inputs and the `Timings` service.

This part uses a few terms. The model setting is one string that names a provider, a model and an optional reasoning effort. The Codex login is the ChatGPT account login that OpenAI's Codex CLI uses, which clanka's `openai` provider can use in place of an API key. A device flow is the way that login is completed without a browser on the machine. The provider issues a verify URL and a short code, a person opens the URL elsewhere and types the code, and the waiting program polls until the provider hands over a token. `CodexAuth` is the clanka service that holds the Codex token, refreshes it and runs the device flow. `DeviceCodeHandler` is the clanka service whose `onCode` function is called with the verify URL and the code. A turn with no owner present is a turn that an owner message did not start, such as a cron job's turn or one a plugin starts with `Turns.start` or `Turns.queue`.

## Providers

chad reads the provider from the model setting. The provider decides whether a login is needed.

- **MOD-1** v1 supports and tests two providers, `openai` and `openai-compat`.
- **MOD-2** With `openai` and no API key set, chad uses the Codex login.
- **MOD-3** With `openai` and `CHAD_OPENAI_API_KEY` set, chad calls the plain OpenAI API at `CHAD_OPENAI_API_URL` and needs no login.
- **MOD-4** With `openai-compat`, chad takes the endpoint from `CHAD_OPENAI_API_URL` and the key from `CHAD_OPENAI_API_KEY` and needs no login, so such a deployment works from environment variables alone.
- **MOD-5** chad refuses the provider `claude` with an error that says why. Claude stays reachable through an OpenAI-compatible gateway under `openai-compat`.
- **MOD-6** The image ships without the Claude Code binary. The JavaScript of `@anthropic-ai/claude-agent-sdk` stays in the image because clanka imports it. See 01-image-and-volume.md.
- **MOD-7** chad does not block the providers `copilot` and `xai`, does not test them, and makes no promise about them.

| Env var | Meaning |
| --- | --- |
| `CHAD_MODEL` | The default model setting. |
| `CHAD_OPENAI_API_URL` | The endpoint for `openai-compat`, or for `openai` with an API key. |
| `CHAD_OPENAI_API_KEY` | The key for `openai-compat`, or for `openai` with no login. |

## The model setting

- **MOD-8** The model setting is one value in clanka's format, `<provider>/<model>[/<effort>]`.
- **MOD-9** v1 runs `openai/gpt-6-astra` at effort `medium` for the agent, for its sub-agents and for the compaction summarizer, which is the model call clanka uses to shorten a long history.
- **MOD-10** The model setting is global. There is no model per session.
- **MOD-11** `CHAD_MODEL` supplies the default model setting. A stored override wins over it.
- **MOD-12** The override is the file `state/model` on the volume, outside the repo and outside the database, written by temp file and rename. See 02-storage.md.
- **MOD-13** chad keeps two optional overrides, one for the sub-agent model and one for the summarizer model, and passes them to clanka. Without an override, sub-agents and the summarizer run on the main model. If the subscription's limits are reached, the sub-agent model is the first to move to a smaller model.
- **MOD-14** chad always provides clanka's `SummarizerModel` layer, on the agent's model unless the summarizer override names another, so that a summarizer still running when its turn ends is not cancelled. See 03-sessions-and-turns.md.
- **MOD-72** When a provider says a usage limit is reached, chad ends the turn and does not move to another model on its own. See 16-failures-logs-status.md.
- **MOD-79** When `CHAD_MODEL` is unset and no override is stored, chad runs `openai/gpt-6-astra/medium`.
- **MOD-80** The sub-agent override and the summarizer override are kept on the volume under `state/`, beside the main override.
- **MOD-81** An override names the same provider as the main model, and chad refuses to store one that names another. Each session has one client and the process has one login, so a second provider has nothing to run on.
- **MOD-117** The `model` column of a turn's row in the `turns` table holds the model setting that the turn's Agent was built with, as the whole string with the effort, because that is what ran. The rule and the column are in 02-storage.md.

## Changing the model

The owner changes the model from a terminal with `chad model` or from chat with `/model`. Both run the same daemon call and print the same text.

```
chad model [<provider>/<model>[/<effort>]]
/model [<provider>/<model>[/<effort>]]
```

- **MOD-15** `chad model <spec>` and `/model <spec>` store `<spec>` as the override.
- **MOD-16** Before it stores the override, the command makes one small request on the new model. If that request fails, the old model stays and nothing is stored.
- **MOD-17** If the new provider needs a login and none exists, the login runs first and the trial request follows it.
- **MOD-18** Each session picks up a changed model at the start of its next turn, through the same generation bump as an apply. See 08-apply-and-swap.md.
- **MOD-19** `chad model` and `/model` with no argument show the current model and whether chad is logged in.
- **MOD-20** `/model` does not go through the model. See 04-discord.md for the chat commands.
- **MOD-21** `chad model` is an owner command. The CLI refuses it with exit code 3 when `CHAD_SESSION` is set, which marks a process the agent started, because a model id that fails leaves no agent to undo the change. See 10-cli.md.
- **MOD-22** `chad model` works with no daemon running, as a write to `state/model` that needs no database.
- **MOD-23** `chad status` and `/status` show the model and whether chad is logged in, without going through the model. See 16-failures-logs-status.md.
- **MOD-82** `chad model` takes one flag that sets the sub-agent override and one that sets the summarizer override, and `/model` takes the same two flags.
- **MOD-83** Each of the two flags has a form that clears its override.
- **MOD-84** Before an override is stored, it gets the same trial request as the main model, and a failed trial stores nothing.
- **MOD-85** Changing the main model to another provider clears both overrides, and the command's output says so.
- **MOD-86** The trial request sends one short fixed prompt through the same model layer a turn would use, with no output limit. A Codex login refuses `max_output_tokens`.
- **MOD-87** The trial request of `chad model <spec>` and `/model <spec>` checks only the model being stored and not the overrides.
- **MOD-88** The trial request has a deadline of 60 seconds, which is a value of the `Timings` service, and a trial that has not answered by then has failed. Without the deadline the command would wait on a silent provider for as long as clanka's turn timeout allows. See 17-testing.md.
- **MOD-89** A trial request is not retried.
- **MOD-90** With no daemon running, the CLI makes the trial request of `chad model <spec>` itself. When the provider needs a login and none exists, the CLI first runs the login in the terminal as `chad login` does with no daemon. A model that fails its trial is stored on neither path.
- **MOD-91** When `/model <spec>` needs a login, chad posts the verify URL and the code where the command was typed. That is also the case in a plain server channel that has no session.
- **MOD-92** When `chad model <spec>` needs a login, the CLI prints the verify URL and the code in the terminal as `chad login` does, also when the daemon runs the login.

## Startup

- **MOD-24** At startup chad connects to Discord and does not ask for a login. The first owner message asks for it.
- **MOD-25** At startup chad checks every model it will run with the same small request. Those are the main model, which is the stored override when there is one, and each of the sub-agent and summarizer overrides that is set. A summarizer model that the provider has dropped would otherwise fail first at 200k tokens. A failure is logged as the event `model.check-failed`, sent to the owner as the notice "The model `<spec>` failed its check at start (<error>). If turns fail, set another with `/model`." and listed under "Problems" in `chad status`, and chad still starts. See 16-failures-logs-status.md.
- **MOD-93** The startup check of a model whose provider needs a login is skipped when no token is stored.
- **MOD-94** The startup check runs as a turn with no owner present, so it starts no device flow and posts no login code. When the stored token's refresh fails during the check, the check counts as skipped.
- **MOD-95** The startup check runs after chad has connected to Discord, and nothing waits for it.

The check makes a model request at every boot, with `openai-compat` as well, and nothing orders it against the first turn. Its request can reach the provider before or after the first turn's request. It sends the fixed prompt of MOD-86, which is how a test that scripts the fake model server by call order tells the check's request from a turn's (see 17-testing.md).

## How chad builds the model layer on a Codex login

clanka's own helpers do not fit. `Codex.layerClient` and `ModelLayer.make` each build a `CodexAuth` of their own, and `ModelLayer.make` takes no `prompt_cache_key`. A `CodexAuth` reads the stored token once, when it is built, and keeps it in memory, so two of them in one process would each hold a copy of the token and race each other on a refresh. chad therefore builds one `CodexAuth` and composes the rest itself. `CodexAuth` is not in clanka's index and is imported as `clanka/CodexAuth`.

- **MOD-26** chad builds one `CodexAuth` for the whole process, and every session uses it.
- **MOD-27** chad does not use `Codex.layerClient` or `ModelLayer.make` on the Codex path. It composes `OpenAiClient.layer` at the Codex URL over `CodexAuth.layerClientNoDeps`, then `Codex.modelWebSocket(model, { prompt_cache_key })`, `Agent.layerSubagentModel` and `Compaction.layerSummarizerModel`.
- **MOD-28** `CodexAuth.layerClientNoDeps` takes `CodexAuth` from context, and chad provides its own wrapper around the shared one. The wrapper is described under "One login at a time".
- **MOD-29** Each session has its own `OpenAiClient`, built over the one shared `CodexAuth`, so that the client can carry that session's header.
- **MOD-30** A rebuild of a session's Agent keeps the session's model layer. Only a model change, a login change or a restart builds a new model layer.
- **MOD-73** Every model request and every login request goes through the `HttpClient` that `runDaemon` is given, and the WebSocket transport uses the WebSocket constructor that `runDaemon` is given. See 17-testing.md.

The composition below is taken from the prototype, which built one client for the process. The lines marked as adjusted make it one client per session with the agreed header name. In the code blocks of this part the prototype's `NodeHttpClient.layerUndici` and `GlobalWebSocket.layerWebSocketConstructor` stand where chad uses the two inputs of MOD-73.

```ts
import { OpenAiClient } from "@effect/ai-openai"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Agent, Codex, Compaction, GlobalWebSocket } from "clanka"
import { CodexAuth } from "clanka/CodexAuth"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Layer from "effect/Layer"

// The HttpClient under one session's OpenAiClient. It adds the session's header
// to every model request.
const sessionHttp = (sessionId: string) => // adjusted: TIM-544 item 1 (one per session)
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, HttpClient.mapRequest((request) =>
      HttpClientRequest.setHeaders(request, { "session-id": sessionId }) // adjusted: TIM-544 (header name)
    ))
  ).pipe(Layer.provide(NodeHttpClient.layerUndici))

// One session's OpenAiClient, over the one shared CodexAuth (chad's wrapper).
const sessionClient = (sessionId: string, auth: CodexAuth["Service"]) => // adjusted: TIM-544 item 1
  OpenAiClient.layer({ apiUrl: "https://chatgpt.com/backend-api/codex" }).pipe(
    Layer.provide(CodexAuth.layerClientNoDeps),
    Layer.provide([Layer.succeed(CodexAuth, auth), sessionHttp(sessionId)]) // adjusted: TIM-544 item 1
  )

// One session's model layer. The casts are the prototype's.
const sessionModels = (sessionId: string, model: string, effort: string, auth: CodexAuth["Service"]) => {
  const main = (Codex.modelWebSocket(model, {
    reasoning: { effort },
    prompt_cache_key: sessionId
  } as any) as Layer.Layer<any, never, any>).pipe(
    Layer.provide([sessionClient(sessionId, auth), GlobalWebSocket.layerWebSocketConstructor]) // adjusted: TIM-544 item 1
  ) as Layer.Layer<any>
  return Layer.mergeAll(main, Agent.layerSubagentModel(main), Compaction.layerSummarizerModel(main))
}
```

## The prompt cache key and the session header

The provider caches the start of a prompt so that a later request with the same start is cheaper and faster. Measured on a real Codex login with about 9,000 input tokens, of which about 1,800 were the system prompt. With `prompt_cache_key` alone a new connection read 1664 tokens from the cache, which is the system prompt and none of the history, and with no key it read 0. The history was read only while one WebSocket stayed open, and clanka's client closes the socket after 60 seconds idle. With the session id also sent as a request header, the history was read after a rebuild (8832 of 9054), after the socket idled out (8576 of 8709) and over plain HTTP.

- **MOD-31** chad passes the session id as `prompt_cache_key` when it builds a session's model layer, on every path except `openai-compat` (MOD-98).
- **MOD-32** chad sends the session id in a `session-id` request header on every model request of that session, on every path except `openai-compat` (MOD-98). On the HTTP transport that is every request. On the WebSocket transport it is the request that opens the socket, each time one is opened, and a message sent on an open socket has no headers.

The header needs no wrapper around the WebSocket constructor. effect's `OpenAiClient` builds the request that opens a socket by passing a `POST /responses` request through the request transforms of the session's `HttpClient`, and it hands that request's headers to the WebSocket constructor as its second argument, `{ headers }`. That was read in `@effect/ai-openai` 4.1.4, and the WebSocket runs above sent the header this way. The WebSocket constructor that `runDaemon` is given therefore has to pass those headers on, and a test reads the header from the opening request at the fake model server.

A sub-agent on the main model was observed to send its parent's key and header, and 38 of 44 sub-agent requests read 1664 of their 1823 input tokens from the cache. The numbers come from one account on one afternoon, and every run finished within five minutes.

## The model layer without a Codex login

The two paths that need no login are `openai` with an API key and `openai-compat`. `ModelLayer.make` takes no `prompt_cache_key`, so chad does not use it on these paths either.

- **MOD-96** With `openai` on an API key and with `openai-compat`, chad composes the model layer by hand in the same shape as on a Codex login, with one client per session, so that all three paths share code.
- **MOD-97** With `openai` on an API key, chad sends the session id as `prompt_cache_key` and in the `session-id` header, as it does on a Codex login.
- **MOD-98** With `openai-compat`, chad sends neither `prompt_cache_key` nor the `session-id` header, because a gateway may refuse a field it does not know.

## The token check and the session reference

clanka's `onCode` receives the verify URL and the code and nothing about which session asked. chad closes that gap with a `Context.Reference`, a value carried in the Effect context that has a default when nothing sets it. chad sets it to the current session around each turn, and the handler reads it. The handler runs on the fiber of the request that needed the token, and the reference was seen inside `onCode` for a login at the start of a turn and for one forced in the middle of a turn, including through the wrapper, which runs the flow in a fiber of its own.

- **MOD-33** At the start of every turn chad asks the shared `CodexAuth` for a token before it builds the session's model layer and before it calls `send`. The WebSocket transport asks for a token when the layer is built, so a check placed only before `send` would come too late.
- **MOD-34** chad sets the session reference around the build of the session's model layer as well as around the turn. A login that starts during the build would otherwise find no session set, and its code would go by the notice route of MOD-36 and not to the thread that asked.
- **MOD-35** chad's `DeviceCodeHandler` reads the current session from the reference to learn which thread asked.
- **MOD-36** When no session is set, the verify URL and code go where a notice outside a turn goes. That is the owner's most recently active DM session, or the most recent session of any kind when there is none. See 16-failures-logs-status.md.
- **MOD-99** When the provider needs no login, chad makes no token check at the start of a turn.

```ts
// What chad sets around a turn. Internal to chad's core.
interface SessionRef {
  readonly id: string
  /** False for a cron job's turn or one a plugin started with Turns.start or Turns.queue. */
  readonly ownerPresent: boolean
}
class CurrentSession extends Context.Reference<SessionRef | undefined>("chad/CurrentSession", {
  defaultValue: () => undefined
}) {}

// Set while the wrapper knows chad is logged out and no owner has logged in since.
let knownLoggedOut = false // adjusted: TIM-544 item 5

const HandlerLive = Layer.succeed(DeviceCodeHandler.DeviceCodeHandler, {
  onCode: (options) =>
    Effect.gen(function*() {
      const session = yield* CurrentSession
      if (session !== undefined && !session.ownerPresent) {
        knownLoggedOut = true // adjusted: TIM-544 item 5
        return yield* Effect.die(new Error("NoOwnerPresent"))
      }
      // Posts options.verifyUrl and options.deviceCode in the session's thread,
      // or by the notice route when no session is set. The prototype logged it.
      // postLoginPrompt stands for chad's own code. No ticket gives its shape.
      yield* postLoginPrompt(session, options) // adjusted: TIM-535 Login
    })
})
```

## Login in Discord

- **MOD-37** Only a turn started by an owner message starts a device flow.
- **MOD-38** chad posts the verify URL and the code in the thread of the turn that needed the login.
- **MOD-39** That turn waits until the login completes or times out. When the login completes, the turn runs.
- **MOD-40** There is no `/login` and no `/logout` in chat.
- **MOD-100** The status message of a turn shows "Waiting for login" whenever a login is pending for its session. That holds for a login needed at the start of a turn as well as for one lost part way through. See 04-discord.md for the status message.

## One login at a time

clanka's `CodexAuth` puts `get` behind a lock with one permit. If chad only put a timeout around each caller, the next waiter would take the lock when the first timed out and clanka would start a second device flow, with a second code in a second thread. That was run, and thread B was issued its own code the moment thread A timed out. So chad's wrapper owns the wait. The first caller starts the flow in a fiber that belongs to the wrapper, every other caller waits on the same result, and the timeout sits on that one flow.

- **MOD-41** One login runs at a time for the whole process, and one code is issued for it.
- **MOD-42** A turn in another thread that an owner message started and that needs the login while one is pending gets no code. chad posts the notice "Waiting for the login in <thread link>" in its thread. A waiting turn with no owner present gets no such notice (MOD-115).
- **MOD-43** Every waiting turn runs when the login completes.
- **MOD-44** The login timeout is 15 minutes and it belongs to chad. A device code expires 15 minutes after it is issued, clanka does not read that expiry and polls until it is interrupted, so chad's timeout is the only thing that ends the flow.
- **MOD-45** On timeout the wrapper ends the device flow, every waiting turn that an owner message started ends with the message "Login timed out. Send a message to try again.", and no waiter starts a second flow.
- **MOD-46** A login failure inside a model call reaches chad as a defect that wraps `CodexAuthError`, because `layerClientNoDeps` uses `orDie`. chad looks inside the defect to tell a failed login from a crash.
- **MOD-74** The 15 minute login timeout is a value of the `Timings` service, and the shipped binary has no setting that changes it. See 17-testing.md.
- **MOD-75** A turn that ends because the login timed out is a failed turn with the reason `LoginFailed`, whose own reason is `TimedOut`. For a turn that an owner message started, the message of MOD-45 takes the place of the general failed-turn message. See 16-failures-logs-status.md for the set of reasons and the form of a failed-turn message.
- **MOD-76** A turn whose login fails in any other way is a failed turn with the reason `LoginFailed`, whose own reason is the `CodexAuthError` reason, which is `DeviceFlowFailed`, `TokenExchangeFailed` or `RefreshFailed`. When an owner message started the turn, its thread gets the message "Login failed (<reason>). Send a message to try again." in place of the general failed-turn message.
- **MOD-101** A login that the daemon has started runs until it completes or its 15 minutes end, whoever is still waiting on it. A killed CLI or a stopped turn removes that waiter only, so the code the owner has in front of him stays good.

In the runs, two sessions waited on one login with one code and 31 polls, and both answers came within 2.3 seconds of the login completing. With a 25 second timeout both turns ended at 25 seconds with one code in total and no request to auth.openai.com in the 20 seconds after.

The code below is the prototype's wrapper, and two things in it are not chad's final form. Its `timedOut` fails with the reason `DeviceFlowFailed`. Copied as it stands, a login that timed out would post "Login failed (DeviceFlowFailed). Send a message to try again.", where chad ends the turn with the reason `TimedOut` and the message of MOD-45 (MOD-75). How chad tells the two apart is MOD-G23. Its "15 minutes" is written out, where chad reads the value from the `Timings` service (MOD-74).

```ts
// `inner` is clanka's CodexAuth, built once for the process over the token store.
const inner = Context.get(
  yield* Layer.build(CodexAuth.layer.pipe(
    Layer.provide([HandlerLive, KeyValueStore.layerFileSystem(authDir), NodeHttpClient.layerUndici]), // authDir is secrets/auth on the volume. adjusted: TIM-536 item 1
    Layer.provide(NodeServices.layer)
  )),
  CodexAuth
)
const timedOut = () =>
  Effect.fail(new CodexAuthError({ reason: "DeviceFlowFailed", message: "Login timed out" }))

// chad's wrapper. One wait for the whole process: the first caller starts the
// flow in a fiber the wrapper owns, everyone else awaits the same Deferred. The
// timeout is on that one fiber, so a waiter never gets clanka's lock after it
// and never starts a second device flow.
let inflight: Deferred.Deferred<TokenData, CodexAuthError> | undefined
let leader: string | undefined
const waiters = new Set<string>()
const shared = (flow: Effect.Effect<TokenData, CodexAuthError>) =>
  Effect.gen(function*() {
    const session = yield* CurrentSession
    const me = session?.id ?? "(no session)"
    // The pending login is checked first, so a turn with no owner present waits
    // on a login that already runs and never starts one.
    if (inflight !== undefined) { // adjusted: TIM-559 ruling on MOD-G11 (moved above the logged-out check)
      // The leader's own model call comes back here when clanka retries it.
      // Every other caller is a waiter. A waiter that an owner message started gets
      // "Waiting for the login in <thread link>", and one with no owner present gets nothing.
      if (me !== leader) waiters.add(me)
      return yield* Deferred.await(inflight).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(me))))
    }
    if (knownLoggedOut && session !== undefined && !session.ownerPresent) { // adjusted: TIM-544 item 5
      return yield* Effect.die(new Error("NoOwnerPresent"))                  // adjusted: TIM-544 item 5
    }
    const deferred = inflight = yield* Deferred.make<TokenData, CodexAuthError>()
    leader = me
    yield* flow.pipe(
      Effect.timeoutOrElse({ duration: "15 minutes", orElse: timedOut }), // adjusted: TIM-535 Login, TIM-558 item 17 (the value comes from the Timings service, see MOD-74)
      Effect.onExit((exit) => {
        inflight = undefined
        if (Exit.isSuccess(exit)) knownLoggedOut = false // adjusted: TIM-544 item 5
        return Deferred.done(deferred, exit)
      }),
      Effect.forkIn(outer) // the scope of the process, not of the turn
    )
    return yield* Deferred.await(deferred)
  })

// What chad provides as CodexAuth to every session's client.
const auth = CodexAuth.of({
  verifyUrl: inner.verifyUrl,
  get: shared(inner.get),
  authenticate: shared(inner.authenticate),
  logout: inner.logout
})
```

## Losing the login in the middle of a turn

A login can be lost while a turn runs. When a token refresh fails for any reason, after the HTTP client's five transient retries, clanka deletes the token and starts a device flow inside the request that needed it. `chad logout` has the same effect on the next request that needs a token.

clanka's turn timeout (`Agent.TurnTimeout`, 5 minutes by default) keeps running during such a wait, because a model call that waits for a login sends nothing. When it fires, clanka gives up on the call and retries it. With the wrapper the retry joins the same wait, so there is still one code, and the turn's stream carries an `ErrorRetry` part each time. A 15 minute wait sees two of them. Without the wrapper every retry cancelled the device flow and issued a new code, 6 codes in 50 seconds at an 8 second turn timeout.

- **MOD-47** A turn that loses its login part way through waits where it is. chad posts the verify URL and the code in its thread, and the status message shows "Waiting for login".
- **MOD-48** When the login completes, the waiting turn carries on from where it waited.
- **MOD-49** On timeout the turn ends with the "Login timed out. Send a message to try again." message and keeps the history it had.
- **MOD-50** While a login is pending for a session, chad does not show clanka's retry parts in that session's status message. See 16-failures-logs-status.md for the retry line it would otherwise show.
- **MOD-51** However many times clanka's turn timeout fires during one login wait, one code is issued.
- **MOD-102** While a login is pending for a session, clanka's retries on that session's model call do not count toward the silence bound of 16-failures-logs-status.md. The cause of the silence is known, and the login timeout of MOD-49 is what ends the wait.
- **MOD-103** When the login completes, the count toward the silence bound starts again from zero.

In the run behind MOD-49 the history went from 2 messages to 5 and stayed. MOD-48 was not run, because it needs a second login.

## Turns with no owner present

A device flow needs a person. `onCode` has no error channel, so a handler that dies ends the device flow as a defect, and clanka's model retry only retries failures. That is how such a turn ends at once. In the runs it ended in 0.1 seconds with 0 retries at the token check, while the model layer was built, and inside a model call.

clanka requests the device code from auth.openai.com before it calls the handler. Without MOD-54 a cron job that runs every minute on a logged-out chad would request a code every minute.

- **MOD-52** A turn with no owner present never starts a device flow. When chad is logged out and no login is pending, the turn ends at once with no model retry.
- **MOD-53** chad then sends the owner one notice under the key `logged-out`, "chad is logged out. Send a message or run `chad login`. Scheduled runs are skipped until then." It is not sent again while chad stays logged out. See 16-failures-logs-status.md for the notice rule, which says where the notice goes and what happens across a restart and when the condition returns within 24 hours.
- **MOD-54** After a turn with no owner present has found chad logged out, the wrapper fails every later such turn that starts while no login is pending without calling clanka, until a login succeeds.
- **MOD-77** A turn that ends this way is a failed turn with the reason `LoggedOut`, and chad posts nothing in its thread. See 16-failures-logs-status.md.
- **MOD-78** A cron run that ends as `LoggedOut`, `LoginFailed` or `UsageLimit` does not count as a failure of its job and is not run again later. See 13-timers-and-cron.md.
- **MOD-104** A turn with no owner present that needs the login while one is pending waits on that login and runs when it completes. Waiting on a flow that already runs requests no code, and ending at once would skip the run while the owner is half way through logging in.
- **MOD-105** When the login it waits on fails or times out, a turn with no owner present ends as a failed turn with the reason `LoginFailed`.
- **MOD-106** For a turn with no owner present that ends as `LoginFailed`, chad posts nothing in its thread and begins the `logged-out` notice of MOD-53 if none is held. See 16-failures-logs-status.md.
- **MOD-115** While a turn with no owner present waits on a pending login, chad posts nothing in its thread. It posts no status message and no "Waiting for the login in <thread link>" notice for that turn, and the turn's status message is posted when the login completes. A turn that ends as `LoginFailed` after the wait has then posted nothing at all, as MOD-106 requires. The rule is in 04-discord.md.
- **MOD-116** An owner's message in the thread of such a waiting turn gets the "Waiting for the login in <thread link>" notice, once for that wait. Without it the owner would type into silence for up to 15 minutes. The rule is in 04-discord.md.

## chad login and chad logout

```
chad login
chad logout
```

A running daemon does not see a token that another process wrote, because its `CodexAuth` read the store once when it was built. In the run, a daemon asked for a device code with the token file sitting in its store. The reverse also holds, and a daemon whose token file was removed by another process kept answering, including in a new session. So both commands go through the daemon when one is running. The CLI tells a running daemon from none by the lock on `state/daemon.lock`. See 10-cli.md.

- **MOD-55** `chad login` prints the verify URL and the code in the terminal.
- **MOD-56** When the daemon's lock is held, `chad login` asks the daemon over the socket to run the login.
- **MOD-57** When the daemon's lock is free, `chad login` runs the device flow itself and writes the same token store. This works over `docker exec` and in a one-off run of the image.
- **MOD-58** With no daemon, `chad login` takes the daemon's lock when it stores the token and not while it waits for the person. If a daemon started in the meantime, the command fails with "a daemon started during the login, run chad login again" and exit code 1.
- **MOD-59** For a login that the daemon runs, the CLI has no deadline of its own, and the daemon's 15 minutes is the only one. Killing the CLI ends the CLI's call to the daemon and nothing else. The login carries on in the daemon and its code stays good (MOD-101).
- **MOD-60** `chad logout` clears the token, through the daemon when one is running.
- **MOD-61** `chad logout` does not stop a running turn, and the CLI says so. On the WebSocket transport the open socket keeps the token from its handshake, so the turn finishes and the login is asked for when the socket is next opened. chad builds nothing to cut the socket.
- **MOD-62** `chad login` and `chad logout` are owner commands. The CLI refuses them with exit code 3 when `CHAD_SESSION` is set. See 10-cli.md.
- **MOD-63** The daemon adds no refusal of its own for `chad login`, `chad logout` and `chad model`. Only the CLI refuses them.
- **MOD-64** `chad login` and `chad logout` work with no daemon running.
- **MOD-65** `chad setup` offers the model login as one of its steps, and `--skip-login` skips it. See 10-cli.md.
- **MOD-107** `chad login` run while a login is already pending joins that login and prints the same code, so MOD-41 holds.
- **MOD-108** With no daemon, the login that `chad login` runs itself ends after the same 15 minutes from the `Timings` service. The device code expires then, and nothing else ends clanka's polling.
- **MOD-109** When the provider needs no login, `chad login` says that the provider needs no login and exits with code 0.
- **MOD-110** `chad logout` clears a stored token also when the provider needs no login.

In the run behind MOD-61, after a logout during a turn on the WebSocket transport the turn finished normally, and the login was asked for 72 seconds into a later turn, when the socket was opened again. On the HTTP transport the next model call asked at once.

## Log events

The table of every log event, with its level and what it carries, is in 16-failures-logs-status.md. An event name has the form `area.name` with exactly one dot. A turn that begins to wait for a login writes `turn.login-wait` there, and a model that fails its check at start writes `model.check-failed` (MOD-25).

- **MOD-112** When a login completes, chad writes the log event `model.logged-in`.
- **MOD-113** A turn that ends because chad is logged out is logged once, as the event `turn.failed` with the reason `LoggedOut`. chad writes no second event for it, because one failure is one event and a second line would show the same failure twice in `chad logs` (see 16-failures-logs-status.md).
- **MOD-114** A turn that ends because a usage limit is reached is logged once, as the event `turn.failed` with the reason `UsageLimit`, and that line carries the reset time when the provider's error held one. chad writes no second event for it.

## Token store

- **MOD-66** Tokens are kept in Effect's file system `KeyValueStore` (`KeyValueStore.layerFileSystem`) in the directory `secrets/auth/` on the volume, outside the repo and outside the SQLite file. The CLI can write it with no daemon.
- **MOD-67** The directory has mode 0700.
- **MOD-68** chad sets mode 0600 on the files in the store itself. The store writes the Codex token as the file `codex.auth%2Ftoken` with mode 0644 under a umask of 022.
- **MOD-69** clanka's `ModelsRepo.layerModelsDev` is the only code in clanka that fetches the models.dev model catalog, from `https://models.dev/api.json`, and it caches the catalog in the `KeyValueStore` it is given, under `models-dev/`. When that layer is built over the token store, the cache lands in `secrets/auth/`. chad's own composition of the model layer (MOD-27, MOD-96) does not build it, and whether chad builds it at all is MOD-G33.
- **MOD-70** The store does not hide the token from the agent, which runs as the same user, and v1 does not try to. See 15-credentials.md.
- **MOD-111** chad sets the mode of a token file with a chmod after each write, and it never changes the process umask. A umask of 077 would change the mode of every file the agent's `bash` creates, in the repo and everywhere else it writes.

clanka's Copilot and xAI logins go through the same `DeviceCodeHandler` and the same store, with xAI tokens under `xai.auth/`. Deleting the token file does not revoke the login at OpenAI. The store is part of `secrets/`, so a backup tar holds the tokens. See 02-storage.md.

## Accepted model names

- **MOD-71** `gpt-6.1-sol`, `gpt-6.1-terra` and `gpt-6-luna` are accepted on a Codex login for the sub-agent and summarizer overrides, next to `gpt-6-astra`.

All three answered on both transports at efforts `low` and `medium`. Efforts above `medium` were not run on them. A made-up model id is refused by the provider with `model_not_found` and the text "not supported when using Codex with a ChatGPT account". The summarizer was not run on a Codex login, because no run was long enough to compact. clanka starts compaction at 200k tokens.

| Model | USD per million tokens in | USD per million tokens out |
| --- | --- | --- |
| `gpt-6-astra` | 10 | 50 |
| `gpt-6.1-sol` | 2 | 10 |
| `gpt-6.1-terra` | 1 | 5 |
| `gpt-6-luna` | 0.1 | 0.5 |

The prices are what models.dev listed on 2026-11-14.

## Messages

| Text | Where | When |
| --- | --- | --- |
| `Waiting for the login in <thread link>` | Notice in the waiting turn's thread | Another thread's login is pending and an owner message started the waiting turn (MOD-42), or the owner writes in the thread of a waiting turn with no owner present (MOD-116) |
| `Login timed out. Send a message to try again.` | Failed-turn message in the thread of each waiting turn that an owner message started | The 15 minutes ran out (MOD-45, MOD-49, MOD-75) |
| `Login failed (<reason>). Send a message to try again.` | Failed-turn message in the thread of a turn that an owner message started | A login failed in any other way (MOD-76) |
| `Waiting for login` | Status message of the turn | A login is pending for the turn's session (MOD-47, MOD-100). A waiting turn with no owner present has no status message (MOD-115) |
| ``chad is logged out. Send a message or run `chad login`. Scheduled runs are skipped until then.`` | One notice to the owner | A turn with no owner present found chad logged out (MOD-53) |
| ``The model `<spec>` failed its check at start (<error>). If turns fail, set another with `/model`.`` | Notice to the owner | A model failed its check at startup (MOD-25) |
| `a daemon started during the login, run chad login again` | CLI, exit code 1 | A daemon took the lock during a login with no daemon (MOD-58) |

## Gaps

- **MOD-G1** [tim] The header name. Tim agreed to the header under the name `session_id`. The spelling `session-id` was read from the Codex CLI and run afterwards, and Tim has not confirmed it (TIM-544).
- **MOD-G5** [builder] What `chad model` and `/model` print, with and without an argument, on success and on a failed trial, and the wording of the `claude` refusal (TIM-535, TIM-542).
- **MOD-G9** [builder] The wording of the login prompt in a thread and in the terminal. The prototype posted "Open <verify URL> and enter <code>" (TIM-533, TIM-544).
- **MOD-G15** [builder] What `chad logout` prints (TIM-544 item 6).
- **MOD-G17** [builder] What counts as "a login change" for building a new model layer (TIM-544 item 2).
- **MOD-G19** [builder] Whether a sub-agent gets its own session id and whether chad sends a `thread-id` header, as the Codex CLI does. The prototype sent neither (TIM-544).
- **MOD-G20** [builder] Whether the session reference here is the same thing as the plugin API's `CurrentSession` service. The prototypes define them separately under the same name (TIM-544, TIM-530).
- **MOD-G21** [builder] Whether the header still needs `prompt_cache_key` beside it. The header with a changing key was not run (TIM-544).
- **MOD-G23** [builder] How chad tells its own timeout from clanka's `DeviceFlowFailed` when it looks inside the defect. The prototype's wrapper fails a timed out login with `CodexAuthError { reason: "DeviceFlowFailed", message: "Login timed out" }` (TIM-557 item 12, TIM-544).
- **MOD-G24** [builder] The names of the two override flags on `chad model` and `/model`, the form that clears an override, and the names of the two files under `state/` (TIM-535, TIM-559).
- **MOD-G25** [builder] Whether `chad model <spec>`, `chad login` and `chad logout` write the log event `command.ran` when they run with no daemon. The event is ruled for a CLI or chat command that changes something, and no ticket says whether a CLI with no daemon writes to the log (TIM-559 round 2 R4). The same question for every command that runs with no daemon is a gap in 10-cli.md.
- **MOD-G26** [builder] Where `/model <spec>` runs. The command can last a 15 minute login and a 60 second trial, and the handler of a Discord event has about 41 seconds before the shard reconnects (see 03-sessions-and-turns.md). It cannot be a request to a session either, because MOD-91 lets it be typed in a plain server channel that has no session. Recommended: the handler accepts the event at once, the command runs in a fiber of the daemon's own scope and posts its result where it was typed, and a restart drops a command that was still running and says nothing (TIM-535, TIM-559 cold read).
- **MOD-G27** [builder] What `chad serve` does when the model setting it starts with cannot run. That is a `CHAD_MODEL` or a `state/model` that names `claude`, that does not parse as MOD-8 says, or that names `openai-compat` while `CHAD_OPENAI_API_URL` is unset. One reading refuses the boot, which counts as an unclean boot. The other starts. Recommended: chad starts, logs `model.check-failed` with the refusal as the error, sends the notice of MOD-25, and ends each turn as a failed turn with the reason `Internal` and the same text, because MOD-25 says chad still starts (TIM-535, TIM-559 cold read).
- **MOD-G28** [builder] Which transport `openai` on an API key and `openai-compat` use. MOD-27 puts the Codex login on the WebSocket transport, and no rule names the transport of the other two paths. A usage limit's reset time arrives only in an HTTP body (see 16-failures-logs-status.md), so the answer decides whether any run of chad shows one. Recommended: both paths run over HTTP, the reset time is read there and covered by one scenario on the fake's `openai-compat` side, and the Codex login stays on the WebSocket (TIM-535, TIM-557 item 22, TIM-559 cold read).
- **MOD-G29** [builder] Where the code goes, besides the terminal, for a login that the daemon runs for `chad login` or `chad model <spec>`, and which thread the notice "Waiting for the login in <thread link>" then names. No session is set during such a login. Read as written, MOD-36 also posts the code by the notice route, and MOD-55 and MOD-92 name the terminal only, which leaves a waiting turn in Discord with no thread to link. Recommended: the code goes to the terminal and also by the notice route of MOD-36, and the link names the thread that notice went to (TIM-535, TIM-559 ruling on MOD-G8, TIM-559 cold read).
- **MOD-G30** [builder] What the owner is told when more than one model fails its check at one boot. Up to three models are checked (MOD-25), and the notice has one key, `model-check-failed`, and one text with one `<spec>` and one `<error>` (see 16-failures-logs-status.md). The readings are one notice for the first failure, one notice with a sentence for each failed model, and a key for each model. That key also clears on any model call that succeeds, so an answer from the main model hides a failed summarizer. Recommended: one key, one sentence for each failed model in the order main, sub-agent, summarizer, cleared as 16-failures-logs-status.md says (TIM-559 ruling on MOD-G6, TIM-559 cold read).
- **MOD-G31** [builder] What chad does at boot with a stored sub-agent or summarizer override that names another provider than the main model. MOD-81 and MOD-85 keep a command from leaving one behind, and a changed `CHAD_MODEL` with no main override stored still can. The readings are to ignore the override, to delete its file, and to run it and fail. Recommended: chad ignores it for that run, keeps the file, logs a warning, and shows it in what `chad model` prints (TIM-559 ruling on MOD-G2, TIM-559 cold read).
- **MOD-G32** [builder] What `chad login` does when a good token is already stored. One reading says so and exits with code 0, and the other starts a new device flow so that the owner can change account. Recommended: chad does what clanka's `authenticate` does through the wrapper. If that returns the stored token, the CLI prints that chad is already logged in and exits with code 0, and a change of account is `chad logout` followed by `chad login` (TIM-535 CLI, TIM-559 cold read).
- **MOD-G33** [builder] Whether chad builds clanka's `ModelsRepo.layerModelsDev` at all (MOD-69). No rule of v1 reads the model catalog, and a request to models.dev would be one more host for the test `HttpClient` to answer. Recommended: chad does not build it, makes no request to models.dev and writes no `models-dev/` key, and the test `HttpClient` fails every host except the fake model server (TIM-535 Token store, TIM-559 cold read).
- **MOD-G34** [builder] How chad builds the model layer for `copilot` and `xai`, which MOD-7 does not block. chad composes the layer by hand for three paths only (MOD-27, MOD-96), so `chad model copilot/...` either goes through clanka's `ModelLayer.make` or fails as an unknown provider. Recommended: chad falls back to `ModelLayer.make` with no `session-id` header and no `prompt_cache_key`, untested, and the trial request of MOD-16 decides whether the model is stored (TIM-535 Providers, TIM-559 cold read).

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| MOD-1 | TIM-535 Providers | Tim | run |  | `rule` | `models` |
| MOD-2 | Map "Agreed at charting", TIM-535 Providers | charting | run |  | `rule` | `models` |
| MOD-3 | TIM-535 Providers and The model setting | Tim | read |  | `rule` | `models` |
| MOD-4 | Map "Agreed at charting", TIM-535 The model setting | charting | not run |  | `rule` | `harness` |
| MOD-5 | TIM-535 Providers | Tim | not run |  | `rule` | `models` |
| MOD-6 | TIM-535 Providers, amended by TIM-541 item 3 | Architect (Tim has not read) | run | TIM-541 | `rule` | `harness` |
| MOD-7 | TIM-535 Providers | Tim | not run |  | `definition` | - |
| MOD-8 | TIM-535 The model setting | Tim | read |  | `rule` | `harness` |
| MOD-9 | TIM-535 Model | Tim | run |  | `rule` | `models` |
| MOD-10 | TIM-535 The model setting | Tim | not run |  | `rule` | `models` |
| MOD-11 | TIM-535 The model setting, TIM-559 cold read | Tim | not run |  | `rule` | `harness` |
| MOD-12 | TIM-535 The model setting, TIM-536 item 2 | Tim | not run |  | `rule` | `models` |
| MOD-13 | TIM-535 Model | Tim | read |  | `rule` | `models` |
| MOD-14 | TIM-543 item 1, with TIM-535 Model | Tim | run |  | `rule` | `turns` |
| MOD-15 | TIM-535 The model setting, TIM-542 item 22 | Tim | not run |  | `rule` | `models` |
| MOD-16 | TIM-535 The model setting | Tim | not run |  | `rule` | `models` |
| MOD-17 | TIM-535 The model setting | Tim | not run |  | `rule` | `models` |
| MOD-18 | TIM-535 The model setting, TIM-544 item 2 | Tim | not run |  | `rule` | `plugin-api` |
| MOD-19 | TIM-535 The model setting | Tim | not run |  | `rule` | `models` |
| MOD-20 | TIM-542 item 22 | Tim | not run |  | `rule` | `models` |
| MOD-21 | TIM-535 The model setting and CLI, TIM-542 item 30 | Tim | not run |  | `rule` | `models` |
| MOD-22 | TIM-542 item 24, TIM-536 item 2 | Tim | not run |  | `rule` | `models` |
| MOD-23 | TIM-542 items 19 and 22 | Tim | not run |  | `rule` | `models` |
| MOD-24 | TIM-535 Login | Tim | not run |  | `rule` | `models` |
| MOD-25 | TIM-535 The model setting, amended by TIM-557 items 27 and 40 and by TIM-559 ruling on MOD-G6 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `models` |
| MOD-26 | TIM-535 Login, confirmed by TIM-544 | Tim | run |  | `rule` | `models` |
| MOD-27 | TIM-535 How this sits on clanka | Tim | run |  | `rule` | `models` |
| MOD-28 | TIM-535 How this sits on clanka | Tim | run |  | `rule` | `models` |
| MOD-29 | TIM-544 item 1 | Tim | not run |  | `rule` | `models` |
| MOD-30 | TIM-544 item 2, amending TIM-531 item 1 | Tim | run |  | `rule` | `plugin-api` |
| MOD-31 | TIM-531 item 7, kept by TIM-544 item 1, TIM-559 cold read | Tim | run |  | `rule` | `models` |
| MOD-32 | TIM-544 item 1 and "The header's name", amending TIM-531 item 7, TIM-559 cold read | Tim | run |  | `rule` | `models` |
| MOD-33 | TIM-535 Login, amended by TIM-544 item 3 | Tim | run |  | `rule` | `models` |
| MOD-34 | TIM-544 item 3, TIM-559 cold read | Tim | run |  | `rule` | `models` |
| MOD-35 | TIM-535 Login | Tim | run |  | `rule` | `models` |
| MOD-36 | TIM-535 Login, TIM-534 item 15 | Tim | not run |  | `rule` | `models` |
| MOD-37 | TIM-535 Login | Tim | run |  | `rule` | `plugin-api` |
| MOD-38 | Map "Agreed at charting", TIM-533 item 10, TIM-535 Login | Tim | run |  | `rule` | `models` |
| MOD-39 | TIM-533 item 10 | Tim | run |  | `rule` | `models` |
| MOD-40 | TIM-535 Login | Tim | not run |  | `rule` | `models` |
| MOD-41 | TIM-535 Login | Tim | run |  | `rule` | `models` |
| MOD-42 | TIM-535 Login, limited to a turn that an owner message started by TIM-559 round 3 on DIS-G25 | Architect (Tim has not read) | run | TIM-559 | `rule` | `models` |
| MOD-43 | TIM-535 Login | Tim | run |  | `rule` | `models` |
| MOD-44 | TIM-535 Login, TIM-544 "Facts later tickets depend on" | Tim | run |  | `rule` | `models` |
| MOD-45 | TIM-533 item 10, TIM-535 Login and How this sits on clanka, amended by TIM-557 item 14 and by TIM-559 ruling on MOD-G11 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `models` |
| MOD-46 | TIM-544 "Facts later tickets depend on", amended by TIM-557 item 12 | Architect (Tim has not read) | run | TIM-557 | `rule` | `models` |
| MOD-47 | TIM-535 Login | Tim | run |  | `rule` | `models` |
| MOD-48 | TIM-535 Login | Tim | not run |  | `rule` | `models` |
| MOD-49 | TIM-535 Login, amended by TIM-557 item 14 | Architect (Tim has not read) | run | TIM-557 | `rule` | `models` |
| MOD-50 | TIM-544 item 4, retry line in TIM-557 item 17 | Tim | not run |  | `rule` | `models` |
| MOD-51 | TIM-544 item 4 | Tim | run |  | `rule` | `models` |
| MOD-52 | TIM-535 Login, amended by TIM-559 ruling on MOD-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| MOD-53 | TIM-535 Login, amended by TIM-557 items 36 and 40 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| MOD-54 | TIM-544 item 5, amended by TIM-559 ruling on MOD-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| MOD-55 | TIM-535 CLI | Tim | not run |  | `rule` | `models` |
| MOD-56 | TIM-535 CLI, TIM-542 item 3 | Tim | not run |  | `rule` | `models` |
| MOD-57 | TIM-535 CLI, TIM-542 items 3 and 24 | Tim | not run |  | `rule` | `models` |
| MOD-58 | TIM-550 item 9 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-59 | TIM-542 item 6, amended by TIM-559 ruling on MOD-G12 and MOD-G13, TIM-559 cold read | Architect (Tim has not read) | not run | TIM-559 | `rule` | `models` |
| MOD-60 | TIM-535 CLI, TIM-544 part 2 | Tim | run |  | `rule` | `models` |
| MOD-61 | TIM-544 item 6 | Tim | run |  | `rule` | `models` |
| MOD-62 | TIM-535 CLI, TIM-542 item 30 | Tim | not run |  | `rule` | `models` |
| MOD-63 | TIM-550 item 2, amending TIM-542 item 30 | Architect (Tim has not read) | run | TIM-550 | `rule` | `models` |
| MOD-64 | TIM-542 item 24 | Tim | not run |  | `rule` | `models` |
| MOD-65 | TIM-542 item 33 | Tim | not run |  | `rule` | `settings` |
| MOD-66 | TIM-535 Token store, TIM-536 item 1 | Tim | run |  | `rule` | `models` |
| MOD-67 | TIM-535 Token store, TIM-536 item 12 | Tim | run |  | `rule` | `models` |
| MOD-68 | TIM-536 item 12, TIM-544 "Facts later tickets depend on" | Tim | not run |  | `rule` | `models` |
| MOD-69 | TIM-535 Token store, TIM-559 cold read | Tim | read |  | `fact` | `models` |
| MOD-70 | TIM-535 Token store, TIM-542 item 31 | Tim | read |  | `definition` | - |
| MOD-71 | TIM-544 item 7 | Tim | run |  | `fact` | `live` |
| MOD-72 | TIM-557 item 20 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-73 | TIM-558 items 13 and 14 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| MOD-74 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-75 | TIM-557 items 12 and 14, amended by TIM-559 ruling on MOD-G11 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `models` |
| MOD-76 | TIM-557 items 12 and 14, amended by TIM-559 ruling on MOD-G11 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `models` |
| MOD-77 | TIM-557 items 12 and 14 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| MOD-78 | TIM-557 item 16 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `timers-cron` |
| MOD-79 | TIM-559 ruling on MOD-G3 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-80 | TIM-559 ruling on MOD-G2 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-81 | TIM-559 ruling on MOD-G2 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-82 | TIM-559 ruling on MOD-G2 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-83 | TIM-559 ruling on MOD-G2 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-84 | TIM-559 ruling on MOD-G2 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-85 | TIM-559 ruling on MOD-G2 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-86 | TIM-559 ruling on MOD-G4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-87 | TIM-559 ruling on MOD-G4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-88 | TIM-559 ruling on MOD-G4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-89 | TIM-559 ruling on MOD-G4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-90 | TIM-559 ruling on MOD-G7 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-91 | TIM-559 ruling on MOD-G8 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-92 | TIM-559 ruling on MOD-G8 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-93 | TIM-559 ruling on MOD-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `models` |
| MOD-94 | TIM-559 ruling on MOD-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `models` |
| MOD-95 | TIM-559 ruling on MOD-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `models` |
| MOD-96 | TIM-559 ruling on MOD-G18 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-97 | TIM-559 ruling on MOD-G18 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-98 | TIM-559 ruling on MOD-G18 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `harness` |
| MOD-99 | TIM-559 ruling on MOD-G14 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-100 | TIM-559 ruling on MOD-G10 and DIS-G7 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-101 | TIM-559 ruling on MOD-G12 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `models` |
| MOD-102 | TIM-559 ruling on MOD-G22 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-103 | TIM-559 ruling on MOD-G22 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-104 | TIM-559 ruling on MOD-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| MOD-105 | TIM-559 ruling on MOD-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| MOD-106 | TIM-559 ruling on MOD-G11, FAIL-G2 and CRON-G16 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| MOD-107 | TIM-559 ruling on MOD-G12 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-108 | TIM-559 ruling on MOD-G13 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `models` |
| MOD-109 | TIM-559 ruling on MOD-G14 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-110 | TIM-559 ruling on MOD-G14 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-111 | TIM-559 ruling on MOD-G16 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-112 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-113 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| MOD-114 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| MOD-115 | TIM-559 round 3 on DIS-G25 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| MOD-116 | TIM-559 round 3 on DIS-G25 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| MOD-117 | TIM-559 round 3 L1 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
