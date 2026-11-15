import type { RetriesExhausted } from "clanka/AgentOutput"
import { Cause, Data, Schema } from "effect"
import { AiError } from "effect/ai"

/**
 * Why a turn failed: one tag of a closed set of seven (FAIL-43, SES-131, CRON-45), with the fields API-112 gives each.
 * The `turns` row stores the tag in `failure` and the whole reason, encoded, in `failure_detail` (STO-76).
 */
export const Reason = Schema.Union([
  // The turn's thread no longer exists (FAIL-44).
  Schema.TaggedStruct("ThreadGone", {}),
  // clanka's stream failed with RetriesExhausted or with an AiError it does not retry (FAIL-45).
  Schema.TaggedStruct("ModelError", {
    reason: Schema.String,
    message: Schema.String,
    retries: Schema.Number,
  }),
  // The provider said the plan's usage limit is reached. The reset time is stored as epoch milliseconds (FAIL-206).
  Schema.TaggedStruct("UsageLimit", {
    /** Integer milliseconds since the epoch, like the times in the `turns` table (FAIL-206). */
    resetsAt: Schema.optionalKey(Schema.Number),
  }),
  // A login the turn needed did not complete.
  Schema.TaggedStruct("LoginFailed", {
    reason: Schema.Literals([
      "TimedOut",
      "DeviceFlowFailed",
      "TokenExchangeFailed",
      "RefreshFailed",
    ]),
  }),
  // A turn with no owner present on a chad that is logged out.
  Schema.TaggedStruct("LoggedOut", {}),
  // A resumed turn chad stopped retrying after two kills (FAIL-49).
  Schema.TaggedStruct("GaveUp", {}),
  // Any other defect in chad or in clanka, a full disk included (FAIL-50).
  Schema.TaggedStruct("Internal", { message: Schema.String }),
])
export type Reason = typeof Reason.Type
export type Tag = Reason["_tag"]

const ReasonJson = Schema.toCodecJson(Reason)
const encodeReason = Schema.encodeSync(ReasonJson)
const decodeReason = Schema.decodeUnknownOption(ReasonJson)

/** A reason as `failure_detail` holds it. */
export const detail = (reason: Reason): string =>
  JSON.stringify(encodeReason(reason))

/**
 * The reason a row records. A row with no detail, or one whose detail no longer decodes, gives the bare tag it holds
 * when that tag needs no fields, and `Internal` otherwise.
 */
export const fromRow = (
  failure: string | null,
  stored: string | null,
): Reason => {
  if (stored !== null) {
    try {
      const decoded = decodeReason(JSON.parse(stored))
      if (decoded._tag === "Some") return decoded.value
    } catch {
      // A detail that is not JSON is read as if it were missing.
    }
  }
  switch (failure) {
    case "ThreadGone":
    case "LoggedOut":
    case "GaveUp":
      return { _tag: failure }
    default:
      return { _tag: "Internal", message: failure ?? "unknown" }
  }
}

/**
 * chad's own end of a turn's model part, for the two cases clanka would keep retrying: the silence bound and a usage
 * limit (SES-133). It carries the reason the turn ends with, which `classify` gives as it is.
 */
export class Ended extends Data.TaggedError("TurnEnded")<{
  readonly reason: Reason
}> {}

/**
 * Whether an error is clanka's turn timeout, which is how clanka reports a model call that sent nothing for
 * `Agent.TurnTimeout`. This is the one place chad matches clanka's wording (FAIL-204), and a test runs it against real
 * clanka and a silent model (FAIL-205, TST-181).
 */
export const isTurnTimeout = (error: AiError.AiError): boolean =>
  error.module === "clanka/Agent" &&
  error.method === "send" &&
  error.reason._tag === "UnknownError" &&
  error.reason.description === "TurnTimeout was reached"

/** The codes that end a turn as `UsageLimit` with no reset time, on either transport (FAIL-88). */
const limitCodes: ReadonlySet<unknown> = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
])

type Metadata = Readonly<Record<string, unknown>>

const record = (value: unknown): Metadata | undefined =>
  typeof value === "object" && value !== null ? (value as Metadata) : undefined

/** The provider's fields of an error: the WebSocket frame's `error` as it is, and the HTTP body's under `openai`. */
const fieldsOf = (error: AiError.AiError) => {
  const reason = error.reason as unknown as {
    readonly metadata?: unknown
    readonly http?: { readonly body?: unknown }
  }
  const socket = record(reason.metadata)
  const http = record(socket?.["openai"])
  return { socket, http, body: reason.http?.body }
}

