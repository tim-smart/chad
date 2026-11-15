// PROTOTYPE (TIM-554). The `chad secret` commands. `run`, `code` and `list` read secrets/secrets.json
// themselves and import nothing from effect. `set`, `rm` and `request` go to the daemon when it is up.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join, relative } from "node:path"
import { constants } from "node:os"
import * as S from "./secrets.ts"

const argv = process.argv.slice(2)
const out = (s: string) => process.stdout.write(s)
const err = (s: string) => process.stderr.write(s.endsWith("\n") ? s : s + "\n")
const die = (code: number, message: string): never => {
  err(message)
  process.exit(code)
}
const readStdin = async () => {
  let s = ""
  for await (const chunk of process.stdin) s += chunk
  return s.replace(/\r?\n$/, "")
}

const sockAbs = join(S.DATA, "state", "chad.sock")
// sun_path is 108 bytes (TIM-550), so a long absolute path is given relative to the working directory.
const sockPath = () => (Buffer.byteLength(sockAbs) > 107 ? relative(process.cwd(), sockAbs) : sockAbs)

/** One call to the daemon. undefined when there is no daemon. */
const call = async <A>(f: (client: any, Effect: any) => any): Promise<{ ok: A } | { ended: { exit: number; message: string } } | undefined> => {
  if (!existsSync(sockAbs)) return undefined
  const [Effect, Exit, Cause, Layer, RpcClient, RpcSerialization, NodeSocket, { ChadRpcs }] = await Promise.all([
    import("effect/Effect"), import("effect/Exit"), import("effect/Cause"), import("effect/Layer"), import("effect/rpc/RpcClient"),
    import("effect/rpc/RpcSerialization"), import("@effect/platform-node/NodeSocket"), import("./rpcs.ts")
  ])
  const layer = RpcClient.layerProtocolSocket().pipe(Layer.provide(NodeSocket.layerNet({ path: sockPath() })), Layer.provide(RpcSerialization.layerNdjson))
  const headers: Record<string, string> = {}
  if (process.env.CHAD_SESSION) headers["chad-session"] = process.env.CHAD_SESSION
  const exit: any = await Effect.runPromiseExit(
    Effect.gen(function*() {
      const client = yield* RpcClient.make(ChadRpcs)
      return yield* f(client, Effect)
    }).pipe(RpcClient.withHeaders(headers), Effect.scoped, Effect.provide(layer)) as any
  )
  if (Exit.isSuccess(exit)) return { ok: exit.value as A }
  const e: any = Cause.squash(exit.cause)
  if (e?._tag === "Ended") return { ended: e }
  if (/ENOENT|ECONNREFUSED/.test(String(e?.message ?? e) + String(e?.cause ?? ""))) return undefined
  return { ended: { exit: 1, message: "chad: the daemon call failed: " + String(e?.message ?? e).slice(0, 300) } }
}

const flags = (args: Array<string>, spec: Record<string, "bool" | "value" | "list">) => {
  const got: Record<string, any> = {}
  const rest: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--") {
      rest.push(...args.slice(i))
      break
    }
    const kind = spec[a]
    if (kind === undefined) {
      if (a.startsWith("-")) die(2, "chad: unknown flag " + a)
      rest.push(a)
    } else if (kind === "bool") got[a] = true
    else {
      const v = args[++i]
      if (v === undefined) die(2, "chad: " + a + " needs a value")
      if (kind === "list") (got[a] ??= []).push(v)
      else got[a] = v
    }
  }
  return { got, rest }
}

const secretRun = async (args: Array<string>) => {
  const split = args.indexOf("--")
  if (split === -1 || split === args.length - 1) die(125, "chad secret run: usage: chad secret run [--env VAR=NAME]... [--stdin NAME] -- <command> [args]")
  const { got } = flags(args.slice(0, split), { "--env": "list", "--stdin": "value" })
  const command = args.slice(split + 1)
  const store = S.load()
  const value = async (name: string): Promise<string> => {
    const entry = store[name]
    if (entry === undefined) return die(125, "chad secret run: no secret named " + name)
    // A TOTP secret gives its current code, never its seed.
    return entry.kind === "totp" ? (await S.currentCode(entry)).code : entry.value
  }
  const env: Record<string, string> = {}
  for (const pair of (got["--env"] ?? []) as Array<string>) {
    const eq = pair.indexOf("=")
    if (eq < 1) die(125, "chad secret run: --env takes VAR=NAME, got " + pair)
    env[pair.slice(0, eq)] = await value(pair.slice(eq + 1))
  }
  const stdin = got["--stdin"] === undefined ? undefined : await value(got["--stdin"])
  const child = spawn(command[0], command.slice(1), { env: { ...process.env, ...env }, stdio: [stdin === undefined ? "inherit" : "pipe", "inherit", "inherit"] })
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal))
  child.on("error", (e: any) => die(e.code === "ENOENT" ? 127 : 126, "chad secret run: " + command[0] + ": " + (e.code === "ENOENT" ? "command not found" : e.message)))
  if (stdin !== undefined) {
    child.stdin!.on("error", () => {})
    // No trailing newline, then end of file.
    child.stdin!.end(stdin)
  }
  child.on("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals as any)[signal!]))
}

