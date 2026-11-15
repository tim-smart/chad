// Discord without Discord, for the wire slice: a gateway socket the scenario scripts, and a REST server that answers
// what the adapter and dfx ask. dfx's own shard, its socket handling and its REST client all run for real on top.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Layer } from "effect"
import { Socket } from "effect/socket"

/** The id of chad's bot user, which the fake REST server answers `/users/@me` with. */
export const bot = "900000000000000001"

/** The URL dfx dials first. It is fixed in dfx, which does not dial the URL that `/gateway/bot` gives. */
export const gatewayUrl = "wss://gateway.discord.gg/"

/** The URL a `READY` tells the client to resume on. */
export const resumeUrl = "wss://resume.discord.test/"

/** The REST root dfx asks, which the driver's HTTP client sends to the fake server. */
export const restRoot = "https://discord.com/api/v10"

/** Gateway opcodes, as Discord numbers them. */
export const Op = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
} as const

/** Something a scenario waits on: it resolves when `ready` first gives a value, checked on every change. */
class Changes {
  private readonly waiting = new Set<() => void>()
  changed() {
    for (const check of this.waiting) check()
  }
  until<A>(ready: () => A | undefined): Promise<A> {
    return new Promise((resolve) => {
      const check = () => {
        const value = ready()
        if (value === undefined) return
        this.waiting.delete(check)
        resolve(value)
      }
      this.waiting.add(check)
      check()
    })
  }
}

/** One WebSocket the daemon opened to the gateway. The scenario plays Discord's end of it. */
/** The data of a gateway payload or the body of a REST call, as the JSON object it was sent as. */
export type Data = { readonly [key: string]: unknown }

export class GatewaySocket extends EventTarget {
  readyState = 0
  binaryType = "arraybuffer"
  /** How the socket ended: the close code, and which end closed it. */
  closed: { readonly code: number; readonly by: "chad" | "discord" } | undefined
  readonly url: string
  private readonly changes: Changes
  private readonly written: Array<{ op: number; d: Data }> = []

  constructor(url: string, changes: Changes) {
    super()
    this.url = url
    this.changes = changes
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.dispatchEvent(new Event("open"))
    })
  }

  // The client's end, which dfx calls.
  send(data: string) {
    this.written.push(JSON.parse(data))
    this.changes.changed()
  }
  close(code = 1000, reason = "") {
    this.end(code, reason, "chad")
  }

  // Discord's end, which the scenario calls.
  /** Sends one payload to the daemon. */
  receive(payload: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    )
  }
  /** Closes the socket from Discord's end with a close code. */
  drop(code: number) {
    this.end(code, "", "discord")
  }
  /** Waits until the daemon has written `count` payloads with the opcode, and gives the data of each. */
  sent(op: number, count: number): Promise<ReadonlyArray<Data>> {
    return this.changes.until(() => {
      const found = this.written.filter((payload) => payload.op === op)
      return found.length >= count
        ? found.map((payload) => payload.d)
        : undefined
    })
  }
  /** The opcodes of what the daemon has written so far, in order. */
  opcodes(): ReadonlyArray<number> {
    return this.written.map((payload) => payload.op)
  }
  /** Waits until the socket is closed, by either end. */
  ended(): Promise<NonNullable<GatewaySocket["closed"]>> {
    return this.changes.until(() => this.closed)
  }

  private end(code: number, reason: string, by: "chad" | "discord") {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.closed = { code, by }
    this.changes.changed()
    queueMicrotask(() =>
      this.dispatchEvent(new CloseEvent("close", { code, reason })),
    )
  }
}

/** The scripted gateway: every socket the daemon opens, in order. */
export interface Gateway {
  readonly layer: Layer.Layer<Socket.WebSocketConstructor>
  readonly sockets: () => ReadonlyArray<GatewaySocket>
  /** Waits for the daemon to open its socket number `index`, counted from 0. */
  readonly socket: (index: number) => Promise<GatewaySocket>
}

export const gateway = (): Gateway => {
  const changes = new Changes()
  const sockets: Array<GatewaySocket> = []
  return {
    layer: Layer.succeed(Socket.WebSocketConstructor, (url) => {
      const socket = new GatewaySocket(url, changes)
      sockets.push(socket)
      changes.changed()
      return socket as unknown as globalThis.WebSocket
    }),
    sockets: () => sockets,
    socket: (index) => changes.until(() => sockets[index]),
  }
}

// Payloads, as Discord sends them.

export const hello = { op: Op.hello, d: { heartbeat_interval: 41_250 } }

export const ready = (s: number, session = "session-1") => ({
  op: Op.dispatch,
  t: "READY",
  s,
  d: {
    v: 10,
    session_id: session,
    resume_gateway_url: resumeUrl,
    user: { id: bot, username: "chad", bot: true },
  },
})

export const resumed = (s: number) => ({
  op: Op.dispatch,
  t: "RESUMED",
  s,
  d: {},
})

export interface Posted {
  readonly id: string
  readonly channel: string
  /** Discord's channel type: 0 is a server channel, 1 a DM and 11 a public thread. Left out, the adapter asks. */
  readonly channelType?: number
  readonly author: string
  readonly bot?: boolean
  /** Set for a message a webhook posted. Discord gives such a message the webhook's id as its author's id. */
  readonly webhook?: boolean
  readonly content: string
  readonly guild?: string
  /** The ids of the users the message mentions. */
  readonly mentions?: ReadonlyArray<string>
}

