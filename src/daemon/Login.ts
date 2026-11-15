import { DeviceCodeHandler } from "clanka/DeviceCodeHandler"
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import * as Messages from "../Messages.ts"

/**
 * The handler clanka's logins hand a device code to. chad does not post a code yet, so a login that needs one ends
 * as a defect and nothing is posted. A defect is also how a turn with no owner present ends at once, because `onCode`
 * has no error channel and clanka retries only failures (docs/spec/05-model-and-login.md).
 */
export const handler = Layer.succeed(DeviceCodeHandler, {
  onCode: () => Effect.die(new Error(Messages.loginUnavailable)),
})

/**
 * Set on a fiber that asks the login for a token with no owner present, as the check at start does. Such a fiber
 * starts no device flow: clanka answers a refresh that failed by clearing the token and asking for a device code, and
 * the client below refuses that request before it leaves (MOD-94).
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
