// An HTTP MCP server and its OAuth authorization server, as one node:http server in the test's own process. It checks
// what a real pair checks: the bearer token on every MCP request, the client, the redirect URI, the PKCE verifier and
// the one use of a code and of a refresh token. It records what it was asked, so a scenario asserts what chad sent.
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"

export interface Options {
  /** The client the owner registered, which the token endpoint asks the secret of. With none, clients register. */
  readonly client?: { readonly id: string; readonly secret: string }
  /** The tools the MCP server lists. */
  readonly tools?: ReadonlyArray<string>
}

export interface FakeOAuth {
  /** The MCP server's URL. */
  readonly url: string
  /** The path of every request it got, the MCP endpoint's aside. */
  readonly asked: () => ReadonlyArray<string>
  /** The body of each dynamic registration. */
  readonly registrations: () => ReadonlyArray<Record<string, unknown>>
  /** The query of each authorization request, which only a browser makes. */
  readonly authorizations: () => ReadonlyArray<Record<string, string>>
  /** The form of each token request. */
  readonly exchanges: () => ReadonlyArray<Record<string, string>>
  /** Every access and refresh token it issued. */
  readonly issued: () => ReadonlyArray<string>
  /** The access token it takes now. */
  readonly access: () => string | undefined
  /** Ends the access token, as its lifetime does. The refresh token stays good. */
  readonly expire: () => void
  /** Ends the access token and the refresh token, as the owner revoking chad does. */
  readonly revoke: () => void
  /** Opens an authorization URL as the owner's browser does, approves, and gives the address it is sent to. */
  readonly approve: (url: string) => Promise<string>
  readonly close: () => Promise<void>
}

const body = async (request: IncomingMessage) => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

export const make = async (options: Options = {}): Promise<FakeOAuth> => {
  const tools = options.tools ?? ["echo"]
  const asked: Array<string> = []
  const registrations: Array<Record<string, unknown>> = []
  const authorizations: Array<Record<string, string>> = []
  const exchanges: Array<Record<string, string>> = []
  const issued: Array<string> = []
  /** Each code not yet used, with the request it answers. */
  const codes = new Map<string, Record<string, string>>()
  const clients = new Set<string>(options.client ? [options.client.id] : [])
  let access: string | undefined
  let refresh: string | undefined
  let count = 0

  const server = createServer((request, response) => {
    const json = (status: number, value: unknown, headers = {}) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...headers,
      })
      response.end(JSON.stringify(value))
    }
    const base = `http://${request.headers.host}`
    const url = new URL(request.url ?? "/", base)
    void (async () => {
      if (url.pathname === "/mcp") {
        if (
          access === undefined ||
          request.headers.authorization !== `Bearer ${access}`
        )
          return json(
            401,
            { error: "invalid_token" },
            {
              "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
            },
          )
        if (request.method !== "POST") return json(405, {})
        const { id, method, params } = JSON.parse(await body(request))
        const result = (value: unknown) =>
          json(200, { jsonrpc: "2.0", id, result: value })
        if (method === "initialize")
          return result({
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1.0.0" },
          })
        if (method === "tools/list")
          return result({
            tools: tools.map((name) => ({
              name,
              description: `The ${name} tool`,
              inputSchema: { type: "object", additionalProperties: true },
            })),
          })
        if (method === "tools/call")
          return result({
            content: [
              { type: "text", text: JSON.stringify(params.arguments ?? {}) },
            ],
          })
        if (id === undefined) return response.writeHead(202).end()
        return result({})
      }
      asked.push(url.pathname)
      if (url.pathname === "/.well-known/oauth-protected-resource")
        return json(200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
        })
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(options.client
            ? {}
            : { registration_endpoint: `${base}/register` }),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
          scopes_supported: ["read"],
        })
      if (url.pathname === "/register" && options.client === undefined) {
        const registration = JSON.parse(await body(request))
        registrations.push(registration)
        const id = `registered-${registrations.length}`
        clients.add(id)
        return json(201, { ...registration, client_id: id })
      }
      if (url.pathname === "/authorize") {
        const query = Object.fromEntries(url.searchParams)
        authorizations.push(query)
        if (
          !clients.has(query["client_id"] ?? "") ||
          query["code_challenge_method"] !== "S256"
        )
          return json(400, { error: "invalid_request" })
        const code = `code-${++count}`
        codes.set(code, query)
        const to = new URL(query["redirect_uri"]!)
        to.searchParams.set("code", code)
        to.searchParams.set("state", query["state"] ?? "")
        return response.writeHead(302, { location: to.toString() }).end()
      }
      if (url.pathname === "/token") {
        const form = Object.fromEntries(
          new URLSearchParams(await body(request)),
        )
        exchanges.push(form)
        // A refusal quotes what it was sent, as a server's error may, which chad must keep out of what it prints.
        const refuse = (error: string) =>
          json(400, {
            error,
            error_description: `refused ${form["client_secret"] ?? ""} ${form["refresh_token"] ?? ""}`,
          })
        if (
          options.client !== undefined &&
          (form["client_id"] !== options.client.id ||
            form["client_secret"] !== options.client.secret)
        )
          return refuse("invalid_client")
        if (form["grant_type"] === "authorization_code") {
          const asked = codes.get(form["code"] ?? "")
          codes.delete(form["code"] ?? "")
          if (
            asked === undefined ||
            asked["client_id"] !== form["client_id"] ||
            asked["redirect_uri"] !== form["redirect_uri"] ||
            asked["code_challenge"] !==
              createHash("sha256")
                .update(form["code_verifier"] ?? "")
                .digest("base64url")
          )
            return refuse("invalid_grant")
        } else if (
          form["grant_type"] !== "refresh_token" ||
          refresh === undefined ||
          form["refresh_token"] !== refresh
        )
          return refuse("invalid_grant")
        access = `access-canary-${++count}`
        refresh = `refresh-canary-${++count}`
        issued.push(access, refresh)
        return json(200, {
          access_token: access,
          refresh_token: refresh,
          token_type: "Bearer",
          expires_in: 3600,
        })
      }
      return json(404, {})
    })().catch((error) => json(500, { error: String(error) }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    asked: () => asked,
    registrations: () => registrations,
    authorizations: () => authorizations,
    exchanges: () => exchanges,
    issued: () => issued,
    access: () => access,
    expire: () => {
      access = undefined
    },
    revoke: () => {
      access = undefined
      refresh = undefined
    },
    approve: async (url) => {
      const response = await fetch(url, { redirect: "manual" })
      const location = response.headers.get("location")
      if (location === null)
        throw new Error(
          `the authorization was refused: ${await response.text()}`,
        )
      return location
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
