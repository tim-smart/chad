// PROTOTYPE for "Credential tools run on real clanka and a browser sidecar" (TIM-554). Throwaway.
// One child process per run: node scenarios.ts <name> [phase]
// run.ts starts these, sends signals at chosen events and checks the event log.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as ChatTest from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { spawn } from "node:child_process"
import { createDecipheriv, createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DATA, HostLive, OWNER, release, Test } from "./chad/host.ts"
import { LOG, log } from "./chad/log.ts"
import * as S from "./chad/secrets.ts"
import { FAKE } from "./fake.ts"

const [name, phase = "1"] = process.argv.slice(2)
const CHAT = process.env.PROTO_CHAT ?? join(DATA, "chat.json")

const events = (): Array<any> => {
  try {
    return readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
const until = (label: string, pred: (e: any) => boolean, options?: { timeout?: number; count?: number }) =>
  Effect.gen(function*() {
    const deadline = Date.now() + (options?.timeout ?? 60_000)
    while (true) {
      const found = events().filter((e) => e.pid === process.pid && pred(e))
      if (found.length >= (options?.count ?? 1)) return found
      if (Date.now() > deadline) {
        log("scenario.timeout", { label })
        return yield* Effect.die(new Error("timed out waiting for " + label))
      }
      yield* Effect.sleep(20)
    }
  })
const ev = (name: string, extra?: (e: any) => boolean) => (e: any) => e.ev === name && (extra === undefined || extra(e))
const marked = (label: string) => until("mark " + label, ev("script.mark", (e) => e.label === label))

// --- what a script is made of ---------------------------------------------------------------

/** One bash call. Prints OUT and the command's output, or ERR and what clanka threw. */
const sh = (command: string, options: { timeoutMs?: number; background?: boolean } = {}) =>
  "try { const r = await bash(" + JSON.stringify({ command, ...options }) + "); console.log('OUT[' + r.status + '] ' + r.output) } catch (e) { console.log('ERR ' + (e && e.message ? e.message : String(e))) }"
const mark = (label: string) => "await mark({ label: " + JSON.stringify(label) + " })"
const hold = (label: string) => "await hold({ label: " + JSON.stringify(label) + " })"
const plan = (steps: Array<Array<string>>, extra: object = {}) => "PLAN:" + JSON.stringify({ steps: steps.map((s) => s.join("\n")), ...extra })

/** The owner at a terminal: the chad CLI with no CHAD_SESSION. */
const cli = (label: string, args: Array<string>, options: { stdin?: string; env?: Record<string, string>; session?: string } = {}) =>
  Effect.promise(() =>
    new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
      const started = Date.now()
      const env: Record<string, string | undefined> = { ...process.env, ...options.env }
      delete env.CHAD_SESSION
      if (options.session) env.CHAD_SESSION = options.session
      const child = spawn(join(import.meta.dirname, "bin", "chad"), args, { env, stdio: ["pipe", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.stderr.on("data", (d) => (stderr += d))
      child.stdin.end(options.stdin ?? "")
      child.on("exit", (code) => {
        const result = { code, stdout, stderr, ms: Date.now() - started }
        log("cli", { label, args, ...result })
        resolve(result)
      })
    })
  )
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

const setup = Effect.gen(function*() {
  const test = yield* ChatTest.ChatTest
  // ChatTest ids are a counter, so the same calls in the same order give the same thread ids in every process.
  const threads = { A: yield* test.makeThread(), B: yield* test.makeThread(), C: yield* test.makeThread() }
  const post = (who: keyof typeof threads, text: string, authorId = OWNER) =>
    Effect.gen(function*() {
      const thread = threads[who]
      const event: any = yield* test.userPosts(thread, { text, authorId })
      const key = "message/test:" + thread.id + "/" + event.message.id
      log("user.posted", { who, key, length: text.length })
      yield* test.deliver(event)
      return key
    })
  const ended = (key: string, timeout = 60_000) => until("turn.end " + key, ev("turn.end", (e) => e.key === key), { timeout })
  const ask = (who: keyof typeof threads, text: string, timeout?: number) =>
    Effect.gen(function*() {
      const key = yield* post(who, text)
      const [end] = yield* ended(key, timeout)
      log("answer", { who, key, outcome: end.outcome })
      return key
    })
  /** What each thread shows now, written raw. This file is what "everything chad posts to chat" is grepped in. */
  const dump = Effect.gen(function*() {
    const out: Record<string, unknown> = {}
    for (const [who, thread] of Object.entries(threads)) {
      out[who] = (yield* test.messages(thread)).map((m: any) => ({ id: m.id, author: m.author.id, text: m.text, actions: m.actions }))
    }
    // Every post and edit chad made, as the adapter was given it, edits that were later replaced included.
    const calls = (yield* test.calls).map((c: any) => ({ op: c.op, thread: c.thread?.id, messageId: c.messageId, markdown: c.markdown }))
    writeFileSync(CHAT, JSON.stringify({ ...out, calls }, null, 2))
    return out as Record<string, Array<{ id: string; author: string; text: string; actions?: Array<any> }>>
  })
  /** The standard fake secrets, saved through the daemon the way an owner at a terminal would. */
  const seed = Effect.gen(function*() {
    yield* cli("set SITE_PASSWORD", ["secret", "set", "SITE_PASSWORD", "--note", "local test form, user tim"], { stdin: FAKE.password })
    yield* cli("set QUOTED", ["secret", "set", "QUOTED"], { stdin: FAKE.quoted })
    yield* cli("set SITE_TOTP", ["secret", "set", "SITE_TOTP", "--totp"], { stdin: FAKE.totpTyped })
    yield* cli("set TINY", ["secret", "set", "TINY"], { stdin: FAKE.tiny })
  })
  return { test, threads, post, ask, ended, dump, seed }
})
const first = phase === "1"
const SECRETS_FILE = join(DATA, "secrets", "secrets.json")
if (first && process.env.PROTO_MCP) writeFileSync(join(DATA, "mcp.json"), process.env.PROTO_MCP)
if (first && process.env.PROTO_MCP_FILE) writeFileSync(join(DATA, "mcp.json"), readFileSync(process.env.PROTO_MCP_FILE))

/** The pids whose command line has every one of these words. */
const procs = (words: Array<string>): Array<number> => {
  const out: Array<number> = []
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const cmd = readFileSync("/proc/" + entry + "/cmdline", "utf8").split("\0").join(" ")
      // Other scenarios run beside this one, so only this daemon's children count.
      if (words.every((w) => cmd.includes(w)) && readFileSync("/proc/" + entry + "/environ", "utf8").split("\0").includes("CHAD_DATA=" + DATA)) out.push(Number(entry))
    } catch {}
  }
  return out
}
const alive = (pid: number) => existsSync("/proc/" + pid)

const ui = Effect.gen(function*() {
  const test = yield* ChatTest.ChatTest
  /** A click, delivered the way an adapter delivers one. ChatTest gives the handler 3 seconds. */
  const click = (messageId: string, userId: string) =>
    Effect.gen(function*() {
      const event = yield* test.click(messageId, "enter", { userId })
      const started = Date.now()
      const reply: any = yield* test.interact(event as any)
      const modal = reply._tag === "OpenModal" ? reply.modal : undefined
      log("interact.click", {
        messageId, userId, reply: reply._tag, ms: Date.now() - started,
        buttonData: ("enter" + ((event as any).value ?? "")).length,
        modal: modal && { title: modal.title, labels: modal.elements.map((e: any) => e.label), fields: modal.elements.length, metadataLength: (modal.id + (modal.metadata ?? "")).length }
      })
      return { event, reply }
    })
  const submit = (clicked: { event: any; reply: any }, value: string, userId: string) =>
    Effect.gen(function*() {
      const event = yield* test.submit(clicked.event, clicked.reply, { value }, { userId })
      const started = Date.now()
      const exit = yield* Effect.exit(test.interact(event))
      if (exit._tag === "Failure") {
        // What the owner sees in Discord as "Something went wrong": no reply inside the 3 seconds.
        log("interact.submit", { userId, reply: "NONE", error: String(exit.cause).slice(0, 200), ms: Date.now() - started })
        return { _tag: "NONE" }
      }
      const reply: any = exit.value
      log("interact.submit", { userId, reply: reply._tag, errors: reply.errors, ms: Date.now() - started })
      return reply
    })
  const hasButton = (messageId: string) => Effect.map(Effect.exit(test.click(messageId, "enter", { userId: OWNER })), (exit) => exit._tag === "Success")
  return { click, submit, hasButton }
})
const requestPosted = (pred: (e: any) => boolean, count = 1) => Effect.map(until("request.posted", ev("request.posted", pred), { count }), (found) => found[found.length - 1])
const stored = () => S.load(SECRETS_FILE)
const SITE = process.env.PROTO_SITE ?? "http://chad-cred-site:8080"
/** The same sum the page computes over the field's value, so a value can be compared without being printed. */
const fingerprint = (v: string) => v.length + ":" + [...v].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000000007, 7)
/** agent-browser's vault: is the saved password recoverable from the files on the volume alone? */
const vaultCopy = (dir: string) => {
  try {
    const file = JSON.parse(readFileSync(join(dir, "auth", "testsite.json"), "utf8"))
    const keyText = readFileSync(join(dir, ".encryption-key"), "utf8").trim()
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyText, "hex"), Buffer.from(file.iv, "base64"))
    decipher.setAuthTag(Buffer.from(file.authTag, "base64"))
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]).toString("utf8")
    return { encrypted: file.encrypted, keyMode: (statSync(join(dir, ".encryption-key")).mode & 0o777).toString(8), fileMode: (statSync(join(dir, "auth", "testsite.json")).mode & 0o777).toString(8), decryptsWithKeyBesideIt: true, holds: S.found(stored(), plain), fields: Object.keys(JSON.parse(plain)) }
  } catch (e) {
    return { error: String(e).slice(0, 200) }
  }
}