/** A `MESSAGE_CREATE` dispatch with sequence `s`. */
export const messageCreate = (s: number, message: Posted) => ({
  op: Op.dispatch,
  t: "MESSAGE_CREATE",
  s,
  d: {
    type: 0,
    id: message.id,
    channel_id: message.channel,
    ...(message.channelType === undefined
      ? {}
      : { channel_type: message.channelType }),
    ...(message.guild === undefined ? {} : { guild_id: message.guild }),
    ...(message.webhook === true ? { webhook_id: message.author } : {}),
    author: {
      id: message.author,
      username: `user-${message.author}`,
      discriminator: "0",
      bot: message.bot === true || message.webhook === true,
    },
    content: message.content,
    timestamp: "2026-11-15T00:00:00+00:00",
    edited_timestamp: null,
    tts: false,
    pinned: false,
    flags: 0,
    mention_everyone: false,
    mentions: (message.mentions ?? []).map((id) => ({
      id,
      username: `user-${id}`,
      discriminator: "0",
      bot: id === bot,
    })),
    mention_roles: [],
    attachments: [],
    embeds: [],
    components: [],
  },
})

/** One request the daemon made to the fake REST server. */
export interface RestCall {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<
    Record<string, string | ReadonlyArray<string> | undefined>
  >
  readonly body: Data | null
}

/** The fake Discord REST server. */
export interface Rest {
  readonly url: string
  readonly calls: () => ReadonlyArray<RestCall>
  /** Waits for `count` calls with the method whose path matches, and gives them. */
  readonly called: (
    method: string,
    path: RegExp,
    count?: number,
  ) => Promise<ReadonlyArray<RestCall>>
  /** Says what kind of channel an id is, for the adapter's `getChannel`. An unknown id is a DM. */
  readonly channel: (id: string, type: number) => void
  readonly close: () => Promise<void>
}

export const rest = async (): Promise<Rest> => {
  const changes = new Changes()
  const calls: Array<RestCall> = []
  const channels = new Map<string, number>()
  const threads = new Set<string>()
  const messages = new Map<string, Data>()
  let next = BigInt("1000000000000000000")
  const user = { id: bot, username: "chad", discriminator: "0", bot: true }

  const answer = (call: RestCall): readonly [number, unknown] => {
    const path = call.path.replace(/\?.*$/, "")
    const route = `${call.method} ${path}`
    if (route === "GET /gateway/bot") {
      return [
        200,
        {
          url: "wss://gateway.discord.gg",
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: 999,
            reset_after: 0,
            max_concurrency: 1,
          },
        },
      ]
    }
    if (route === "GET /users/@me") return [200, user]
    const channel = /^\/channels\/(\d+)$/.exec(path)
    if (call.method === "GET" && channel !== null) {
      const id = channel[1]!
      return [200, { id, type: channels.get(id) ?? 1 }]
    }
    const post = /^\/channels\/(\d+)\/messages$/.exec(path)
    if (call.method === "POST" && post !== null) {
      const message = {
        id: String(++next),
        type: 0,
        channel_id: post[1],
        author: user,
        content: call.body?.content ?? "",
        timestamp: "2026-11-15T00:00:00+00:00",
        edited_timestamp: null,
        tts: false,
        pinned: false,
        flags: call.body?.flags ?? 0,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        components: [],
      }
      messages.set(message.id, message)
      return [200, message]
    }
    const message = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path)
    if (call.method === "GET" && message !== null) {
      return [
        200,
        messages.get(message[2]!) ?? {
          id: message[2],
          type: 0,
          channel_id: message[1],
          author: { id: "1", username: "someone", discriminator: "0" },
          content: "a message",
          timestamp: "2026-11-15T00:00:00+00:00",
          mentions: [],
          attachments: [],
          embeds: [],
        },
      ]
    }
    const thread = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(path)
    if (call.method === "POST" && thread !== null) {
      const id = thread[2]!
      // Discord opens one thread for a message, and the thread has the message's id.
      if (threads.has(id)) {
        return [
          400,
          {
            code: 160004,
            message: "A thread has already been created for this message",
          },
        ]
      }
      threads.add(id)
      channels.set(id, 11)
      return [
        201,
        { id, type: 11, parent_id: thread[1], name: call.body?.name ?? "" },
      ]
    }
    return [404, { code: 0, message: `the fake has no ${route}` }]
  }

  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8")
      // A body that is not a JSON object is kept as its text, so that a scenario can still see it.
      let body: Data | null = null
      try {
        if (text !== "") body = JSON.parse(text)
      } catch {
        body = { text }
      }
      const call: RestCall = {
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body,
      }
      const [status, json] = answer(call)
      calls.push(call)
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(json))
      changes.changed()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    called: (method, path, count = 1) =>
      changes.until(() => {
        const found = calls.filter(
          (call) => call.method === method && path.test(call.path),
        )
        return found.length >= count ? found : undefined
      }),
    channel: (id, type) => void channels.set(id, type),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
