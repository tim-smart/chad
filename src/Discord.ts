import { GatewayIntentBits, Permissions } from "dfx/types"
import { Data, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { version } from "./Version.ts"

/**
 * What chad asks of Discord: the one list of gateway intents and channel permissions. The daemon identifies with it
 * and the CLI builds the invite URL from it, so neither can ask for something the other leaves out.
 */

/** The gateway intents chad identifies with: guilds, guild messages, direct messages and message content. */
export const intents =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.DirectMessages |
  GatewayIntentBits.MessageContent

/** The intents Discord calls privileged, each under the name its developer portal gives the switch. */
const privileged = [
  [GatewayIntentBits.GuildPresences, "Presence Intent"],
  [GatewayIntentBits.GuildMembers, "Server Members Intent"],
  [GatewayIntentBits.MessageContent, "Message Content Intent"],
] as const

/** The names of the privileged intents in chad's list, which no invite URL can grant. */
export const privilegedIntentNames: ReadonlyArray<string> = privileged
  .filter(([bit]) => (intents & bit) !== 0)
  .map(([, name]) => name)

/** The intents of the list that Discord calls privileged. */
export const privilegedIntents = privileged
  .filter(([bit]) => (intents & bit) !== 0)
  .reduce((bits, [bit]) => bits | bit, 0)

/** The permissions the bot needs in a server channel. */
export const permissions =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.SendMessagesInThreads |
  Permissions.CreatePublicThreads |
  Permissions.ReadMessageHistory |
  Permissions.AttachFiles

/** The root of Discord's REST API, which is the one dfx asks. */
export const restRoot = "https://discord.com/api/v10"

/** Discord's OAuth2 authorize URL that adds the bot of an application to a server, with chad's permissions. */
export const inviteUrl = (application: string): string =>
  `https://discord.com/oauth2/authorize?client_id=${application}&scope=bot+applications.commands&permissions=${permissions}`

/** A token that did not pass the check. `refused` is Discord's own answer, and anything else left it unchecked. */
export class TokenCheckFailed extends Data.TaggedError("TokenCheckFailed")<{
  readonly reason: "refused" | "unchecked"
  /** What came back: the status of Discord's answer, or the request's own error when no answer came. */
  readonly detail: string
}> {}

const Application = Schema.Struct({
  id: Schema.String,
  bot: Schema.optionalKey(Schema.Struct({ username: Schema.String })),
  flags: Schema.optionalKey(Schema.Number),
})

/** A request to Discord's REST API as the bot whose token it carries. */
const asBot = (request: HttpClientRequest.HttpClientRequest, token: string) =>
  request.pipe(
    HttpClientRequest.setHeaders({
      authorization: `Bot ${token}`,
      "user-agent": `DiscordBot (https://github.com/tim-smart/chad, ${version})`,
    }),
  )

/**
 * The application flags that say the message content intent is on: `GATEWAY_MESSAGE_CONTENT` for a verified app and
 * `GATEWAY_MESSAGE_CONTENT_LIMITED`, the portal's switch, for one in fewer than 100 servers.
 */
const messageContentFlag = 1 << 18
const messageContentLimitedFlag = 1 << 19

/**
 * Checks a bot token against Discord by asking for the application the token belongs to. The answer carries the
 * application's id, which the invite URL needs, and the bot's name. A 401 is a token Discord refuses.
 */
export const checkToken = Effect.fn("Discord.checkToken")(function* (
  token: string,
) {
  const client = yield* HttpClient.HttpClient
  const unchecked = (detail: string) =>
    new TokenCheckFailed({ reason: "unchecked", detail })
  const response = yield* client
    .execute(
      asBot(HttpClientRequest.get(`${restRoot}/applications/@me`), token),
    )
    .pipe(Effect.mapError((error) => unchecked(error.message)))
  if (response.status === 401) {
    return yield* new TokenCheckFailed({ reason: "refused", detail: "401" })
  }
  if (response.status !== 200) {
    return yield* unchecked(String(response.status))
  }
  const application = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Application)),
    // An answer that names no application is no answer to the check.
    Effect.mapError(() => unchecked(String(response.status))),
  )
  return {
    application: application.id,
    flags: application.flags ?? 0,
    ...(application.bot === undefined ? {} : { bot: application.bot.username }),
  }
})

/**
 * Turns the message content intent on for the bot of a checked token, through Discord's API, which allows it for an
 * app in fewer than 100 servers. `on` is a switch this call made, `already` one that was on, and `portal` an answer
 * that leaves the owner to click it.
 */
export const messageContent = Effect.fn("Discord.messageContent")(function* (
  token: string,
  flags: number,
) {
  if ((flags & (messageContentFlag | messageContentLimitedFlag)) !== 0)
    return "already" as const
  const client = yield* HttpClient.HttpClient
  const request = yield* HttpClientRequest.patch(
    `${restRoot}/applications/@me`,
  ).pipe(
    HttpClientRequest.bodyJson({ flags: flags | messageContentLimitedFlag }),
  )
  return yield* client.execute(asBot(request, token)).pipe(
    Effect.map((response) =>
      response.status === 200 ? ("on" as const) : ("portal" as const),
    ),
    Effect.orElseSucceed(() => "portal" as const),
  )
})