const scenarios: Record<string, Effect.Effect<void, any, any>> = {
  // chad secret run through clanka's bash and the spawner chad wraps.
  run: Effect.gen(function*() {
    const { ask, seed, dump } = yield* setup
    yield* seed
    log("expect", { passwordSha: sha(FAKE.password), passwordLength: FAKE.password.length })
    yield* ask("A", "use the password " + plan([
      [sh("chad secret run --env P=SITE_PASSWORD -- sh -c 'printf \"ENV len=%s sha=%s session=%s\" \"\${#P}\" \"$(printf %s \"$P\" | sha256sum | cut -d\" \" -f1)\" \"$CHAD_SESSION\"'")],
      [sh("chad secret run --stdin SITE_PASSWORD -- sh -c 'printf \"STDIN sha=%s\" \"$(sha256sum | cut -d\" \" -f1)\"; printf \" eof=yes\"'")],
      [sh("chad secret run --stdin SITE_PASSWORD -- wc -c")],
      [sh("chad secret run --env P=NO_SUCH_NAME -- true")],
      [sh("chad secret run --env P=SITE_PASSWORD -- sh -c 'exit 7'")],
      [sh("chad secret run --env P=SITE_PASSWORD -- sh -c 'kill -TERM $$'")],
      [sh("chad secret run -- no-such-command-here")],
      // Item 23, the quoting trap: the outer shell expands $P before chad runs.
      [sh("chad secret run --env P=SITE_PASSWORD -- echo \"TRAP outer=[\${P}]\"")],
      [sh("chad secret run --env P=SITE_PASSWORD -- sh -c 'echo \"TRAP inner len=\${#P}\"'")],
      [sh("chad secret run --env C=SITE_TOTP -- sh -c 'echo \"TOTP via run: $C\"'")],
      [sh("chad secret run --env A=SITE_PASSWORD --env B=QUOTED -- sh -c 'echo \"TWO \${#A} \${#B}\"'")],
      [sh("chad secret code SITE_TOTP")],
      [sh("chad secret list")]
    ]))
    yield* dump
  }),

  // chad secret code: the RFC 6238 vectors, the wait under 5 seconds, the refusal.
  code: Effect.gen(function*() {
    const { seed } = yield* setup
    yield* seed
    const seeds = { SHA1: "12345678901234567890", SHA256: "12345678901234567890123456789012", SHA512: "1234567890123456789012345678901234567890123456789012345678901234" }
    const vectors: Array<[number, string, string, string]> = [
      [59, "94287082", "46119246", "90693936"], [1111111109, "07081804", "68084774", "25091201"], [1111111111, "14050471", "67062674", "99943326"],
      [1234567890, "89005924", "91819424", "93441116"], [2000000000, "69279037", "90698825", "38618901"], [20000000000, "65353130", "77737706", "47863826"]
    ]
    for (const [alg, text] of Object.entries(seeds)) {
      yield* cli("set VEC_" + alg, ["secret", "set", "VEC_" + alg, "--totp"], { stdin: "otpauth://totp/rfc6238?secret=" + S.base32Encode(Buffer.from(text)) + "&digits=8&algorithm=" + alg })
    }
    // The clock is moved to 2 seconds into the vector's window: at the vector's own second the wait rule can apply (T=59 has 1 second left).
    const at = (ms: number) => ({ CHAD_PROTO_TIME_OFFSET_MS: String(ms - Date.now()) })
    for (const [t, ...want] of vectors) {
      for (const [i, alg] of Object.keys(seeds).entries()) {
        log("expect.vector", { t, alg, want: want[i] })
        yield* cli("vec/" + alg + "/" + t, ["secret", "code", "VEC_" + alg], { env: at((Math.floor(t / 30) * 30 + 2) * 1000) })
      }
    }
    const window = (Math.floor(Date.now() / 30_000) + 1000) * 30_000
    const entry = stored().SITE_TOTP
    log("expect.wait", { thisWindow: S.codeAt(entry, window).code, nextWindow: S.codeAt(entry, window + 30_000).code })
    yield* cli("nowait/6s-left", ["secret", "code", "SITE_TOTP"], { env: at(window + 24_000) })
    yield* cli("nowait/5s-left", ["secret", "code", "SITE_TOTP"], { env: at(window + 25_000) })
    yield* cli("wait/4s-left", ["secret", "code", "SITE_TOTP"], { env: at(window + 26_000) })
    yield* cli("wait/1s-left", ["secret", "code", "SITE_TOTP"], { env: at(window + 29_000) })
    yield* cli("runwait/3s-left", ["secret", "run", "--env", "C=SITE_TOTP", "--", "sh", "-c", "echo $C"], { env: at(window + 27_000) })
    yield* cli("refuse/plain", ["secret", "code", "SITE_PASSWORD"])
    yield* cli("refuse/missing", ["secret", "code", "NO_SUCH_NAME"])
    yield* cli("set/bad-seed", ["secret", "set", "BAD_SEED", "--totp"], { stdin: "this is not base32!" })
    yield* cli("set/replace", ["secret", "set", "SITE_PASSWORD"], { stdin: FAKE.password })
    yield* cli("list", ["secret", "list"])
    log("store.shape", { typedKept: entry.typed === FAKE.totpTyped, canonical: entry.value === FAKE.totp, mode: (statSync(SECRETS_FILE).mode & 0o777).toString(8) })
  }),

  // The masking floor, and with PROTO_WRAP=1 the AgentExecutor wrap. The same steps in both.
  mask: Effect.gen(function*() {
    const { ask, seed, dump, test, threads } = yield* setup
    if (!first) {
      // ChatTest numbers messages from 1 in every process. Move past the first boot's ids, or the message's key repeats one the entity already answered.
      for (let i = 0; i < 60; i++) yield* test.userPosts(threads.C, { text: "filler", authorId: "someone-else" })
      // A second boot on the same files: the session reloads its history from the rows chad wrote.
      yield* ask("A", "after a restart " + plan([["console.log('second boot')"]]))
      return
    }
    yield* seed
    const child = "print it " + plan([[sh("chad secret run --env P=SITE_PASSWORD -- printenv P")]], { complete: true })
    // Turn 1: the value arrives only in what scripts print.
    log("turn.marker", { turn: "outputs" })
    yield* ask("A", "print things " + plan([
      [sh("chad secret run --env P=SITE_PASSWORD -- printenv P")],
      [sh("chad secret run --env P=QUOTED -- printenv P")],
      [sh("cat $CHAD_DATA/secrets/secrets.json")],
      [sh("chad secret run --env P=SITE_PASSWORD -- sh -c 'printf %s \"$P\" | base64'")],
      [sh("chad secret run --env P=SITE_PASSWORD -- sh -c 'head -c 40000 /dev/zero | tr \"\\\\0\" x; echo; echo \"$P\"'")],
      ["const sub = await subagent({ prompt: " + JSON.stringify(child) + " }); console.log('SUB ' + sub.output)"],
      ["const t = await bash({ command: \"chad secret run --env P=SITE_PASSWORD -- sh -c 'sleep 1; printenv P'\", background: true }); const done = await waitTasks({ ids: [t.id] }); console.log('BG ' + JSON.stringify(done))"]
    ]), 120_000)
    for (const e of events().filter(ev("brain.scriptOutput"))) {
      const m = /Saved to: (\S+)/.exec(e.output)
      if (m) {
        const text = existsSync(m[1]) ? readFileSync(m[1], "utf8") : ""
        // clanka's own file for a long output. Not written by chad, so nothing masks it.
        log("tmpfile", { path: m[1], exists: existsSync(m[1]), holds: S.found(stored(), text), mode: existsSync(m[1]) ? (statSync(m[1]).mode & 0o777).toString(8) : null })
      }
    }
    // Turn 2: the model writes the value into a script itself.
    log("turn.marker", { turn: "sources" })
    yield* ask("A", "write things " + plan([
      ["const pw = '@@SITE_PASSWORD@@'; console.log('WROTE ' + pw)"],
      ["const q = @@json:QUOTED@@; console.log('WROTEQ ' + q.length)"],
      ["// " + "x".repeat(270) + "\nconsole.log('@@SITE_PASSWORD@@'.length)"]
    ]))
    // Turn 3: a turn that fails with the value in the reason.
    log("turn.marker", { turn: "fails" })
    yield* ask("A", "fail " + plan([[sh("chad secret run --env P=SITE_PASSWORD -- printenv P")]], { fail: true }))
    // Turn 4: the owner types a stored value into the chat.
    log("turn.marker", { turn: "owner" })
    yield* ask("A", "is " + FAKE.password + " still the password? " + plan([["console.log('checked')"]]))
    log("turn.marker", { turn: "end" })
    yield* dump
  }),

  // The Enter button and the modal on ChatTest.
  button: Effect.gen(function*() {
    const { post, ended, dump, threads } = yield* setup
    const { click, submit, hasButton } = yield* ui
    const key = yield* post("A", "get the key " + plan([
      ["console.log('BEFORE ' + JSON.stringify(await mcp.echo.whoami({})))"],
      [sh("chad secret request API_KEY --note 'fake API, user tim' -m 'I need the key for the fake API you named'", { timeoutMs: 330000 })],
      ["console.log('AFTER ' + JSON.stringify(await mcp.echo.whoami({})))"]
    ]))
    const asked = yield* requestPosted((e) => e.name === "API_KEY")
    log("asked.message", { text: (yield* dump).A.find((m) => m.id === asked.messageId)?.text, button: yield* hasButton(asked.messageId) })
    log("expect", { keySha: sha(FAKE.apiKey).slice(0, 16) })
    // Someone who is not an owner clicks.
    yield* click(asked.messageId, "intruder-9")
    log("after.intruder", { stored: stored().API_KEY !== undefined, button: yield* hasButton(asked.messageId) })
    const opened = yield* click(asked.messageId, OWNER)
    // Someone who is not an owner submits the modal the owner opened.
    yield* submit(opened, "intruder-typed-this-0000", "intruder-9")
    log("after.intruderSubmit", { stored: stored().API_KEY !== undefined })
    yield* submit(opened, FAKE.apiKey, OWNER)
    yield* ended(key)
    log("after.submit", { text: (yield* dump).A.find((m) => m.id === asked.messageId)?.text, button: yield* hasButton(asked.messageId), kind: stored().API_KEY?.kind, valueOk: stored().API_KEY?.value === FAKE.apiKey })

    // A TOTP secret through the same button: a seed that does not decode, then one that does.
    yield* post("A", "/secret OTP_ONE totp")
    const otp = yield* requestPosted((e) => e.name === "OTP_ONE")
    const otpOpened = yield* click(otp.messageId, OWNER)
    yield* submit(otpOpened, "this is not base32!", OWNER)
    log("after.badSeed", { stored: stored().OTP_ONE !== undefined, button: yield* hasButton(otp.messageId) })
    yield* submit(otpOpened, FAKE.totpTyped, OWNER)
    yield* until("OTP_ONE saved", ev("submit.saved", (e) => e.name === "OTP_ONE"))
    yield* cli("code OTP_ONE", ["secret", "code", "OTP_ONE"])
    log("after.otp", { kind: stored().OTP_ONE?.kind, text: (yield* dump).A.find((m) => m.id === otp.messageId)?.text })
    // Item 8: a name the live mcp.json uses cannot become a TOTP secret.
    yield* cli("totp/mcp-name", ["secret", "set", "API_KEY", "--totp"], { stdin: FAKE.totp })
    log("after.totpRefused", { kind: stored().API_KEY?.kind })

    // The daemon's queue is busy for 5 seconds, as it is during an apply, when the owner submits.
    yield* post("A", "/secret HELD_ONE")
    const held = yield* requestPosted((e) => e.name === "HELD_ONE")
    const heldOpened = yield* click(held.messageId, OWNER)
    yield* Test.holdQueue(5000)
    yield* until("queue held", ev("test.queueHeld"))
    yield* submit(heldOpened, "FAKE-held-value-0006", OWNER)
    log("after.heldSubmit", { storedAtReply: stored().HELD_ONE !== undefined })
    yield* Effect.sleep(8000)
    log("after.heldWait", { stored: stored().HELD_ONE !== undefined, text: (yield* dump).A.find((m) => m.id === held.messageId)?.text })

    // How long a name the button can carry: the id and the encoded value share 100 characters.
    const session = "s-" + threads.A.id
    for (const n of [68, 69, 70, 74, 75, 76, 77]) {
      const long = "N".repeat(n)
      const asked = yield* cli("len/" + n, ["secret", "request", long, "--no-wait"], { session })
      const posted = events().filter(ev("request.posted", (e) => e.name === long))[0]
      if (posted === undefined) {
        log("len", { n, posted: false, stderr: asked.stderr.replace(long, "N*" + n) })
        continue
      }
      // The button posts. Does the modal it opens fit?
      const opened = yield* Effect.exit(click(posted.messageId, OWNER))
      const modal = opened._tag === "Success" ? (opened.value.reply as any).modal : undefined
      log("len", { n, posted: true, modal: opened._tag === "Success" ? opened.value.reply._tag : "failed: " + String((opened as any).cause).slice(0, 160), modalIdPlusMetadata: modal && (modal.id + (modal.metadata ?? "")).length })
    }
    yield* dump
  }),

  // chad secret request --code.
  "code-request": Effect.gen(function*() {
    const { post, ended, dump, seed } = yield* setup
    const { click, submit, hasButton } = yield* ui
    yield* seed
    const before = sha(readFileSync(SECRETS_FILE, "utf8"))
    const key = yield* post("A", "sms " + plan([
      [sh("chad secret request --code -m 'the SMS code the fake site just sent'", { timeoutMs: 330000 })],
      ["console.log('NEXT STEP RAN')"]
    ]))
    const asked = yield* requestPosted((e) => e.code !== undefined)
    log("asked.message", { text: (yield* dump).A.find((m) => m.id === asked.messageId)?.text })
    yield* click(asked.messageId, "intruder-9")
    const opened = yield* click(asked.messageId, OWNER)
    const typedAt = Date.now()
    yield* submit(opened, "482915", OWNER)
    const [output] = yield* until("the code in the script", ev("brain.scriptOutput", (e) => e.output.includes("482915")))
    log("code.delivered", { ms: output.t - typedAt })
    yield* ended(key)
    const text = readFileSync(SECRETS_FILE, "utf8")
    log("after.code", { storeUnchanged: sha(text) === before, storeHoldsCode: text.includes("482915"), text: (yield* dump).A.find((m) => m.id === asked.messageId)?.text, button: yield* hasButton(asked.messageId) })
  }),

  // An owner message ends a pending request, and /stop kills it.
  interrupt: Effect.gen(function*() {
    const { post, ended, dump } = yield* setup
    const { hasButton } = yield* ui
    // 1. The stored form, then an owner message.
    const k1 = yield* post("A", "log in " + plan([
      [sh("chad secret request LOGIN_PW -m 'for the fake site'", { timeoutMs: 330000 })],
      ["console.log('STEP2 RAN')"]
    ]))
    const a1 = yield* requestPosted((e) => e.name === "LOGIN_PW")
    yield* Effect.sleep(300)
    log("owner.speaks", { n: 1 })
    yield* post("A", "never mind, use the other account")
    yield* ended(k1)
    log("after.1", { button: yield* hasButton(a1.messageId), text: (yield* dump).A.find((m) => m.id === a1.messageId)?.text })
    // 2. --code, then an owner message.
    const k2 = yield* post("A", "sms " + plan([[sh("chad secret request --code -m 'sms code'", { timeoutMs: 330000 })], ["console.log('STEP2 RAN')"]]))
    const a2 = yield* requestPosted((e) => e.code !== undefined && e.thread === a1.thread)
    yield* Effect.sleep(300)
    log("owner.speaks", { n: 2 })
    yield* post("A", "it is 123456")
    yield* ended(k2)
    log("after.2", { button: yield* hasButton(a2.messageId), text: (yield* dump).A.find((m) => m.id === a2.messageId)?.text })

    const stopCase = (who: "B" | "C", n: number, command: string, words: Array<string>, isCode: boolean) =>
      Effect.gen(function*() {
        const key = yield* post(who, "wait " + plan([[sh(command, { timeoutMs: 330000 })], ["console.log('STEP2 RAN')"]]))
        const asked = yield* requestPosted((e) => (isCode ? e.code !== undefined : e.name === "STOP_PW") && e.messageId !== a2.messageId && !seen.has(e.messageId))
        seen.add(asked.messageId)
        yield* Effect.sleep(500)
        const pids = procs(words)
        log("stop.before", { n, pids, command })
        const stoppedAt = Date.now()
        yield* post(who, "/stop")
        let goneMs: number | null = null
        while (Date.now() - stoppedAt < 10_000) {
          if (pids.every((p) => !alive(p))) {
            goneMs = Date.now() - stoppedAt
            break
          }
          yield* Effect.sleep(10)
        }
        yield* ended(key)
        yield* Effect.sleep(500)
        log("stop.after", { n, pids, goneMs, stillAlive: pids.filter(alive), button: yield* hasButton(asked.messageId), text: (yield* dump)[who].find((m) => m.id === asked.messageId)?.text })
      })
    const seen = new Set<string>()
    // 3. --code and /stop. bash execs a single command, so chad is clanka's direct child.
    yield* stopCase("B", 3, "chad secret request --code -m 'sms code'", ["cli.ts", "secret", "request", "--code"], true)
    // 4. The same with bash left as the parent of chad.
    yield* stopCase("C", 4, "chad secret request --code -m 'second code'; echo after", ["cli.ts", "secret", "request", "--code"], true)
    // 5. The stored form and /stop.
    yield* stopCase("B", 5, "chad secret request STOP_PW -m 'stored form'", ["cli.ts", "secret", "request", "STOP_PW"], false)
  }),

  // Repeat requests, and a save by any path.
  repeat: Effect.gen(function*() {
    const { ask, post, ended, dump } = yield* setup
    const { click, submit, hasButton } = yield* ui
    const req = (name: string, more = "") => sh("chad secret request " + name + more + " -m 'again'", { timeoutMs: 330000 })
    yield* ask("A", "ask twice " + plan([[req("DUP", " --no-wait")], [req("DUP", " --no-wait")]]))
    yield* ask("B", "ask elsewhere " + plan([[req("DUP", " --no-wait")]]))
    const posts = events().filter(ev("request.posted", (e) => e.name === "DUP"))
    log("repeat.posts", { posted: posts.length, threads: posts.map((p) => p.thread), remembered: Test.remembered() })
    // An owner's turn asks again and waits on the button that is already there.
    const key = yield* post("A", "ask and wait " + plan([[req("DUP")], ["console.log('STEP2 RAN')"]]))
    yield* until("the repeat", ev("request.repeat", (e) => e.name === "DUP"), { count: 2 })
    yield* Effect.sleep(300)
    // Saved from a terminal, not through the button.
    yield* cli("set DUP", ["secret", "set", "DUP"], { stdin: "FAKE-dup-value-0007" })
    yield* ended(key)
    const chat1 = yield* dump
    log("repeat.saved", {
      texts: posts.map((p) => [...chat1.A, ...chat1.B].find((m) => m.id === p.messageId)?.text),
      buttons: yield* Effect.all(posts.map((p) => hasButton(p.messageId))),
      remembered: Test.remembered()
    })
    // What a restart costs: the daemon forgets its buttons.
    yield* ask("A", "ask " + plan([[req("MEM", " --no-wait")]]))
    yield* ask("B", "ask " + plan([[req("MEM", " --no-wait")]]))
    yield* Test.forgetButtons
    yield* ask("A", "ask again " + plan([[req("MEM", " --no-wait")]]))
    const mem = events().filter(ev("request.posted", (e) => e.name === "MEM"))
    log("forget.posts", { posted: mem.length, threads: mem.map((p) => p.thread) })
    // The oldest button in A is no longer remembered. It still works, because the click is handled from its id.
    const opened = yield* click(mem[0].messageId, OWNER)
    yield* submit(opened, "FAKE-mem-value-0008", OWNER)
    yield* until("MEM saved", ev("submit.saved", (e) => e.name === "MEM"))
    const chat2 = yield* dump
    log("forget.saved", {
      stored: stored().MEM?.value === "FAKE-mem-value-0008",
      texts: mem.map((p) => [...chat2.A, ...chat2.B].find((m) => m.id === p.messageId)?.text?.slice(0, 40)),
      buttons: yield* Effect.all(mem.map((p) => hasButton(p.messageId)))
    })
  }),

  // Item 13, no owner present, and item 15, /secret. Not on TIM-554's list, cheap to run.
  noowner: Effect.gen(function*() {
    const { post, dump, threads, seed, test } = yield* setup
    yield* seed
    const req = (args: string) => sh("chad secret request " + args, { timeoutMs: 330000 })
    const t0 = Date.now()
    yield* Test.pluginTurn(threads.A.id, "a cron turn " + plan([[req("CRON_PW -m 'the nightly job needs it'")], [req("CRON_PW -m 'the nightly job needs it'")], [req("--code -m 'sms'")]]))
    log("plugin.turn", { ms: Date.now() - t0, posted: events().filter(ev("request.posted")).length, chat: (yield* dump).A.map((m) => m.text.slice(0, 60)) })
    const session = "s-" + threads.A.id
    // A background task that outlived its turn: the session has no turn running.
    yield* cli("outlived/stored", ["secret", "request", "LATE_PW"], { session })
    yield* cli("outlived/code", ["secret", "request", "--code"], { session })
    yield* cli("nosession", ["secret", "request", "TERMINAL_PW"])
    yield* cli("daemon", ["secret", "request", "TERMINAL_PW"], { session: "daemon" })
    yield* cli("unknown-session", ["secret", "request", "TERMINAL_PW"], { session: "s-nope" })
    const turnsBefore = events().filter(ev("turn.start")).length
    yield* post("B", "/secret FROM_CHAT")
    yield* post("B", "/secret")
    yield* post("B", "/secret bad-name")
    yield* Effect.sleep(300)
    log("slash", { turnsStarted: events().filter(ev("turn.start")).length - turnsBefore, chat: (yield* dump).B.map((m) => m.author + ": " + m.text.slice(0, 70)), posted: events().filter(ev("request.posted", (e) => e.name === "FROM_CHAT")).length })
  }),

  // Item 17: the owner pastes a password that is not stored yet, and the agent saves it.
  paste: Effect.gen(function*() {
    const { ask, dump } = yield* setup
    yield* ask("A", "my password for the fake site is " + FAKE.pasted + " " + plan([
      [sh("printf %s '" + FAKE.pasted + "' | chad secret set PASTED --note 'fake site, pasted in chat'")],
      [sh("chad secret run --env P=PASTED -- printenv P")],
      ["console.log('You pasted a password into the chat. I saved it as PASTED. Change it on the site, since it is in the chat history now.')"]
    ]))
    yield* ask("A", "the next turn " + plan([["console.log('next')"]]))
    yield* dump
  }),

  // The real 5 minutes, inside clanka's bash with timeoutMs 330000, and what run() does with the same command.
  wait5: Effect.gen(function*() {
    const { post, ended, dump } = yield* setup
    const { hasButton } = yield* ui
    const kA = yield* post("A", "stored " + plan([[sh("chad secret request SLOW_STORED -m 'nobody will answer'", { timeoutMs: 330000 })], ["console.log('AFTER-A')"]]))
    const kB = yield* post("B", "code " + plan([[sh("chad secret request --code -m 'nobody will answer'", { timeoutMs: 330000 })], ["console.log('AFTER-B')"]]))
    const kC = yield* post("C", "run " + plan([["try { console.log('RUN ' + await run(\"chad secret request RUN_FORM -m 'through run'\")) } catch (e) { console.log('RUNERR ' + e.message) }"], ["console.log('AFTER-C')"]]))
    yield* Effect.all([ended(kA, 420_000), ended(kB, 420_000), ended(kC, 420_000)], { concurrency: 3 })
    const chat = yield* dump
    const posts = events().filter(ev("request.posted"))
    log("wait5.after", { messages: yield* Effect.all(posts.map((p) => Effect.map(hasButton(p.messageId), (button) => ({ name: p.name ?? "--code", button, text: [...chat.A, ...chat.B, ...chat.C].find((m) => m.id === p.messageId)?.text?.slice(0, 50) })))) })
  }),

  // agent-browser from the volume, a Chromium sidecar over CDP, a password and a TOTP. Runs in a container.
  signin: Effect.gen(function*() {
    const { ask, seed, dump } = yield* setup
    yield* seed
    const ab = "agent-browser --cdp 9222 "
    const vault = join(DATA, "home", ".agent-browser")
    // 1. The recipe as TIM-546 wrote it.
    yield* ask("A", "sign in " + plan([
      [sh("chad secret run --stdin SITE_PASSWORD -- agent-browser auth save testsite --url " + SITE + "/login --username " + FAKE.user + " --password-stdin")],
      [sh(ab + "auth login testsite 2>&1 | grep -v 'CVE' ; " + ab + "wait '#code' && " + ab + "get url")],
      [sh(ab + "fill '#code' \"$(chad secret code SITE_TOTP)\" && " + ab + "click '#verify' && " + ab + "wait '#who' && " + ab + "get text '#who'")],
      // What a click returns before the page has moved.
      [sh(ab + "open " + SITE + "/logout >/dev/null; " + ab + "auth login testsite >/dev/null 2>&1; " + ab + "get url")],
      // The agent goes looking.
      [sh("agent-browser auth show testsite; echo ---; cat ~/.agent-browser/auth/testsite.json | head -c 120; echo; ls -la ~/.agent-browser | grep -c encryption-key")]
    ]), 120_000)
    log("vault", vaultCopy(vault))
    // 2. The password changes on the site and in chad. The vault still has the old one.
    yield* Effect.promise(() => fetch(SITE + "/admin/password", { method: "POST", body: new URLSearchParams({ password: FAKE.password2 }) }))
    yield* cli("set SITE_PASSWORD (changed)", ["secret", "set", "SITE_PASSWORD"], { stdin: FAKE.password2 })
    yield* ask("A", "sign in again " + plan([
      [sh(ab + "open " + SITE + "/logout >/dev/null; " + ab + "auth login testsite 2>&1 | grep -v CVE; " + ab + "wait '#error' && " + ab + "get text '#error'")],
      [sh("chad secret run --stdin SITE_PASSWORD -- agent-browser auth save testsite --url " + SITE + "/login --username " + FAKE.user + " --password-stdin")],
      [sh(ab + "auth login testsite 2>&1 | grep -v CVE; " + ab + "wait '#code' && " + ab + "get url")],
      // A second code in the same window, as a retry would send. The first sign-in used this window's code if it was under 30 seconds ago.
      [sh("chad secret code SITE_TOTP 2>&1")],
      // A second code in the same window, made sure of and not hoped for. The first try is refused if the sign-in above used this window's code.
      // If it was accepted instead (the window turned over in between), sign out, log in again and send the same window's code once more.
      [sh("left=$(chad secret code SITE_TOTP 2>&1 >/dev/null | grep -o '^[0-9]*'); [ \"$left\" -lt 12 ] && sleep $((left + 1)); try() { " + ab + "fill '#code' \"$(chad secret code SITE_TOTP 2>/dev/null)\" && " + ab + "click '#verify' && " + ab + "wait 700; }; try >/dev/null; if " + ab + "get url | grep -q /account; then " + ab + "open " + SITE + "/logout >/dev/null; " + ab + "auth login testsite >/dev/null 2>&1; " + ab + "wait '#code' >/dev/null; try >/dev/null; fi; " + ab + "get url; " + ab + "get text '#error'", { timeoutMs: 60000 })],
      // The recipe for a retry: read the seconds left, sleep past the window, ask again.
      [sh("left=$(chad secret code SITE_TOTP 2>&1 >/dev/null | grep -o '^[0-9]*'); sleep $((left + 1)); " + ab + "fill '#code' \"$(chad secret code SITE_TOTP)\" && " + ab + "click '#verify' && " + ab + "wait '#who' && " + ab + "get text '#who'", { timeoutMs: 60000 })]
    ]), 120_000)
    log("vault", vaultCopy(vault))
    yield* cli("close", ["secret", "run", "--", "agent-browser", "close"], { env: { HOME: join(DATA, "home") } })
    yield* dump
  }),

  // Playwright MCP through clanka's MCP layer, the dotenv step three ways, and a secret change during a login. Runs in a container.
  pwmcp: Effect.gen(function*() {
    const { post, ended, seed, dump } = yield* setup
    // The servers were started before the secrets existed, as on a first boot. Saving them restarts the servers.
    yield* seed
    yield* cli("set HASHY", ["secret", "set", "HASHY"], { stdin: FAKE.hashy })
    log("expect", Object.fromEntries(["password", "password2", "quoted", "hashy"].map((k) => [k, fingerprint((FAKE as any)[k])])))
    const pw = (server: string, tool: string, args: object) => "await mcp." + server + "." + tool + "(" + JSON.stringify(args) + ")"
    const pwv = (server: string, tool: string, args: object) => "(" + pw(server, tool, args) + ")"
    const probe = "() => { const v = document.querySelector('#password').value; return 'FP ' + v.length + ':' + [...v].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000000007, 7) }"
    /** Type the secret called name into the password field through one server and say what arrived, by fingerprint. */
    const typed = (server: string, name: string) => [
      pw(server, "browser_navigate", { url: SITE + "/login" }),
      pw(server, "browser_type", { element: "Password", target: "#password", text: name }),
      "console.log(" + JSON.stringify("ARRIVED " + server + " " + name + " ") + " + String(" + pwv(server, "browser_evaluate", { function: probe }) + ").split('\\n').find((l) => l.includes('FP')))"
    ].join("\n")
    const key = yield* post("A", "sign in through MCP " + plan([
      [
        "console.log('TOOLS ' + Object.keys(mcp.playwright).length)",
        pw("playwright", "browser_navigate", { url: SITE + "/logout" }),
        pw("playwright", "browser_type", { element: "Username", target: "#username", text: FAKE.user }),
        "console.log('TYPE ' + " + pwv("playwright", "browser_type", { element: "Password", target: "#password", text: "SITE_PASSWORD" }) + ")",
        "console.log('ASK ' + " + pwv("playwright", "browser_evaluate", { function: "() => document.querySelector('#password').value" }) + ")",
        "console.log('B64 ' + " + pwv("playwright", "browser_evaluate", { function: "() => btoa(document.querySelector('#password').value)" }) + ")",
        pw("playwright", "browser_click", { element: "Sign in", target: "#submit" }),
        "console.log('AT ' + String(" + pwv("playwright", "browser_evaluate", { function: "() => location.pathname" }) + ").split('\\n')[1])"
      ],
      // A call that is in flight when the secret changes.
      [mark("at-totp"), "const t = Date.now(); try { const r = " + pwv("playwright", "browser_wait_for", { time: 8 }) + "; console.log('WAIT ok after ' + (Date.now() - t) + 'ms ' + String(r).slice(0, 80)) } catch (e) { console.log('WAIT failed after ' + (Date.now() - t) + 'ms: ' + String(e && e.message ? e.message : e).slice(0, 300)) }"],
      [
        hold("restarted"),
        "const tabs = String(" + pwv("playwright", "browser_tabs", { action: "list" }) + "); console.log('TABS ' + tabs.slice(0, 400))",
        "console.log('STILL ' + String(" + pwv("playwright", "browser_evaluate", { function: "() => location.href" }) + ").split('\\n')[1])"
      ],
      [
        "const code = /\\b\\d{6}\\b/.exec((await bash({ command: 'chad secret code SITE_TOTP' })).output)[0]",
        pw("playwright", "browser_navigate", { url: SITE + "/totp" }),
        "await mcp.playwright.browser_type({ element: 'Code', target: '#code', text: code })",
        pw("playwright", "browser_click", { element: "Verify", target: "#verify" }),
        "console.log('WHO ' + String(" + pwv("playwright", "browser_evaluate", { function: "() => document.body.innerText" }) + ").split('\\n')[1])"
      ],
      // Which value each server holds after the restart, and what each dotenv spelling does to awkward values.
      [typed("playwright", "SITE_PASSWORD")], [typed("playwright", "QUOTED")], [typed("playwright", "HASHY")],
      [typed("pwplain", "SITE_PASSWORD")], [typed("pwplain", "QUOTED")], [typed("pwplain", "HASHY")],
      [typed("pwshm", "SITE_PASSWORD")], [typed("pwshm", "QUOTED")], [typed("pwshm", "HASHY")],
      [typed("pwfd", "SITE_PASSWORD")], [typed("pwfd", "QUOTED")], [typed("pwfd", "HASHY")],
      // What is left behind, and what the agent can read. Counts only.
      [sh("echo \"SHM $(ls /dev/shm | tr '\\n' ' ')\"; for f in /dev/shm/*; do [ -f \"$f\" ] && echo \"SHMFILE $(stat -c %a \"$f\") $(grep -c SITE_PASSWORD= \"$f\")\"; done; for p in $(grep -l playwright-mcp /proc/[0-9]*/cmdline 2>/dev/null | cut -d/ -f3); do [ -r /proc/$p/environ ] && echo \"ENVIRON $(tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -c '^SITE_PASSWORD=')\"; done | sort | uniq -c; grep -rl \"$(chad secret run --env P=SITE_PASSWORD -- printenv P)\" /data --exclude-dir=secrets 2>/dev/null | wc -l")]
    ]))
    yield* marked("at-totp")
    yield* Effect.sleep(1500)
    const before = procs(["playwright-mcp"])
    log("restart.before", { servers: before.length })
    yield* cli("set SITE_PASSWORD (changed)", ["secret", "set", "SITE_PASSWORD"], { stdin: FAKE.password2 })
    yield* Effect.sleep(300)
    log("restart.after", { oldAlive: before.filter(alive).length, servers: procs(["playwright-mcp"]).length })
    yield* release("restarted")
    yield* ended(key, 180_000)
    yield* dump
  })
}

const main = Effect.gen(function*() {
  log("scenario.start", { name, phase })
  yield* scenarios[name]
  log("scenario.end", { name, phase })
})

main.pipe(Effect.provide(HostLive as Layer.Layer<any, any, never>), NodeRuntime.runMain)
