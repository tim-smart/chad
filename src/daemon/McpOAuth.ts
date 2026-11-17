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
  /** Forgets which servers a layer was refused on, as each rebuild connects them again. */
  readonly reset: () => void
  /** The provider a layer connects a signed-in server with. It refreshes, and never begins an authorization. */
  readonly provider: (target: Target) => OAuthClientProvider
  /** The provider of an HTTP server with no `oauth` key, which turns a 401 into what to change. */
  readonly refusing: (name: string) => OAuthClientProvider
  /** Every stored value that must reach no output: the tokens, a registered client's secret and a pending verifier. */
  readonly hidden: () => ReadonlyArray<string>
  /** Begins a sign-in and gives the authorization URL. One it replaces can no longer be finished. */
  readonly begin: (target: Target) => Effect.Effect<string, string>
  /** Finishes the sign-in with the address the owner's browser ended on. */
  readonly finish: (
    target: Target,
    address: string,
  ) => Effect.Effect<void, string>
  /** Drops what is stored for a server name: tokens, registered client and pending sign-in. False when it held none. */
  readonly logout: (name: string) => Effect.Effect<boolean>
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
   * Writes the whole store by a temporary file and a rename, as the secret store is written. A write that fails is
   * logged and the daemon keeps what it holds in memory, so a refreshed token still serves until the next start.
   */
  const persist = Effect.gen(function* () {
    const directory = dirname(path)
    yield* fs.makeDirectory(directory, { recursive: true })
    yield* fs.chmod(directory, 0o700)
    const temporary = `${path}.${process.pid}.tmp`
    yield* fs.writeFileString(
      temporary,
      JSON.stringify(Object.fromEntries(entries), null, 2) + "\n",
      { mode: 0o600 },
    )
    yield* fs.chmod(temporary, 0o600)
    yield* fs.rename(temporary, path)
  }).pipe(
    Effect.catch((error) =>
      Logger.event(
        "mcp.oauth-unwritable",
        "The MCP sign-ins could not be written",
        { error: Errno.code(error) },
      ),
    ),
    (effect) => semaphore.withPermit(effect),
  )
  const context = yield* Effect.context<never>()
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
    entries.set(target.name, entry)
  }

  const needsLogin = (name: string) => new Error(Messages.mcpNeedsLogin(name))

  /**
   * The provider of one server. `sign` is set for the owner's sign-in, which takes the URL the SDK would open and
   * sends no stored token, so the SDK authorizes anew in place of refreshing. Without it the provider is a layer's.
   */
  const providerOf = (
    target: Target,
    sign?: { readonly state: string; url?: URL },
  ): OAuthClientProvider => {
    const { name, oauth } = target
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
        const client = configured ?? own(target)?.client
        // A layer never registers a client: that is the first step of a sign-in.
        if (client === undefined && sign === undefined) throw needsLogin(name)
        return client
      },
      // A client `mcp.json` names is used as it is, so the SDK has no way to register another.
      ...(configured !== undefined
        ? {}
        : {
            saveClientInformation: (client: OAuthClientInformationMixed) => {
              update(target, (entry) => {
                entry.client = client
              })
              return saved()
            },
          }),
      tokens: () => (sign === undefined ? own(target)?.tokens : undefined),
      saveTokens: (tokens) => {
        refused.delete(name)
        update(target, (entry) => {
          entry.tokens = tokens
        })
        return saved()
      },
      ...(sign === undefined ? {} : { state: () => sign.state }),
      redirectToAuthorization: (url) => {
        if (sign === undefined) {
          refused.add(name)
          throw needsLogin(name)
        }
        sign.url = url
      },
      saveCodeVerifier: (verifier) => {
        // A layer's verifier is never used, and must not replace that of a sign-in the owner is making.
        if (sign === undefined) return
        update(target, (entry) => {
          entry.pending = { state: sign.state, verifier }
        })
        return saved()
      },
      codeVerifier: () => {
        const verifier = own(target)?.pending?.verifier
        if (verifier === undefined) throw needsLogin(name)
        return verifier
      },
      invalidateCredentials: (scope) => {
        // A sign-in sent no stored token, so a code the server refused says nothing of the tokens in use.
        if (sign !== undefined && scope === "tokens") return
        update(target, (entry) => {
          if (scope === "all" || scope === "client") delete entry.client
          if (scope === "all" || scope === "tokens") delete entry.tokens
          if (scope === "all" || scope === "discovery") delete entry.discovery
          if (scope === "verifier") delete entry.pending
        })
        return saved()
      },
      saveDiscoveryState: (discovery) => {
        update(target, (entry) => {
          entry.discovery = discovery
        })
        return saved()
      },
      discoveryState: () => own(target)?.discovery,
    }
  }

  /** One half of a sign-in, with its deadline. What it fails with carries no token and no client secret. */
  const signing = <A>(
    target: Target,
    work: (fetchFn: typeof fetch) => Promise<A>,
  ): Effect.Effect<A, string> =>
    Effect.tryPromise({
      try: (signal) => work((input, init) => fetch(input, { ...init, signal })),
      catch: (error) => {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes(noRegistration)
          ? Messages.mcpLoginNoRegistration(target.name)
          : Messages.mcpLoginError(
              target.name,
              Messages.firstLine(target.scrub(message)),
            )
      },
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
    )

  const hidden = (): ReadonlyArray<string> =>
    [...entries.values()].flatMap((entry) =>
      [
        entry.tokens?.access_token,
        entry.tokens?.refresh_token,
        entry.tokens?.id_token,
        entry.client?.client_secret,
        entry.pending?.verifier,
      ].filter((value) => typeof value === "string"),
    )

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
      // The client a registration gave and the tokens of an earlier sign-in stay until this one ends. What the
      // earlier sign-in found is looked up again.
      update(target, (entry) => {
        delete entry.discovery
        entry.pending = { state }
      })
      yield* persist
      const sign: { readonly state: string; url?: URL } = { state }
      const scope = scopeOf(target)
      yield* signing(target, async (fetchFn) => {
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
      const error = params.get("error")
      if (error !== null)
        return yield* Effect.fail(
          Messages.mcpLoginDenied(
            target.name,
            Messages.firstLine(
              [error, params.get("error_description") ?? ""]
                .filter((part) => part !== "")
                .join(": "),
            ),
          ),
        )
      const code = params.get("code")
      if (code === null || code === "")
        return yield* Effect.fail(Messages.mcpLoginNoCode(target.name))
      if (params.get("state") !== pending.state)
        return yield* Effect.fail(Messages.mcpLoginOtherState(target.name))
      const scope = scopeOf(target)
      yield* signing(target, (fetchFn) =>
        auth(providerOf(target, { state: pending.state }), {
          serverUrl: target.url,
          authorizationCode: code,
          fetchFn,
          ...(scope === undefined ? {} : { scope }),
        }),
      )
      update(target, (entry) => {
        delete entry.pending
      })
      yield* persist
    }),
    logout: Effect.fnUntraced(function* (name) {
      refused.delete(name)
      if (!entries.delete(name)) return false
      yield* persist
      return true
    }),
  } satisfies McpOAuth as McpOAuth
})