/** The reset time an HTTP body holds as `resets_at` in epoch seconds, in epoch milliseconds (FAIL-90, FAIL-206). */
const resetOf = (body: unknown): number | undefined => {
  if (typeof body !== "string") return undefined
  try {
    const seconds = record(record(JSON.parse(body))?.["error"])?.["resets_at"]
    return typeof seconds === "number" && Number.isFinite(seconds)
      ? Math.round(seconds * 1000)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The `UsageLimit` an error names, or nothing (FAIL-46, FAIL-88). Only an HTTP body carries a reset time, because
 * effect's WebSocket decoder drops `resets_at` (FAIL-90, FAIL-97).
 */
export const usageLimit = (
  error: AiError.AiError,
): Extract<Reason, { readonly _tag: "UsageLimit" }> | undefined => {
  const reason = error.reason
  if (reason._tag === "QuotaExhaustedError") return { _tag: "UsageLimit" }
  const { socket, http, body } = fieldsOf(error)
  if (http?.["errorType"] === "usage_limit_reached") {
    const resetsAt = resetOf(body)
    return resetsAt === undefined
      ? { _tag: "UsageLimit" }
      : { _tag: "UsageLimit", resetsAt }
  }
  if (
    socket?.["type"] === "usage_limit_reached" &&
    (reason._tag === "RateLimitError" ||
      reason._tag === "InternalProviderError")
  ) {
    return { _tag: "UsageLimit" }
  }
  if (limitCodes.has(socket?.["code"]) || limitCodes.has(http?.["errorCode"])) {
    return { _tag: "UsageLimit" }
  }
  return undefined
}

/** Whether an error says the plan does not include the usage, which ends the turn at once as `ModelError` (FAIL-89). */
export const notIncluded = (error: AiError.AiError): boolean => {
  const { socket, http } = fieldsOf(error)
  return (
    socket?.["type"] === "usage_not_included" ||
    http?.["errorType"] === "usage_not_included"
  )
}

const isRetriesExhausted = (error: unknown): error is RetriesExhausted =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "RetriesExhausted" &&
  AiError.isAiError((error as { readonly error?: unknown }).error)

/** The text of a defect or an error, as `Internal` carries it. */
const messageOf = (value: unknown): string =>
  value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : String(value)

type LoginReason = Extract<Reason, { readonly _tag: "LoginFailed" }>["reason"]

/**
 * The reason of a failed login that a defect carries, or nothing. clanka's client dies with its `CodexAuthError`, and
 * chad's own timeout dies with `LoginTimedOut` (MOD-46, MOD-75, MOD-76). A defect that wraps one in its `cause`
 * counts too.
 */
const loginReason = (defect: unknown): LoginReason | undefined => {
  for (let value = defect, depth = 0; depth < 5; depth++) {
    if (typeof value !== "object" || value === null) return undefined
    const tag = (value as { readonly _tag?: unknown })._tag
    if (tag === "LoginTimedOut") return "TimedOut"
    if (tag === "CodexAuthError") {
      const reason = (value as { readonly reason?: unknown }).reason
      if (
        reason === "DeviceFlowFailed" ||
        reason === "TokenExchangeFailed" ||
        reason === "RefreshFailed"
      ) {
        return reason
      }
    }
    value = (value as { readonly cause?: unknown }).cause
  }
  return undefined
}

/**
 * The reason a turn failed with, from the cause its model part or chad's own code ended with. chad's own end gives its
 * reason, a failed login is `LoginFailed`, a usage limit is `UsageLimit`, clanka's other model failures are
 * `ModelError`, and anything else is `Internal`.
 */
export const classify = (cause: Cause.Cause<unknown>): Reason => {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail" && reason.error instanceof Ended) {
      return reason.error.reason
    }
  }
  for (const reason of cause.reasons) {
    const login =
      reason._tag === "Die"
        ? loginReason(reason.defect)
        : reason._tag === "Fail"
          ? loginReason(reason.error)
          : undefined
    if (login !== undefined) return { _tag: "LoginFailed", reason: login }
  }
  for (const reason of cause.reasons) {
    if (reason._tag !== "Fail") continue
    const error = reason.error
    if (isRetriesExhausted(error)) {
      const limit = usageLimit(error.error)
      if (limit !== undefined) return limit
      return {
        _tag: "ModelError",
        reason: error.error.reason._tag,
        message: error.error.reason.message,
        retries: error.retries,
      }
    }
    if (AiError.isAiError(error)) {
      // A usage limit is also recognised in a final error, such as the API key path's `QuotaExhaustedError` (FAIL-87).
      const limit = usageLimit(error)
      if (limit !== undefined) return limit
      return {
        _tag: "ModelError",
        reason: error.reason._tag,
        message: error.reason.message,
        retries: 0,
      }
    }
  }
  return { _tag: "Internal", message: messageOf(Cause.squash(cause)) }
}
