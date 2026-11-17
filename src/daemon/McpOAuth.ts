/**
 * The OAuth sign-ins of the HTTP MCP servers whose `mcp.json` entry has an `oauth` key: the store on the volume, the
 * provider clanka hands the SDK's transport, and the two halves of a sign-in the owner makes.
 *
 * chad has no listener a browser can be sent back to. A sign-in gives the owner the authorization URL, the owner
 * approves in a browser, and the address the browser ends on comes back as text, from which chad takes `code` and
 * `state`. The redirect URL is only a value chad sends.
 *
 * Nothing but the owner starts a sign-in. The provider a layer connects with sends the stored token and lets the SDK
 * refresh it, and where the SDK would begin an authorization it fails with what to ask the owner instead.
 */
import { createHash, randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js"
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  Duration,
  Effect,
  FileSystem,
  Redacted,
  Schema,
  Semaphore,
} from "effect"
import * as Errno from "../Errno.ts"
import * as McpFile from "../McpFile.ts"
import * as Messages from "../Messages.ts"
import * as Logger from "./Logger.ts"

/** The store, beside the secret store and with its care: `secrets/` is 0700 and the file 0600. */
export const file = (data: string) => join(data, "secrets", "mcp-oauth.json")

/** An HTTP server that signs in with OAuth, after expansion. */
export interface Target {
  readonly name: string
  readonly url: string
  /** The entry's own headers, which the first request of a sign-in carries as every request to the server does. */
  readonly headers: Readonly<Record<string, string>>
  readonly oauth: McpFile.OAuth
  /** Keeps the values the server's names expanded to, its client secret and every stored token out of a text. */
  readonly scrub: (text: string) => string
}

/**
 * What a server's stored sign-in is bound to: its URL and every value of its `oauth` block. A server whose URL or
 * block changed has another binding, and what was stored under the old one is never sent for it.
 */
const bindingOf = ({ url, oauth }: Target) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        url,
        oauth.clientId ?? null,
        oauth.clientSecret ?? null,
        oauth.redirectUrl,
        oauth.scopes ?? null,
      ]),
    )
    .digest("hex")

const Json = Schema.Record(Schema.String, Schema.Unknown)