const secretCode = async (args: Array<string>) => {
  const name = args[0]
  const entry = S.load()[name]
  if (entry === undefined) die(1, "chad secret code: no secret named " + name)
  if (entry.kind !== "totp") die(1, "chad secret code: " + name + " is not a TOTP secret")
  const c = await S.currentCode(entry)
  // The code alone on stdout, so $(chad secret code NAME) is the code. The time left goes to stderr.
  out(c.code + "\n")
  err(c.left + "s left" + (c.waited > 0 ? " (waited " + c.waited + "ms for a new window)" : ""))
}

const secretList = () => {
  const store = S.load()
  for (const [name, e] of Object.entries(store)) out([name, e.kind, e.note ?? "-", e.date.slice(0, 10)].join("\t") + "\n")
}

const secretSet = async (args: Array<string>) => {
  const { got, rest } = flags(args, { "--totp": "bool", "--note": "value" })
  const name = rest[0]
  if (!S.NAME.test(name ?? "")) die(2, "chad secret set: the name must match " + S.NAME.source)
  const value = await readStdin()
  if (value === "") die(2, "chad secret set: no value on stdin")
  const totp = got["--totp"] === true
  const sent = await call<{ replaced: boolean; short: boolean; restarted: Array<string> }>((c) => c.SecretSet({ name, value, totp, note: got["--note"] }))
  let result: { replaced: boolean; short: boolean; restarted: ReadonlyArray<string> }
  if (sent === undefined) {
    // No daemon: the CLI writes the file. Nothing is running that could name the secret.
    const applied = setLocal(name, value, totp, got["--note"])
    if ("error" in applied) return die(1, "chad secret set: " + applied.error)
    result = { ...applied, restarted: [] }
  } else if ("ended" in sent) return die(sent.ended.exit, sent.ended.message)
  else result = sent.ok
  out((result.replaced ? "Replaced " : "Saved ") + name + (result.restarted.length > 0 ? ", restarted " + result.restarted.join(", ") : "") + "\n")
  if (result.short) err("warning: " + name + " is under " + S.MASK_MIN + " characters, so it will not be masked")
}

/** The one place a value is stored. The daemon calls it from its queue, the CLI when there is no daemon. */
export const setLocal = (name: string, value: string, totp: boolean, note: string | undefined): { replaced: boolean; short: boolean } | { error: string } => {
  const store = S.load()
  const replaced = store[name] !== undefined
  if (totp) {
    const parsed = S.parseTotp(value)
    if ("error" in parsed) return { error: parsed.error }
    const typed = value.trim()
    store[name] = { value: parsed.seed, kind: "totp", note, date: new Date().toISOString(), totp: parsed.totp, ...(typed !== parsed.seed ? { typed } : {}) }
    S.save(store)
    return { replaced, short: parsed.seed.length < S.MASK_MIN }
  }
  store[name] = { value, kind: "plain", note, date: new Date().toISOString() }
  S.save(store)
  return { replaced, short: value.length < S.MASK_MIN }
}

const secretRm = async (args: Array<string>) => {
  const name = args[0]
  const sent = await call<boolean>((c) => c.SecretRm({ name }))
  if (sent === undefined) {
    const store = S.load()
    if (store[name] === undefined) die(1, "chad secret rm: no secret named " + name)
    delete store[name]
    S.save(store)
  } else if ("ended" in sent) die(sent.ended.exit, sent.ended.message)
  out("Removed " + name + "\n")
}

const secretRequest = async (args: Array<string>) => {
  const { got, rest } = flags(args, { "--totp": "bool", "--code": "bool", "--no-wait": "bool", "--note": "value", "-m": "value" })
  const code = got["--code"] === true
  const name = rest[0]
  if (code && name !== undefined) die(2, "chad secret request: --code takes no name, nothing is stored")
  if (code && got["--no-wait"]) die(2, "chad secret request: --code cannot be used with --no-wait")
  if (!code && !S.NAME.test(name ?? "")) die(2, "chad secret request: the name must match " + S.NAME.source)
  const session = process.env.CHAD_SESSION
  if (session === undefined || session === "" || session === "daemon") {
    die(1, "chad secret request: there is no chat thread to ask in here. Save it yourself with: chad secret set " + (name ?? "NAME"))
  }
  const sent = await call<{ result: string; code?: string; message: string }>((c) =>
    c.SecretRequest({ name, kind: code ? "code" : got["--totp"] ? "totp" : "plain", note: got["--note"], why: got["-m"], noWait: got["--no-wait"] === true })
  )
  if (sent === undefined) return die(4, "chad secret request: no daemon")
  if ("ended" in sent) return die(sent.ended.exit, sent.ended.message)
  if (sent.ok.result === "code") out(sent.ok.code + "\n")
  else out(sent.ok.message + "\n")
}

const main = async () => {
  if (argv[0] !== "secret") die(2, "chad: this prototype only has: chad secret set|list|rm|run|code|request")
  const rest = argv.slice(2)
  switch (argv[1]) {
    case "run": return secretRun(rest)
    case "code": return secretCode(rest)
    case "list": return secretList()
    case "set": return secretSet(rest)
    case "rm": return secretRm(rest)
    case "request": return secretRequest(rest)
    default: die(2, "chad secret: unknown command " + argv[1])
  }
}
if (import.meta.main) await main()