/** The file: one entry per server name. The SDK's own values are kept whole, as it handed them over. */
const Stored = Schema.Record(
  Schema.String,
  Schema.Struct({
    binding: Schema.String,
    /** The client a dynamic registration gave. A client `mcp.json` names is never stored. */
    client: Schema.optionalKey(Json),
    tokens: Schema.optionalKey(Json),
    /** The authorization server the sign-in found, which a refresh and the second half of a sign-in go back to. */
    discovery: Schema.optionalKey(Json),
    /** A sign-in the owner has not finished: its `state` and its PKCE verifier. */
    pending: Schema.optionalKey(
      Schema.Struct({
        state: Schema.String,
        verifier: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
)

interface Entry {
  binding: string
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discovery?: OAuthDiscoveryState
  pending?: { state: string; verifier?: string }
}

const decodeStored = Schema.decodeUnknownResult(Schema.fromJsonString(Stored))

/** The SDK's words for an authorization server with no registration endpoint. */
const noRegistration = "does not support dynamic client registration"

/** The SDK's words for a server that answers 401 to the token a refresh has just given. */
const stillUnauthorized = "Server returned 401 after successful authentication"

/** What a provider answers the SDK with once a newer sign-in or a sign-out has taken the place of its own. */
class Replaced extends Error {}

/** How many secrets that left the store stay hidden for each server name. */
const retiredKept = 64

export interface McpOAuth {
  /** The target of a resolved server, or none for one with no `oauth` key or that expansion left unavailable. */
  readonly target: (
    name: string,
    resolved: McpFile.Resolved,
  ) => Target | undefined
  /** Whether a usable sign-in is stored for the server as it is configured now. */
  readonly signedIn: (target: Target) => boolean
  /**
   * Whether the server needs a sign-in: nothing usable is stored, or the running layer was answered 401 and the
   * refresh could not fix it.
   */
  readonly needsLogin: (target: Target) => boolean
  /**
   * Whether a failure of the server's transport is a 401 that outlived a refresh the authorization server allowed.
   * Nothing chad holds gets it past that, so the server then needs a login.
   */
  readonly refuses: (target: Target, error: string) => boolean
  /** Forgets which servers a layer was refused on, as each rebuild connects them again. */
  readonly reset: () => void
  /** The provider a layer connects a signed-in server with. It refreshes, and never begins an authorization. */
  readonly provider: (target: Target) => OAuthClientProvider
  /** The provider of an HTTP server with no `oauth` key, which turns a 401 into what to change. */
  readonly refusing: (name: string) => OAuthClientProvider
  /** Every stored value that must reach no output: the tokens, a registered client's secret and a pending verifier. */
  readonly hidden: () => ReadonlyArray<string>
  /**
   * Begins a sign-in and gives the authorization URL. One it replaces can no longer be finished, and neither can one
   * a sign-out came after: what either still hears from the server is dropped.
   */
  readonly begin: (target: Target) => Effect.Effect<string, string>
  /** Finishes the sign-in with the address the owner's browser ended on. */
  readonly finish: (
    target: Target,
    address: string,
  ) => Effect.Effect<void, string>
  /**
   * Drops what is stored for a server name: tokens, registered client and pending sign-in. False when it held none.
   * It fails when the store could not be written, and the sign-in then stands as it was.
   */
  readonly logout: (name: string) => Effect.Effect<boolean, string>
}

export const make = Effect.fnUntraced(function* (options: {
  readonly data: string
  /** How long one half of a sign-in has for its requests to the server and its authorization server. */
  readonly timeout: Duration.Duration
}) {
  const fs = yield* FileSystem.FileSystem
  const path = file(options.data)
  const semaphore = yield* Semaphore.make(1)
  const entries = new Map<string, Entry>()
  /** The servers whose running connection was answered 401 with nothing left to refresh. */
  const refused = new Set<string>()
  /**
   * The newest sign-in or sign-out of each server name. A sign-in writes only while it is the newest, so an answer
   * that comes back late to one that was replaced, signed out of or timed out changes nothing.
   */
  const newest = new Map<string, number>()
  let attempts = 0
  /** Takes the place of whatever sign-in the name has under way, and says whether it still holds that place. */
  const supersede = (name: string) => {
    const attempt = ++attempts
    newest.set(name, attempt)
    return () => newest.get(name) === attempt
  }
  /**
   * How many times each server name's sign-in was replaced, by a sign-in that finished or by a sign-out. A layer
   * reads and writes only the sign-in it was built on, so what an older layer still hears from the authorization
   * server neither changes a newer sign-in nor is answered with it.
   */
  const eras = new Map<string, number>()
  const eraOf = (name: string) => eras.get(name) ?? 0
  const replaced = (name: string) => {
    eras.set(name, eraOf(name) + 1)
  }

  /** The secrets of an entry, or of a part of one. */
  const secretsOf = (
    entry: Pick<Entry, "tokens" | "client" | "pending"> | undefined,
  ): ReadonlyArray<string> =>
    [
      entry?.tokens?.access_token,
      entry?.tokens?.refresh_token,
      entry?.tokens?.id_token,
      entry?.client?.client_secret,
      entry?.pending?.verifier,
    ].filter((value) => typeof value === "string")
  /**
   * The secrets that left the store, by server name, the newest last: the tokens a refresh, a sign-out or a new
   * sign-in replaced, and those the SDK brought that were never kept. A request sent with one can be answered long
   * after, since closing a transport does not end it, and the server may quote it. So each stays hidden as it was
   * while the store held it. Only the newest `retiredKept` of a name are kept, which is many refreshes more than a
   * request lasts.
   */
  const retired = new Map<string, Array<string>>()
  const retire = (name: string, values: ReadonlyArray<string>) => {
    if (values.length === 0) return
    retired.set(
      name,
      [...(retired.get(name) ?? []), ...values].slice(-retiredKept),
    )
  }

  const text = yield* fs.readFileString(path).pipe(
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed(undefined),
    ),
    Effect.catch((error) =>
      Effect.as(
        Logger.event(
          "mcp.oauth-unreadable",
          "The MCP sign-ins could not be read",
          { error: Errno.code(error) },
        ),
        undefined,
      ),
    ),
  )
  if (text !== undefined) {
    const decoded = decodeStored(text)
    if (decoded._tag === "Success") {
      for (const [name, entry] of Object.entries(decoded.success))
        entries.set(name, entry as unknown as Entry)
    } else {
      yield* Logger.event(
        "mcp.oauth-unreadable",
        "The MCP sign-ins could not be read",
        { error: "malformed" },
      )
    }
  }

  /**
   * Writes the whole store by a temporary file and a rename, as the secret store is written. With `without` it
   * writes the store less that name, and drops the name from memory only once the file no longer holds it. It fails
   * with the errno code, after logging it.
   */
  const write = (without?: string) =>
    Effect.gen(function* () {
      const directory = dirname(path)
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.chmod(directory, 0o700)
      const temporary = `${path}.${process.pid}.tmp`
      const kept = [...entries].filter(([name]) => name !== without)
      yield* fs.writeFileString(
        temporary,
        JSON.stringify(Object.fromEntries(kept), null, 2) + "\n",
        { mode: 0o600 },
      )
      yield* fs.chmod(temporary, 0o600)
      yield* fs.rename(temporary, path)
      if (without !== undefined) {
        retire(without, secretsOf(entries.get(without)))
        entries.delete(without)
      }
    }).pipe(
      Effect.catch((error) => {
        const code = Errno.code(error)
        return Effect.andThen(
          Logger.event(
            "mcp.oauth-unwritable",
            "The MCP sign-ins could not be written",
            { error: code },
          ),
          Effect.fail(code),
        )
      }),
      (effect) => semaphore.withPermit(effect),
    )
  /**
   * A write of what a sign-in or a refresh changed. When it fails the daemon keeps what it holds in memory, so a
   * refreshed token still serves until the next start.
   */
  const persist = Effect.ignore(write())
  const context = yield* Effect.context<never>()
  const runFork = Effect.runForkWith(context)
  /** A change the SDK makes through the provider, which it waits for. */
  const saved = () => Effect.runPromiseWith(context)(persist)

  /** The entry stored for the server as it is configured now. */
  const own = (target: Target): Entry | undefined => {
    const entry = entries.get(target.name)
    return entry?.binding === bindingOf(target) ? entry : undefined
  }
  const update = (target: Target, change: (entry: Entry) => void) => {
    const entry: Entry = { ...(own(target) ?? { binding: bindingOf(target) }) }
    change(entry)
    const now = secretsOf(entry)
    retire(
      target.name,
      secretsOf(entries.get(target.name)).filter(
        (value) => !now.includes(value),
      ),
    )
    entries.set(target.name, entry)
  }

  const needsLogin = (name: string) => new Error(Messages.mcpNeedsLogin(name))

  /**
   * The provider of one server. `sign` is set for the owner's sign-in, which takes the URL the SDK would open and
   * sends no stored token, so the SDK authorizes anew in place of refreshing. Without it the provider is a layer's.
   */
  const providerOf = (
    target: Target,
    sign?: {
      readonly state: string
      /** Whether no newer sign-in and no sign-out has taken this one's place. */
      readonly current: () => boolean
      url?: URL
    },
  ): OAuthClientProvider => {
    const { name, oauth } = target
    /** The sign-in a layer is built on. */
    const era = eraOf(name)
    /**
     * Whether the provider still speaks for the sign-in it was made for: a sign-in while it is the newest, and a layer
     * until a sign-out or a later sign-in takes the place of the sign-in it was built on.
     */
    const live = () =>
      sign === undefined
        ? eraOf(name) === era && own(target) !== undefined
        : sign.current()
    /**
     * The one way to the store, which everything the SDK reads, writes or drops through the provider passes. A
     * request can be answered once its sign-in is gone, and closing a transport does not end it. The SDK then asks
     * on: it drops the tokens, reads them again and refreshes with what it is given. So a provider that is no longer
     * live is given nothing and changes nothing, or it would spend the refresh token of the sign-in made since.
     * `given` is what the SDK brought with it, which is kept out of what chad says even though it is not stored.
     */
    const mine = (given: ReadonlyArray<string> = []) => {
      if (live()) return
      retire(name, given)
      if (sign !== undefined)
        throw new Replaced(Messages.mcpLoginReplaced(name))
      runFork(
        Logger.event(
          "mcp.oauth-stale",
          "An MCP layer asked for its sign-in after the sign-in was replaced",
          { server: name },
        ),
      )
      throw new Replaced(Messages.mcpSignInReplaced(name))
    }
    const change = (
      apply: (entry: Entry) => void,
      given: ReadonlyArray<string> = [],
    ) => {
      mine(given)
      update(target, apply)
      return saved()
    }
    const configured: OAuthClientInformationMixed | undefined =
      oauth.clientId === undefined
        ? undefined
        : {
            client_id: oauth.clientId,
            ...(oauth.clientSecret === undefined
              ? {}
              : { client_secret: oauth.clientSecret }),
          }
    return {
      get redirectUrl() {
        return oauth.redirectUrl
      },
      get clientMetadata() {
        return {
          client_name: "chad",
          redirect_uris: [oauth.redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          // chad registers itself as a public client, which PKCE protects.
          token_endpoint_auth_method: "none",
          ...(oauth.scopes === undefined
            ? {}
            : { scope: oauth.scopes.join(" ") }),
        }
      },
      clientInformation: () => {
        mine()
        const client = configured ?? own(target)?.client
        // A layer never registers a client: that is the first step of a sign-in.
        if (client === undefined && sign === undefined) throw needsLogin(name)
        return client
      },
      // A client `mcp.json` names is used as it is, so the SDK has no way to register another.
      ...(configured !== undefined
        ? {}
        : {
            saveClientInformation: (client: OAuthClientInformationMixed) =>
              change((entry) => {
                entry.client = client
              }, secretsOf({ client })),
          }),
      tokens: () => {
        // A sign-in sends no stored token, so the SDK authorizes anew in place of refreshing.
        if (sign !== undefined) return undefined
        mine()
        return own(target)?.tokens
      },
      saveTokens: (tokens) => {
        const given = secretsOf({ tokens })
        mine(given)
        // A layer only refreshes the tokens of a sign-in that is stored. It never makes one.
        if (sign === undefined && own(target)?.tokens === undefined) {
          retire(name, given)
          throw needsLogin(name)
        }
        update(target, (entry) => {
          entry.tokens = tokens
        })
        refused.delete(name)
        // The layers built before this sign-in ran on another.
        if (sign !== undefined) replaced(name)
        return saved()
      },
      ...(sign === undefined ? {} : { state: () => sign.state }),
      redirectToAuthorization: (url) => {
        mine()
        if (sign === undefined) {
          refused.add(name)
          throw needsLogin(name)
        }
        sign.url = url
      },
      saveCodeVerifier: (verifier) => {
        mine([verifier])
        // A layer's verifier is never used, and must not replace that of a sign-in the owner is making.
        if (sign === undefined) return
        const { state } = sign
        update(target, (entry) => {
          entry.pending = { state, verifier }
        })
        return saved()
      },
      codeVerifier: () => {
        mine()
        const verifier = own(target)?.pending?.verifier
        if (verifier === undefined) throw needsLogin(name)
        return verifier
      },
      invalidateCredentials: (scope) => {
        // A sign-in sent no stored token, so a code the server refused says nothing of the tokens in use.
        if (sign !== undefined && scope === "tokens") return
        return change((entry) => {
          if (scope === "all" || scope === "client") delete entry.client
          if (scope === "all" || scope === "tokens") delete entry.tokens
          if (scope === "all" || scope === "discovery") delete entry.discovery
          if (scope === "verifier") delete entry.pending
        })
      },
      saveDiscoveryState: (discovery) =>
        change((entry) => {
          entry.discovery = discovery
        }),
      discoveryState: () => {
        mine()
        return own(target)?.discovery
      },
    }
  }

  /**
   * Why a request of a sign-in failed, in chad's own words. What a server answered is never repeated: an
   * authorization server may quote the request it refuses, with the code, the verifier and the client secret in
   * whatever encoding they were sent in. Of its answer chad keeps the OAuth error code, which is one of the SDK's own.
   *
   * `exchange` is the half that sends the code. The other half sends nothing secret, so there the SDK's own words
   * for a step that failed are passed on, such as a metadata document that is not there.
   */
  const reasonOf = (target: Target, exchange: boolean, error: unknown) => {
    if (error instanceof OAuthError)
      return Messages.mcpLoginAnswered(error.errorCode)
    if (error instanceof TypeError) {
      const code = (error.cause as NodeJS.ErrnoException | undefined)?.code
      return Messages.mcpLoginUnreachable(
        typeof code === "string" ? code : undefined,
      )
    }
    return !exchange && error instanceof Error && error.constructor === Error
      ? Messages.firstLine(target.scrub(error.message))
      : Messages.mcpLoginUnusable
  }

  /**
   * One half of a sign-in, with its deadline. One that fails is retired, so an answer that still comes back to it
   * after its deadline is dropped.
   */
  const signing = <A>(
    target: Target,
    current: () => boolean,
    exchange: boolean,
    work: (fetchFn: typeof fetch) => Promise<A>,
  ): Effect.Effect<A, string> =>
    Effect.tryPromise({
      try: (signal) => work((input, init) => fetch(input, { ...init, signal })),
      catch: (error) =>
        error instanceof Replaced
          ? Messages.mcpLoginReplaced(target.name)
          : error instanceof Error && error.message.includes(noRegistration)
            ? Messages.mcpLoginNoRegistration(target.name)
            : Messages.mcpLoginError(
                target.name,
                reasonOf(target, exchange, error),
              ),
    }).pipe(
      Effect.timeoutOrElse({
        duration: options.timeout,
        orElse: () =>
          Effect.fail(
            Messages.mcpLoginTimedOut(
              target.name,
              Duration.toSeconds(options.timeout),
            ),
          ),
      }),
      Effect.onError(() =>
        Effect.sync(() => {
          if (current()) supersede(target.name)
        }),
      ),
    )

  const hidden = (): ReadonlyArray<string> => [
    ...[...entries.values()].flatMap(secretsOf),
    ...[...retired.values()].flat(),
  ]

  /**
   * What the server's 401 names: where its metadata is and the scope it asks for. A server that answers anything else
   * is left to the SDK's discovery.
   */
  const challenge = (
    target: Target,
    fetchFn: typeof fetch,
  ): Promise<{ readonly resourceMetadataUrl?: URL; readonly scope?: string }> =>
    fetchFn(target.url, {
      method: "POST",
      headers: {
        ...target.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    }).then(
      async (response) => {
        await response.body?.cancel()
        return response.status === 401
          ? extractWWWAuthenticateParams(response)
          : {}
      },
      () => ({}),
    )

  const scopeOf = (target: Target) =>
    target.oauth.scopes === undefined || target.oauth.scopes.length === 0
      ? undefined
      : target.oauth.scopes.join(" ")

  return {
    target: (name, resolved) =>
      resolved.oauth === undefined || resolved.config.type !== "http"
        ? undefined
        : {
            name,
            url: resolved.config.url,
            headers: Object.fromEntries(
              Object.entries(resolved.config.headers ?? {}).map(
                ([key, value]) => [key, Redacted.value(value)],
              ),
            ),
            oauth: resolved.oauth,
            scrub: McpFile.scrubber([resolved], () => [
              ...hidden(),
              resolved.oauth?.clientSecret ?? "",
            ]),
          },
    signedIn: (target) => own(target)?.tokens !== undefined,
    needsLogin: (target) =>
      own(target)?.tokens === undefined || refused.has(target.name),
    refuses: (target, error) => {
      if (!error.includes(stillUnauthorized)) return false
      refused.add(target.name)
      return true
    },
    reset: () => refused.clear(),
    provider: (target) => providerOf(target),
    refusing: (name) => {
      const unauthorized = () => {
        throw new Error(Messages.mcpUnauthorized(name))
      }
      return {
        redirectUrl: undefined,
        clientMetadata: { redirect_uris: [] },
        clientInformation: unauthorized,
        tokens: () => undefined,
        saveTokens: unauthorized,
        redirectToAuthorization: unauthorized,
        saveCodeVerifier: unauthorized,
        codeVerifier: unauthorized,
        // The first thing the SDK asks after a 401, before it sends anything to an authorization server.
        discoveryState: unauthorized,
      }
    },
    hidden,
    begin: Effect.fnUntraced(function* (target) {
      const state = randomBytes(32).toString("base64url")
      const current = supersede(target.name)
      // The client a registration gave and the tokens of an earlier sign-in stay until this one ends. What the
      // earlier sign-in found is looked up again.
      update(target, (entry) => {
        delete entry.discovery
        entry.pending = { state }
      })
      yield* persist
      const sign: Parameters<typeof providerOf>[1] = { state, current }
      const scope = scopeOf(target)
      yield* signing(target, current, false, async (fetchFn) => {
        const asked = await challenge(target, fetchFn)
        return auth(providerOf(target, sign), {
          serverUrl: target.url,
          fetchFn,
          // The scopes `mcp.json` names go before those the server asks for.
          ...(scope !== undefined
            ? { scope }
            : asked.scope === undefined
              ? {}
              : { scope: asked.scope }),
          ...(asked.resourceMetadataUrl === undefined
            ? {}
            : { resourceMetadataUrl: asked.resourceMetadataUrl }),
        })
      })
      // A sign-out may have come once the link was made, and it dropped the sign-in the link belongs to.
      if (!current())
        return yield* Effect.fail(Messages.mcpLoginReplaced(target.name))
      if (sign.url === undefined)
        return yield* Effect.fail(
          Messages.mcpLoginError(target.name, "the server gave no link"),
        )
      return sign.url.toString()
    }),
    finish: Effect.fnUntraced(function* (target, address) {
      const pending = own(target)?.pending
      if (pending?.verifier === undefined)
        return yield* Effect.fail(Messages.mcpLoginNotStarted(target.name))
      let params: URLSearchParams
      try {
        params = new URL(address.trim()).searchParams
      } catch {
        return yield* Effect.fail(Messages.mcpLoginNotAddress(target.name))
      }
      // Nothing of an address is believed before its state is this sign-in's own, a refusal included.
      if (params.get("state") !== pending.state)
        return yield* Effect.fail(Messages.mcpLoginOtherState(target.name))
      const error = params.get("error")
      if (error !== null)
        return yield* Effect.fail(
          Messages.mcpLoginDenied(
            target.name,
            Messages.firstLine(
              target.scrub(
                [error, params.get("error_description") ?? ""]
                  .filter((part) => part !== "")
                  .join(": "),
              ),
            ),
          ),
        )
      const code = params.get("code")
      if (code === null || code === "")
        return yield* Effect.fail(Messages.mcpLoginNoCode(target.name))
      const scope = scopeOf(target)
      const current = supersede(target.name)
      yield* signing(target, current, true, (fetchFn) =>
        auth(providerOf(target, { state: pending.state, current }), {
          serverUrl: target.url,
          authorizationCode: code,
          fetchFn,
          ...(scope === undefined ? {} : { scope }),
        }),
      )
      // A sign-in begun meanwhile has its own pending state, which stays.
      if (own(target)?.pending?.state === pending.state) {
        update(target, (entry) => {
          delete entry.pending
        })
        yield* persist
      }
    }),
    logout: Effect.fnUntraced(function* (name) {
      // A sign-in under way ends here too: what it still hears from the server is dropped.
      supersede(name)
      if (!entries.has(name)) return false
      // The file is what the next start reads, so the sign-out has happened only once the file is written.
      const written = yield* Effect.result(write(name))
      if (written._tag === "Failure")
        return yield* Effect.fail(
          Messages.mcpLogoutUnsaved(name, written.failure),
        )
      refused.delete(name)
      replaced(name)
      return true
    }),
  } satisfies McpOAuth as McpOAuth
})
