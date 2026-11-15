// PROTOTYPE for "Credential tools run on real clanka and a browser sidecar" (TIM-554). Throwaway.
// The driver: node run.ts [id...]. It starts the sidecar containers, runs each scenario in its own
// process, checks the event log each one leaves, writes out/results.txt and removes what it started.
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { FAKE } from "./fake.ts"

const HERE = import.meta.dirname
const OUT = join(HERE, "out")
const PLAYWRIGHT_IMAGE = "mcr.microsoft.com/playwright:v1.61.1-jammy"
const NODE_IMAGE = "node:26-trixie-slim"
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const sh = (cmd: string, args: Array<string>, timeout = 120_000) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) }
  } catch (e: any) {
    return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") }
  }
}
const podman = (...args: Array<string>) => sh("podman", args)

// --- results ------------------------------------------------------------------

const results: Array<string> = []
type Check = (text: string, ok: unknown, evidence?: unknown, found?: boolean) => void
const checker = (id: string): Check => (text, ok, evidence, found) => {
  const ev = evidence === undefined ? "" : "  | " + (typeof evidence === "string" ? evidence : JSON.stringify(evidence))
  const line = (ok === true ? "PASS" : "FAIL") + "  [" + id + "]  " + (found ? "FOUND: " : "") + text + ev.replace(/\n/g, "\\n").slice(0, 700)
  results.push(line)
  console.log(line)
}

// --- what a run leaves, and where a value is looked for ---------------------------

interface Ctx {
  readonly id: string
  readonly dir: string
  readonly E: Array<any>
  readonly exits: Array<number | null>
  readonly ms: number
  /** Script outputs in order, with clanka's "Calling" line kept. */
  readonly out: Array<string>
  readonly cli: (label: string) => any
  readonly of: (ev: string, pred?: (e: any) => boolean) => Array<any>
}
const dbTables = (file: string): Record<string, Array<string>> => {
  if (!existsSync(file)) return {}
  const db = new DatabaseSync(file, { readOnly: true })
  const out: Record<string, Array<string>> = {}
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>) {
    const all = db.prepare('SELECT * FROM "' + name + '"')
    all.setReadBigInts(true)
    out[name] = (all.all() as Array<Record<string, unknown>>).map((row) =>
      Object.values(row).map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : String(v))).join("\u0001")
    )
  }
  db.close()
  return out
}
const walk = (dir: string, skip: Array<string> = []): Array<string> => {
  if (!existsSync(dir)) return []
  const out: Array<string> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, skip))
    else if (entry.isFile()) out.push(path)
  }
  return out
}
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")
/** A place that holds JSON is searched as the strings in it, so a value is found at the spelling chad wrote and not one level deeper. */
const decoded = (text: string): string => {
  const out: Array<string> = []
  const go = (v: unknown) => {
    if (typeof v === "string") out.push(v)
    else if (v !== null && typeof v === "object") for (const x of Object.values(v)) go(x)
  }
  for (const field of text.split(/[\n\u0001]/)) {
    try {
      const parsed = JSON.parse(field)
      typeof parsed === "object" && parsed !== null ? go(parsed) : out.push(field)
    } catch {
      out.push(field)
    }
  }
  return out.join("\n")
}
/** Each place TIM-554 names, as one string. */
const places = (ctx: Ctx): Record<string, string> => {
  const data = join(ctx.dir, "data")
  const chat = existsSync(join(data, "chat.json")) ? JSON.parse(readFileSync(join(data, "chat.json"), "utf8")) : { calls: [] }
  const tables = dbTables(join(data, "chad.sqlite"))
  return {
    "log": decoded(read(join(ctx.dir, "log.jsonl"))),
    "history rows": decoded((tables.session_messages ?? []).join("\n")),
    "turns table": decoded((tables.turns ?? []).join("\n")),
    "rest of the database": decoded(Object.entries(tables).filter(([t]) => t !== "session_messages" && t !== "turns").map(([, rows]) => rows.join("\n")).join("\n")),
    "home/": walk(join(data, "home"), [".local", ".npm"]).map((f) => readFileSync(f, "latin1")).join("\n"),
    "chat posts and edits": (chat.calls as Array<any>).map((c) => c.markdown ?? "").join("\n"),
    "afterTurn hooks": decoded(read(join(data, "hooks.jsonl"))),
    "stdout": read(join(ctx.dir, "stdout"))
  }
}
/** For each place, the spellings found in it. */
const leaks = (ctx: Ctx, values: Record<string, string>) => {
  const out: Record<string, Array<string>> = {}
  for (const [place, text] of Object.entries(places(ctx))) {
    const found = Object.entries(values).filter(([, v]) => text.includes(v)).map(([n]) => n)
    if (found.length > 0) out[place] = found
  }
  return out
}
const clean = (output: string) => output.replace(/^\[\d\d:[^\n]*\n/gm, "").trim()

// --- containers ------------------------------------------------------------------

const CHROME = "/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const CDP_PROBE = "fetch('http://127.0.0.1:9222/json/version').then(r=>r.json()).then(j=>console.log(j.Browser))"
const browserUp = async () => {
  podman("rm", "-f", "-t", "1", "chad-cred-chromium")
  if (!podman("network", "exists", "chad-cred-net").ok) podman("network", "create", "chad-cred-net")
  const started = podman("run", "-d", "--name", "chad-cred-chromium", "--network", "chad-cred-net", PLAYWRIGHT_IMAGE, CHROME, "--no-sandbox", "--remote-debugging-address=0.0.0.0", "--remote-debugging-port=9222", "--user-data-dir=/tmp/profile", "about:blank")
  if (!started.ok) throw new Error("chromium: " + started.out)
  for (let i = 0; i < 50; i++) {
    if (podman("exec", "chad-cred-chromium", "node", "-e", CDP_PROBE).ok) return
    await sleep(200)
  }
  throw new Error("chromium did not answer on 9222")
}
const siteUp = async (id: string) => {
  podman("rm", "-f", "-t", "1", "chad-cred-site")
  mkdirSync(join(OUT, id), { recursive: true })
  const started = podman("run", "-d", "--name", "chad-cred-site", "--network", "chad-cred-net", "--userns=keep-id", "-v", HERE + ":" + HERE, "-e", "SITE_LOG=" + join(OUT, id, "site.jsonl"), "-w", HERE, NODE_IMAGE, "node", "--disable-warning=ExperimentalWarning", "site/server.ts")
  if (!started.ok) throw new Error("site: " + started.out)
  for (let i = 0; i < 50 && !existsSync(join(OUT, id, "site.jsonl")); i++) await sleep(200)
}
const has = (path: string) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
const toolsUp = () => {
  const bin = join(HERE, "vol/home/.local/bin")
  if (has(join(bin, "playwright-mcp")) && has(join(bin, "agent-browser"))) return
  mkdirSync(join(HERE, "vol/home"), { recursive: true })
  // As the agent would: no sudo, no apt, npm with a prefix on the data volume.
  const r = sh("podman", ["run", "--rm", "--name", "chad-cred-install", "--userns=keep-id", "-e", "HOME=/data/home", "-e", "NPM_CONFIG_PREFIX=/data/home/.local", "-v", join(HERE, "vol") + ":/data", NODE_IMAGE, "npm", "install", "-g", "agent-browser@0.43.0", "@playwright/mcp@0.0.85"], 600_000)
  if (!r.ok) throw new Error("install: " + r.out.slice(-400))
}
const containersDown = () => {
  const names = podman("ps", "-a", "--format", "{{.Names}}").out.split("\n").filter((n) => n.startsWith("chad-cred-"))
  for (const name of names) podman("rm", "-f", "-t", "1", name)
  podman("network", "rm", "chad-cred-net")
  return names
}

// --- running one spec ---------------------------------------------------------------

interface Spec {
  readonly id: string
  readonly scenario: string
  readonly claim: string
  readonly env?: Record<string, string>
  readonly phases?: Array<string>
  readonly container?: boolean
  readonly timeout?: number
  readonly check: (ctx: Ctx, c: Check) => void | Promise<void>
}
const runSpec = async (spec: Spec) => {
  const dir = join(OUT, spec.id)
  rmSync(dir, { recursive: true, force: true })
  rmSync(join(OUT, spec.id + ".jsonl"), { force: true })
  mkdirSync(join(dir, "data"), { recursive: true })
  results.push("## " + spec.id + ": " + spec.claim)
  const c = checker(spec.id)
  const exits: Array<number | null> = []
  const started = Date.now()
  if (spec.container) {
    await browserUp()
    await siteUp(spec.id)
  }
  for (const phase of spec.phases ?? ["1"]) {
    const env = spec.container
      ? { ...process.env, CHAD_CRED_ENV: Object.entries(spec.env ?? {}).map(([k, v]) => "-e " + k + "=" + v).join(" ") }
      : { ...process.env, ...spec.env, CHAD_DATA: join(dir, "data"), PROTO_LOG: join(dir, "log.jsonl"), PATH: join(HERE, "bin") + ":" + process.env.PATH }
    const child = spec.container
      ? spawn(join(HERE, "in-container.sh"), [spec.id, spec.scenario, phase], { env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(HERE, "scenarios.ts"), spec.scenario, phase], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stdout += d))
    const timer = setTimeout(() => (spec.container ? podman("rm", "-f", "-t", "1", "chad-cred-chad-" + spec.id) : child.kill("SIGKILL")), spec.timeout ?? 150_000)
    exits.push(await new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))))
    clearTimeout(timer)
    writeFileSync(join(dir, "stdout"), stdout, { flag: "a" })
  }
  const E = read(join(dir, "log.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l))
  const of = (ev: string, pred?: (e: any) => boolean) => E.filter((e) => e.ev === ev && (pred === undefined || pred(e)))
  const ctx: Ctx = { id: spec.id, dir, E, exits, ms: Date.now() - started, out: of("brain.scriptOutput").map((e) => e.output), cli: (label) => of("cli", (e) => e.label === label)[0] ?? {}, of }
  c("the scenario ran to its end", exits.every((x) => x === 0) && of("scenario.end").length === exits.length, { exits, ms: ctx.ms, events: E.length })
  try {
    await spec.check(ctx, c)
  } catch (e) {
    c("the checks ran", false, String((e as any)?.stack ?? e).slice(0, 300))
  }
  if (existsSync(join(dir, "log.jsonl"))) copyFileSync(join(dir, "log.jsonl"), join(OUT, spec.id + ".jsonl"))
}

// --- the specs -------------------------------------------------------------------------

const PW = sha(FAKE.password)
const Q1 = JSON.stringify(FAKE.quoted).slice(1, -1)
const Q2 = JSON.stringify(Q1).slice(1, -1)
const STORED = { SITE_PASSWORD: FAKE.password, QUOTED: FAKE.quoted, "QUOTED as JSON writes it": Q1, SITE_TOTP: FAKE.totp, "SITE_TOTP as typed": FAKE.totpTyped }
const big = (names: Array<string>) => names.filter((n) => n !== "TINY")
const sees = (ctx: Ctx, from?: string, to?: string) => {
  const marks = ctx.of("turn.marker")
  const a = from ? marks.find((m) => m.turn === from)?.t ?? 0 : 0
  const b = to ? marks.find((m) => m.turn === to)?.t ?? Infinity : Infinity
  const calls = ctx.of("model.call", (e) => e.t >= a && e.t < b)
  return { calls: calls.length, sawPassword: calls.filter((e) => e.sees.includes("SITE_PASSWORD")).length, sawQuoted: calls.filter((e) => e.sees.includes("QUOTED")).length, sawSeed: calls.filter((e) => e.sees.includes("SITE_TOTP")).length, sawMask: calls.filter((e) => e.seesMasked.length > 0).length }
}
const ECHO_MCP = JSON.stringify({ mcpServers: { echo: { command: "node", args: [join(HERE, "site/mcp-echo.mjs")], env: { KEY: "$" + "{API_KEY}" } } } })

const runChecks = (nomask: boolean) => (ctx: Ctx, c: Check) => {
  const o = ctx.out.map(clean)
  const raw = ctx.out.join("\n")
  c("--env: the child sees the value, and CHAD_SESSION from the spawner chad wraps", o[0]?.includes("ENV len=21 sha=" + PW + " session=s-c1"), o[0]?.slice(0, 120))
  c("the Calling \"bash\" lines show names only", ctx.out.length === 13 && ctx.out.every((x) => x.includes("Calling \"bash\"")) && !raw.includes(FAKE.password) && raw.includes("P=SITE_PASSWORD"), ctx.out[0]?.split("\n")[0].slice(15, 150))
  c("--stdin: the value, no trailing newline, stdin closed", o[1]?.includes("STDIN sha=" + PW + " eof=yes") && /\] 21$/.test(o[2] ?? ""), [o[1]?.slice(15, 60), "wc -c: " + o[2]?.slice(-2)])
  c("a missing name exits 125 with the message", o[3] === "ERR Command failed with exit code 125: chad secret run: no secret named NO_SUCH_NAME", o[3])
  c("the child's exit code passes through: 7, 143 for SIGTERM, 127 for no such command", o[4]?.includes("exit code 7") && o[5]?.includes("exit code 143") && o[6]?.includes("exit code 127"), [o[4], o[5], o[6]])
  c("item 23, the quoting trap: \"$P\" in the outer shell is empty, inside sh -c it is the value", o[7]?.endsWith("TRAP outer=[]") && o[8]?.endsWith("TRAP inner len=21"), [o[7], o[8]])
  c("run gives a TOTP secret's current code, not its seed", /TOTP via run: \d{6}$/.test(o[9] ?? ""), o[9]?.replace(/\d{6}$/, "<6 digits>"))
  c("two secrets in one command", o[10]?.endsWith("TWO 21 21"), o[10])
  c("chad secret code prints the code and the seconds left", /\b\d{6}\b/.test(o[11] ?? "") && /\d+s left/.test(o[11] ?? ""), o[11]?.replace(/\d{6}/, "<6 digits>"))
  c("chad secret list prints name, kind, note and date, and no value", o[12]?.includes("SITE_PASSWORD\tplain\tlocal test form, user tim\t") && o[12]?.includes("SITE_TOTP\ttotp\t") && !o[12]?.includes("FAKE"), o[12]?.split("\n")[0])
  const calls = ctx.of("model.call")
  c("no model call's prompt held a stored value of 8 characters or more", calls.every((e) => big(e.sees).length === 0), { calls: calls.length, masking: nomask ? "off" : "on" })
  const found = leaks(ctx, STORED)
  c(nomask ? "with masking switched off the value is still in none of chad's outputs: run keeps it off the path by itself" : "the value is in none of chad's outputs", Object.keys(found).length === 0, found)
  const tiny = ctx.cli("set TINY")
  c("item 5: set warns that a value under 8 characters will not be masked", tiny.code === 0 && tiny.stderr === "warning: TINY is under 8 characters, so it will not be masked\n", tiny.stderr?.trim())
  c("every command went through the wrapped spawner", ctx.of("spawner.spawn").length === 13, { spawns: ctx.of("spawner.spawn").length })
}

const maskChecks = (wrap: boolean) => (ctx: Ctx, c: Check) => {
  const found = leaks(ctx, STORED)
  for (const place of ["history rows", "turns table", "log", "chat posts and edits", "afterTurn hooks", "home/", "rest of the database"]) {
    c("item 18: no stored value in " + place, (found[place] ?? []).length === 0, found[place] ?? "none")
  }
  const where = Object.entries(places(ctx)).filter(([p, text]) => p !== "stdout" && text.includes(Q2)).map(([p]) => p)
  if (!wrap) c("a value with a quote and a backslash in it gets through when it is JSON-escaped twice, as an answer that quotes a tool result is", where.length > 0, { spelling: Q2, foundIn: where }, true)
  else c("with the wrap that spelling never forms, because the tool result the answer quotes was masked first", where.length === 0, { foundIn: where })
  const partial = FAKE.password.slice(0, 8)
  const half = Object.entries(places(ctx)).filter(([p, text]) => p !== "stdout" && text.includes(partial)).map(([p]) => p)
  c("the status message is masked before it is cut to 300 characters, so no first half of a value is left", half.length === 0, { lookedFor: partial, foundIn: half })
  const failed = dbTables(join(ctx.dir, "data", "chad.sqlite")).turns?.find((r) => r.includes("Failed")) ?? ""
  c("Failed.reason in the turns table is masked", failed.includes("OUT[completed] <secret:SITE_PASSWORD>") && !failed.includes(FAKE.password), failed.slice(failed.indexOf("OUT[completed]"), failed.indexOf("OUT[completed]") + 40))
  const hooks = read(join(ctx.dir, "data", "hooks.jsonl"))
  c("afterTurn received masked messages and a masked outcome", hooks.includes("<secret:SITE_PASSWORD>") && hooks.split("\n").filter(Boolean).length === 5, { hookCalls: hooks.split("\n").filter(Boolean).length, masks: hooks.split("<secret:").length - 1 })
  const o = ctx.out.map(clean)
  c("a TOTP seed is masked", ctx.out.some((x) => x.includes("<secret:SITE_TOTP>")) && !ctx.out.join("").includes(FAKE.totp), o[2]?.slice(o[2].indexOf("\"SITE_TOTP\""), o[2].indexOf("\"SITE_TOTP\"") + 55))
  c("item 2: a value the script encodes passes the mask (base64)", o[3]?.includes(Buffer.from(FAKE.password).toString("base64")), o[3]?.slice(-40), true)
  const tmp = ctx.of("tmpfile")[0]
  c("an output over 30,000 characters is saved by clanka to a file chad does not write: the value is in it unmasked, mode 644, outside the data volume", tmp?.exists === true && tmp.holds.includes("SITE_PASSWORD"), tmp && { path: tmp.path.replace(/.*\/clanka-bash/, "<TMPDIR>/clanka-bash"), holds: tmp.holds, mode: tmp.mode }, true)
  const turnsSeen = { outputs: sees(ctx, "outputs", "sources"), sources: sees(ctx, "sources", "fails"), fails: sees(ctx, "fails", "owner"), owner: sees(ctx, "owner", "end") }
  if (!wrap) {
    c("the floor alone: a value a script printed is in the model's context for the rest of the turn and every later turn", turnsSeen.outputs.sawPassword >= 8 && turnsSeen.owner.sawPassword > 0, turnsSeen)
  } else {
    c("the wrap: no model call in the turn whose scripts printed the values saw one, sub-agent and background task included", turnsSeen.outputs.sawPassword === 0 && turnsSeen.outputs.sawQuoted === 0 && turnsSeen.outputs.sawSeed === 0 && turnsSeen.outputs.sawMask > 0, turnsSeen.outputs)
    c("the wrap does not cover a value the model writes into a script itself: it stays in the live context until the session is rebuilt", turnsSeen.sources.sawPassword > 0 && turnsSeen.owner.sawPassword > 0, { sources: turnsSeen.sources, owner: turnsSeen.owner }, true)
  }
  const sub = o.find((x) => x.startsWith("SUB "))
  const bg = o.find((x) => x.startsWith("BG "))
  c("a sub-agent's answer and a background task's output come back masked", sub?.includes("<secret:SITE_PASSWORD>") && bg?.includes("<secret:SITE_PASSWORD>"), [sub?.slice(-60), bg?.slice(-70)])
  const second = ctx.of("scenario.start", (e) => e.phase === "2")[0]
  const after = ctx.of("model.call", (e) => e.t > (second?.t ?? Infinity))
  c("after a restart the session reloads its history from the masked rows: the model sees <secret:NAME> and no value", after.length > 0 && after.every((e) => big(e.sees).length === 0 && e.seesMasked.includes("<secret:SITE_PASSWORD>")), { calls: after.length, restored: ctx.of("session.restored")[0]?.messages, sees: after[0]?.sees, masked: after[0]?.seesMasked })
  const ends = ctx.of("turn.end")
  c("the first turn's wall time, for comparing the two", true, { firstTurnMs: ends[0] && ends[0].t - ctx.of("turn.start")[0].t, wrap })
}

function buttonChecks(ctx: Ctx, c: Check, awaits: boolean) {
  const clicks = ctx.of("interact.click")
  const submits = ctx.of("interact.submit")
  const asked = ctx.of("asked.message")[0]
  const heldAt = ctx.of("test.queueHeld")[0]?.t ?? Infinity
  const heldSubmit = submits.find((s) => s.t > heldAt)
  const held = ctx.of("after.heldSubmit")[0], late = ctx.of("after.heldWait")[0]
  if (awaits) {
    c("if the submit waits for the daemon's queue before it answers, a 5 second hold leaves the modal unanswered at 3 seconds: ChatTest reports the reply as Late", heldSubmit?.reply === "Late" && heldSubmit.ms >= 3000, { reply: heldSubmit?.reply, ms: heldSubmit?.ms }, true)
    c("what became of the value typed into that modal: " + (late?.stored ? "it was saved once the queue freed" : "it was dropped, and the owner has to type it again"), late !== undefined, { stored: late?.stored, message: late?.text?.slice(0, 40) }, true)
    return
  }
  c("item 10: the message reads as the agent asking, names the session and quotes -m", asked?.text === "The agent in session s-c1 asks for a secret named API_KEY (fake API, user tim).\nIt says: \"I need the key for the fake API you named\"\nPress Enter to type it." && asked.button, asked?.text)
  const intruder = ctx.of("after.intruder")[0]
  c("a click from someone who is not an owner is ignored: no modal, nothing stored, the button stays", clicks[0]?.reply === "Ack" && intruder?.stored === false && intruder?.button, { reply: clicks[0]?.reply, stored: intruder?.stored, button: intruder?.button })
  c("the owner's click opens a modal with one text field, well inside 3 seconds", clicks[1]?.reply === "OpenModal" && clicks[1].modal.fields === 1 && clicks[1].ms < 100, { ms: clicks[1]?.ms, modal: clicks[1]?.modal })
  c("a submit from someone who is not an owner, on the modal the owner opened, stores nothing", submits[0]?.reply === "Close" && ctx.of("after.intruderSubmit")[0]?.stored === false, { reply: submits[0]?.reply, stored: ctx.of("after.intruderSubmit")[0]?.stored }, true)
  const before = clean(ctx.out[0] ?? ""), after = clean(ctx.out[2] ?? "")
  const restart = ctx.of("mcp.restarted")[0]
  c("item 9: the submit takes the path chad secret set takes, so the MCP server that names the secret restarts with it", before.includes("keyLength=0") && after.includes("keyLength=22 keySha=" + ctx.of("expect")[0]?.keySha) && ctx.of("mcp.restarted").length === 1, { before: before.slice(7), after: after.slice(6), restart: restart && { closeMs: restart.closeMs, buildMs: restart.buildMs } })
  const done = ctx.of("after.submit")[0]
  c("the message is edited to \"Saved API_KEY\" and the button is gone; request printed the same and exited 0", done?.text === "Saved API_KEY" && done.button === false && done.valueOk && clean(ctx.out[1] ?? "") === "OUT[completed] Saved API_KEY", { text: done?.text, button: done?.button, request: clean(ctx.out[1] ?? "") })
  const bad = submits.find((s) => s.reply === "Errors")
  c("a TOTP seed that does not decode is refused inside the modal, and the button stays", bad?.errors?.value === "the seed is not base32" && ctx.of("after.badSeed")[0]?.button && !ctx.of("after.badSeed")[0]?.stored, { reply: bad?.reply, errors: bad?.errors })
  c("--totp through the button stores a TOTP secret that chad secret code reads", ctx.of("after.otp")[0]?.kind === "totp" && /^\d{6}\n$/.test(ctx.cli("code OTP_ONE").stdout ?? ""), { kind: ctx.of("after.otp")[0]?.kind, message: ctx.of("after.otp")[0]?.text })
  const refused = ctx.cli("totp/mcp-name")
  c("item 8: set NAME --totp is refused while the live mcp.json names NAME, and the secret is left as it was", refused.code === 1 && refused.stderr?.includes("mcp.json names API_KEY, so it cannot become a TOTP secret") && ctx.of("after.totpRefused")[0]?.kind === "plain" && ctx.of("mcp.restarted").length === 1, { exit: refused.code, stderr: refused.stderr?.trim(), kindAfter: ctx.of("after.totpRefused")[0]?.kind })
  c("with the daemon's queue held for 5 seconds the modal is answered at once and the save lands when the queue frees. Item 9 does not say the reply cannot wait for the queue", heldSubmit?.reply === "Close" && heldSubmit.ms < 100 && held?.storedAtReply === false && late?.stored && late.text === "Saved HELD_ONE", { replyMs: heldSubmit?.ms, storedAtReply: held?.storedAtReply, storedLater: late?.stored, message: late?.text }, true)
  const lens = ctx.of("len")
  const posts = lens.filter((l) => l.posted).map((l) => l.n), opens = lens.filter((l) => l.modal === "OpenModal").map((l) => l.n)
const sizes = Object.fromEntries(lens.filter((l) => l.modalIdPlusMetadata).map((l) => [l.n, l.modalIdPlusMetadata]))
  c("the button id carries the name, so a name has a cap TIM-546 did not set: with this encoding the button posts up to 75 characters and fails at 76", Math.max(...posts) === 75, { buttonPosts: posts, at76: lens.find((l) => l.n === 76)?.stderr?.trim() }, true)
  c("the modal's id plus metadata passes 100 characters at a 70 character name. ChatTest declares that limit and does not apply it to a modal reply, so this is a count, not a refusal that was seen", sizes[69] === 100 && sizes[70] === 101 && opens.includes(70), { modalIdPlusMetadataByNameLength: sizes, limit: 100 }, true)
  const found = leaks(ctx, { API_KEY: FAKE.apiKey, HELD_ONE: "FAKE-held-value-0006", OTP_ONE: FAKE.totp, "OTP_ONE as typed": FAKE.totpTyped, intruder: "intruder-typed-this-0000" })
  c("item 21: a typed value is in no log line, chat post, history row or hook", Object.keys(found).length === 0, found)
}

function waitChecks(ctx: Ctx, c: Check) {
  const outs = ctx.of("brain.scriptOutput")
  const start = (thread: string) => ctx.of("request.posted", (e) => e.thread === thread)[0]?.t
  const a = outs.find((e) => clean(e.output).startsWith("ERR") && e.output.includes("SLOW_STORED"))
  const b = outs.find((e) => clean(e.output).startsWith("ERR") && e.output.includes("timed out after 300 s") && !e.output.includes("SLOW_STORED"))
  c("stored form: request waits the 5 minutes inside one bash call and exits 1; clanka cut nothing", a !== undefined && clean(a.output).includes("exit code 1: chad secret request: timed out after 300 s") && Math.abs(a.t - start("c1") - 300_000) < 5000, a && { waitedMs: a.t - start("c1"), output: clean(a.output) })
  c("--code: the same", b !== undefined && Math.abs(b.t - start("c2") - 300_000) < 5000, b && { waitedMs: b.t - start("c2"), output: clean(b.output) })
  c("clanka put no limit on the execute script that wraps the call: the next step ran and nothing was cut. Limits.scriptTimeout exists and defaults to none", outs.some((e) => e.output.includes("AFTER-A")) && outs.some((e) => e.output.includes("AFTER-B")) && !outs.some((e) => e.output.includes("Script timed out")), { scriptTimedOut: outs.some((e) => e.output.includes("Script timed out")) }, true)
  const m = ctx.of("wait5.after")[0]?.messages ?? []
  c("on the timeout a --code message is edited to \"Timed out\" and its button removed; a stored-form button stays", m.find((x: any) => x.name === "--code")?.text === "Timed out" && m.find((x: any) => x.name === "--code")?.button === false && m.find((x: any) => x.name === "SLOW_STORED")?.button === true, m)
  const r = outs.find((e) => /^RUN(ERR)? /.test(clean(e.output)))
  c("item 23: run() gives up on the same command after 120 seconds and moves it to the background, so the script goes on without the answer", r !== undefined && Math.abs(r.t - start("c3") - 120_000) < 5000, r && { returnedAfterMs: r.t - start("c3"), output: clean(r.output).slice(0, 260) })
}

const specs: Array<Spec> = [
  { id: "run", scenario: "run", claim: "chad secret run through clanka's bash and the spawner chad wraps (items 7, 8, 23)", check: runChecks(false) },
  { id: "run-nomask", scenario: "run", claim: "the same with masking switched off, to show which part of the promise is run's own (item 2)", env: { PROTO_NO_MASK: "1" }, check: runChecks(true) },
  {
    id: "code", scenario: "code", claim: "chad secret code: RFC 6238 vectors, the wait under 5 seconds, the refusals (items 4, 5, 8)",
    check: (ctx, c) => {
      const want = Object.fromEntries(ctx.of("expect.vector").map((e) => ["vec/" + e.alg + "/" + e.t, e.want]))
      const vec = ctx.of("cli", (e) => e.label.startsWith("vec/"))
      c("RFC 6238 appendix B: all 18 vectors, SHA-1, SHA-256 and SHA-512, 8 digits, through the CLI", vec.length === 18 && vec.every((e) => e.stdout.trim() === want[e.label]), { ok: vec.filter((e) => e.stdout.trim() === want[e.label]).length, of: vec.length })
      const w = ctx.of("expect.wait")[0]
      const g = (l: string) => ctx.cli(l)
      c("with 6 and 5 seconds left the code is this window's and comes at once", g("nowait/6s-left").stdout?.trim() === w.thisWindow && g("nowait/5s-left").stdout?.trim() === w.thisWindow && g("nowait/5s-left").ms < 1000, [g("nowait/6s-left").stderr?.trim() + " in " + g("nowait/6s-left").ms + "ms", g("nowait/5s-left").stderr?.trim() + " in " + g("nowait/5s-left").ms + "ms"])
      c("with 4 and 1 seconds left it waits and prints the next window's code", g("wait/4s-left").stdout?.trim() === w.nextWindow && g("wait/1s-left").stdout?.trim() === w.nextWindow && g("wait/4s-left").ms > 3500, [g("wait/4s-left").stderr?.trim() + ", " + g("wait/4s-left").ms + "ms wall", g("wait/1s-left").stderr?.trim() + ", " + g("wait/1s-left").ms + "ms wall"])
      c("run waits the same way", g("runwait/3s-left").stdout?.trim() === w.nextWindow && g("runwait/3s-left").ms > 2500, g("runwait/3s-left").ms + "ms wall")
      c("refused for a secret that is not TOTP, exit 1", g("refuse/plain").code === 1 && g("refuse/plain").stderr === "chad secret code: SITE_PASSWORD is not a TOTP secret\n" && g("refuse/plain").stdout === "", g("refuse/plain").stderr?.trim())
      c("a name that does not exist: exit 1", g("refuse/missing").code === 1, g("refuse/missing").stderr?.trim())
      c("item 4: set --totp refuses what does not decode", g("set/bad-seed").code === 1, g("set/bad-seed").stderr?.trim())
      c("item 5: set on an existing name says it replaced it", g("set/replace").stdout === "Replaced SITE_PASSWORD\n", g("set/replace").stdout?.trim())
      c("set on an existing name without --note drops the note the first set gave. Item 5 does not say which it should do", g("list").stdout?.includes("SITE_PASSWORD\tplain\t-\t"), g("list").stdout?.split("\n")[0], true)
      const shape = ctx.of("store.shape")[0]
      c("a seed typed in lower case with spaces is stored canonical, with what was typed kept for masking; secrets.json is mode 600", shape?.typedKept && shape?.canonical && shape?.mode === "600", shape && { typedKept: shape.typedKept, canonical: shape.canonical, mode: shape.mode })
      c("chad secret code costs one node start", g("nowait/6s-left").ms < 1000, g("nowait/6s-left").ms + "ms wall")
    }
  },
  { id: "mask-floor", scenario: "mask", claim: "the masking floor, item 18: chad masks at its own outputs", phases: ["1", "2"], timeout: 200_000, check: maskChecks(false) },
  { id: "mask-wrap", scenario: "mask", claim: "the AgentExecutor wrap, item 19: the same steps with execute's output masked before clanka uses it", env: { PROTO_WRAP: "1" }, phases: ["1", "2"], timeout: 200_000, check: maskChecks(true) },
  {
    id: "paste", scenario: "paste", claim: "items 17 and 20: the owner pastes a password that is not stored yet",
    check: (ctx, c) => {
      const found = leaks(ctx, { PASTED: FAKE.pasted })
      const rows = dbTables(join(ctx.dir, "data", "chad.sqlite"))
      const tables = Object.entries(rows).map(([t, r]) => [t, r.filter((x) => x.includes(FAKE.pasted)).length] as const).filter(([, n]) => n > 0)
      c("the agent saved it with chad secret set, and output after the save is masked", clean(ctx.out[1] ?? "").endsWith("<secret:PASTED>"), clean(ctx.out[1] ?? "").slice(-40))
      c("item 20 costs this: the pasted value stays in clear wherever it was written before the save", tables.length > 0, { places: Object.keys(found), rowsPerTable: Object.fromEntries(tables) }, true)
      const chat = JSON.parse(read(join(ctx.dir, "data", "chat.json")) || "{\"calls\":[]}")
      const echoed = (chat.calls as Array<any>).filter((x) => (x.markdown ?? "").includes(FAKE.pasted))
      c("the script that saves a pasted value carries it, so chad's own status message posts it back into the chat before the save. Item 17 does not say how the agent hands the value to set", echoed.length > 0 && echoed.every((x) => x.op === "edit"), { botEditsHoldingIt: echoed.length, first: echoed[0]?.markdown.slice(0, 110) }, true)
      const next = ctx.of("model.call").slice(-1)[0]
      c("and it is in the model's context in the next turn", next?.sees.includes("PASTED"), { lastCallSees: next?.sees })
    }
  },
  { id: "button", scenario: "button", claim: "the Enter button and the modal on ChatTest (items 9, 10, 16, 21)", env: { PROTO_MCP: ECHO_MCP }, timeout: 200_000, check: (ctx, c) => buttonChecks(ctx, c, false) },
  { id: "button-await", scenario: "button", claim: "the same with the submit waiting for the daemon's queue before it answers (PROTO_SUBMIT_AWAITS_QUEUE=1)", env: { PROTO_SUBMIT_AWAITS_QUEUE: "1", PROTO_MCP: ECHO_MCP }, timeout: 200_000, check: (ctx, c) => buttonChecks(ctx, c, true) },
  {
    id: "code-request", scenario: "code-request", claim: "chad secret request --code (items 11, 21)",
    check: (ctx, c) => {
      const o = ctx.out.map(clean)
      c("the typed code is request's stdout, exit 0, and the script's next step ran", o[0] === "OUT[completed] 482915" && o[1] === "NEXT STEP RAN", o)
      const a = ctx.of("after.code")[0]
      c("nothing is stored: secrets.json is byte for byte what it was", a?.storeUnchanged && !a.storeHoldsCode, { storeUnchanged: a?.storeUnchanged })
      c("the message is edited to \"Code received\" and the button is gone", a?.text === "Code received" && a.button === false, { text: a?.text, button: a?.button })
      c("a click from someone who is not an owner is ignored", ctx.of("interact.click")[0]?.reply === "Ack", ctx.of("interact.click")[0]?.reply)
      c("the code reaches the script without a new turn", ctx.of("turn.start").length === 1 && ctx.of("code.delivered")[0]?.ms < 2000, { turns: ctx.of("turn.start").length, msFromSubmitToScript: ctx.of("code.delivered")[0]?.ms })
      c("the code is not masked: it is in what afterTurn received, in clear", read(join(ctx.dir, "data", "hooks.jsonl")).includes("482915"), "482915")
      c("item 10: the message reads as the agent asking", ctx.of("asked.message")[0]?.text === "The agent in session s-c1 asks for a one-off code.\nIt says: \"the SMS code the fake site just sent\"\nPress Enter to type it.", ctx.of("asked.message")[0]?.text)
    }
  },
  {
    id: "interrupt", scenario: "interrupt", claim: "an owner message ends a pending request, and /stop kills it (item 12)",
    check: (ctx, c) => {
      const o = ctx.out.map(clean)
      const spoke = ctx.of("owner.speaks")
      const errs = ctx.of("brain.scriptOutput").map((e) => ({ t: e.t, x: clean(e.output) })).filter((e) => e.x.includes("owner replied in chat instead"))
      c("stored form: request exits 1 with \"owner replied in chat instead\"", errs[0]?.x === "ERR Command failed with exit code 1: chad secret request: owner replied in chat instead", { output: errs[0]?.x, msAfterTheMessage: errs[0] && errs[0].t - spoke[0].t })
      c("--code: the same, and the message is edited to \"Answered in chat\" with the button gone", errs.length === 2 && ctx.of("after.2")[0]?.text === "Answered in chat" && ctx.of("after.2")[0]?.button === false, { msAfterTheMessage: errs[1] && errs[1].t - spoke[1].t, message: ctx.of("after.2")[0]?.text })
      const tails = ctx.of("model.call", (e) => e.tail.some((x: string) => x.startsWith("user:")))
      c("the message then steers the turn as usual: the model's next call has it after the tool result, and the script went on", ctx.of("message.steered").length === 2 && tails[0]?.tail.join(",") === "assistant:call,tool:result,user:never mind, use the other account" && o.filter((x) => x === "STEP2 RAN").length === 2, { steered: ctx.of("message.steered").length, tail: tails[0]?.tail })
      c("a stored-form button stays after the owner's message", ctx.of("after.1")[0]?.button === true, { button: ctx.of("after.1")[0]?.button })
      const stops = ctx.of("stop.after")
      c("/stop kills the request command: chad as clanka's direct child", stops[0]?.goneMs !== null && stops[0]?.stillAlive.length === 0 && stops[0].pids.length === 1, { goneMs: stops[0]?.goneMs })
      c("/stop kills it with bash as its parent too", stops[1]?.goneMs !== null && stops[1]?.stillAlive.length === 0 && stops[1].pids.length === 1, { goneMs: stops[1]?.goneMs })
      c("the daemon notices the dropped client and edits a --code message to \"Cancelled\", button gone", stops[0]?.text === "Cancelled" && stops[1]?.text === "Cancelled" && stops[0].button === false, { texts: [stops[0]?.text, stops[1]?.text], editMsAfterStop: ctx.of("chat.edited", (e) => e.why === "client-dropped")[0]?.t - ctx.of("stop.received")[0]?.t })
      c("/stop on the stored form kills the command and leaves the button", stops[2]?.goneMs !== null && stops[2]?.button === true && ctx.of("request.clientDropped").length === 1, { goneMs: stops[2]?.goneMs, button: stops[2]?.button })
      c("each of those turns ended Stopped and no later step ran", ctx.of("turn.end", (e) => e.outcome._tag === "Stopped").length === 3 && o.filter((x) => x === "STEP2 RAN").length === 2, { stopped: ctx.of("turn.end", (e) => e.outcome._tag === "Stopped").length })
    }
  },
  {
    id: "repeat", scenario: "repeat", claim: "repeat requests, and a save by any path (item 14)",
    check: (ctx, c) => {
      const o = ctx.out.map(clean)
      const p = ctx.of("repeat.posts")[0]
      c("a repeat request for the same name in the same thread posts no second button", p?.posted === 2 && p.threads.join() === "c1,c2" && /^OUT\[completed\] Already asked for DUP at \d\d:\d\d:\d\d UTC$/.test(o[1] ?? ""), { buttonsPosted: p?.posted, threads: p?.threads, secondRequest: o[1] })
      const s = ctx.of("repeat.saved")[0]
      c("in an owner's turn a repeat waits on the existing button, and returns when the name is saved from a terminal", o.includes("OUT[completed] Saved DUP") && o.includes("STEP2 RAN") && ctx.of("request.repeat").length === 2, { request: "OUT[completed] Saved DUP" })
      c("saving the name by any path edits every remembered button for it, in every thread, to \"Saved NAME\"", s?.texts.join() === "Saved DUP,Saved DUP" && s.buttons.every((b: boolean) => !b) && s.remembered.length === 0, { texts: s?.texts, buttons: s?.buttons })
      const f = ctx.of("forget.posts")[0], g = ctx.of("forget.saved")[0]
      c("a restart loses the memory, which costs one extra button in that thread", f?.posted === 3 && f.threads.join() === "c1,c2,c1", { posted: f?.posted, threads: f?.threads })
      c("the forgotten button still works: the click is handled from its id and the value is stored", g?.stored === true && g.texts[0] === "Saved MEM", { stored: g?.stored })
      c("after a restart a save leaves the forgotten buttons in other threads live. Item 14 counts the cost as one extra ping only", g?.buttons.join() === "false,true,false", { buttonsStillLive: g?.buttons, texts: g?.texts }, true)
    }
  },
  {
    id: "noowner", scenario: "noowner", claim: "no owner present, and /secret in chat (items 13, 14, 15). Not on TIM-554's list",
    check: (ctx, c) => {
      const o = ctx.out.map(clean)
      c("a plugin's turn: the stored form posts the button with a ping and exits 1 without waiting", o[0] === "ERR Command failed with exit code 1: chad secret request: asked for CRON_PW, not waiting: no owner is present in this turn" && ctx.of("request.posted")[0]?.ping === true, { output: o[0], turnMs: ctx.of("plugin.turn")[0]?.ms })
      c("a repeat with no owner exits 1 with \"already asked at <time>\" and posts nothing", /already asked at \d\d:\d\d:\d\d UTC$/.test(o[1] ?? "") && ctx.of("plugin.turn")[0]?.posted === 1, o[1])
      c("--code with no owner is refused and posts nothing", o[2]?.includes("exit code 1") && o[2].includes("Nothing was posted"), o[2])
      c("a command that outlived its turn counts as no owner", ctx.cli("outlived/stored").code === 1 && ctx.cli("outlived/code").code === 1, [ctx.cli("outlived/stored").stderr?.trim(), ctx.cli("outlived/code").stderr?.trim()])
      c("CHAD_SESSION unset or \"daemon\": refused, and points at chad secret set", ctx.cli("nosession").code === 1 && ctx.cli("daemon").stderr === ctx.cli("nosession").stderr && ctx.cli("nosession").stderr.includes("chad secret set TERMINAL_PW"), ctx.cli("nosession").stderr?.trim())
      const s = ctx.of("slash")[0]
      c("item 15: /secret NAME posts the button, /secret alone prints the list, and neither starts a turn", s?.turnsStarted === 0 && s.posted === 1 && s.chat[1] === "bot: Press Enter to save a secret named FROM_CHAT." && s.chat[3].startsWith("bot: SITE_PASSWORD  plain  local test form, user tim"), { turnsStarted: s?.turnsStarted, chat: s?.chat.slice(0, 4) })
    }
  },
  { id: "wait5", scenario: "wait5", claim: "the real 5 minutes inside clanka's bash with timeoutMs 330000 (items 12, 23, and the open question on a script limit)", timeout: 480_000, check: waitChecks },
  {
    id: "script-limit", scenario: "wait5", claim: "what clanka's script limit does if chad sets one: scriptTimeout 2 s against a 6 s wait", env: { PROTO_SCRIPT_TIMEOUT_MS: "2000", PROTO_REQUEST_WAIT_MS: "6000" },
    check: (ctx, c) => {
      const o = ctx.out.map(clean)
      const cut = o.filter((x) => x.includes("Script timed out"))
      c("set to 2 s, Limits.scriptTimeout cuts the script that wraps the wait", cut.length === 3, cut[0]?.slice(0, 220), true)
      c("the cut is one script: the plan's next step still ran", o.filter((x) => x.startsWith("AFTER-")).length === 3, o.filter((x) => x.startsWith("AFTER-")))
      c("what the cut leaves of the requests", true, ctx.of("wait5.after")[0]?.messages, true)
    }
  },
  {
    id: "signin", scenario: "signin", claim: "agent-browser 0.43.0 from the volume, a Chromium sidecar over CDP, a password and a TOTP (items 1, 7, 8, 23)", container: true, timeout: 240_000,
    check: (ctx, c) => {
      const o = ctx.out.map(clean)
      const site = read(join(ctx.dir, "site.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l))
      const logins = site.filter((e) => e.ev === "login.post"), totps = site.filter((e) => e.ev === "totp.post")
      c("chad secret run --stdin NAME -- agent-browser auth save ... --password-stdin stores the profile", o[0] === "OUT[completed] ✓ Done", o[0])
      c("auth login over CDP to the sidecar fills and submits: the site received the exact password", logins[0]?.ok === true && logins[0].passwordSha === PW && o[1]?.endsWith("/totp"), { site: logins[0] && { ok: logins[0].ok, passwordLength: logins[0].passwordLength, shaMatches: logins[0].passwordSha === PW }, url: o[1]?.split("\n").pop() })
      c("the code from chad secret code completes the sign-in: the page says so", totps[0]?.ok === true && o[2]?.endsWith("Signed in as " + FAKE.user), { site: totps[0] && { ok: totps[0].ok, window: totps[0].window }, page: o[2]?.split("\n").pop() })
      const found = leaks(ctx, { ...STORED, "SITE_PASSWORD after the change": FAKE.password2 })
      c("neither password nor the seed is in any of chad's outputs, or in clear under home/", Object.keys(found).length === 0, found)
      const calls = ctx.of("model.call")
      c("no model call saw a stored value", calls.every((e) => big(e.sees).length === 0), { calls: calls.length })
      const v = ctx.of("vault")
      c("item 23: agent-browser's vault is a second copy. It is AES-256-GCM with the key in a file beside it on the volume, so the two files give the password back", v[0]?.decryptsWithKeyBesideIt === true && v[0].holds.includes("SITE_PASSWORD"), v[0] && { encrypted: v[0].encrypted, keyMode: v[0].keyMode, fileMode: v[0].fileMode, decryptsWithKeyBesideIt: v[0].decryptsWithKeyBesideIt, holds: v[0].holds }, true)
      c("auth show prints no password", o[4]?.includes("Username: " + FAKE.user) && !o[4].includes("FAKE"), o[4]?.split("\n").slice(0, 3))
      c("item 23: after the password changes, auth login without a new auth save sends the old one", logins[2]?.ok === false && logins[2].passwordSha === PW && o[5]?.endsWith("Wrong username or password"), { site: logins[2] && { ok: logins[2].ok, sentTheOldOne: logins[2].passwordSha === PW }, page: o[5]?.split("\n").pop() })
      c("auth login prints \"Logged in\" for a login the site refused: it reports the submit, not the result", o[5]?.includes("✓ Logged in as 'testsite'") && o[5].endsWith("Wrong username or password"), o[5], true)
      c("auth save again, then auth login, sends the new password", logins[3]?.ok === true && logins[3].passwordSha === sha(FAKE.password2), { ok: logins[3]?.ok })
      const reused = totps.find((e) => e.reused)
      c("item 23: a second code in the same window is rejected by the site as already used", reused !== undefined && o[9]?.includes("That code was already used"), { site: reused && { reused: reused.reused, ok: reused.ok }, page: o[9]?.split("\n").pop() })
      c("the retry works by reading the seconds left, sleeping past the window and asking again. chad has no flag for it", totps[totps.length - 1]?.ok === true && o[10]?.endsWith("Signed in as " + FAKE.user), { page: o[10]?.split("\n").pop() }, true)
      c("agent-browser close leaves the sidecar's browser running", podman("exec", "chad-cred-chromium", "node", "-e", CDP_PROBE).ok, ctx.cli("close").stdout?.trim())
    }
  },
  {
    id: "pwmcp", scenario: "pwmcp", claim: "@playwright/mcp 0.0.85 through clanka's MCP layer: the dotenv step, and a secret change during a login", container: true, env: { PROTO_MCP_FILE: join(HERE, "site/mcp-playwright.json") }, timeout: 280_000,
    check: (ctx, c) => {
      const o = ctx.out.map(clean)
      const site = read(join(ctx.dir, "site.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l))
      const want = ctx.of("expect")[0]
      const servers = ["playwright", "pwplain", "pwshm", "pwfd"]
      const arrived = (server: string, name: string) => /FP ([\d:]+)/.exec(o.find((x) => x.startsWith("ARRIVED " + server + " " + name + " ")) ?? "")?.[1]
      const login = site.find((e) => e.ev === "login.post")
      c("--secrets reads a process substitution: the text \"SITE_PASSWORD\" is typed as the value, and the site received the exact password", login?.passwordSha === PW && o[0]?.includes("fill(process.env['SITE_PASSWORD'])") && o[0].endsWith("AT \"/totp\""), { toolResult: /await page[^\n]*SITE_PASSWORD[^\n]*/.exec(o[0] ?? "")?.[0], siteAccepted: login?.ok, at: o[0]?.split("\n").pop() })
      c("asked for the field's value, Playwright MCP answers with its own mask, <secret>NAME</secret>", o[0]?.includes("ASK ### Result\n\"<secret>SITE_PASSWORD</secret>\""), /ASK[^\n]*\n[^\n]*/.exec(o[0] ?? "")?.[0])
      c("item 2: asked for it encoded, it gives the value: base64 passes Playwright MCP's mask and chad's", o[0]?.includes(Buffer.from(FAKE.password).toString("base64")), /B64[^\n]*\n[^\n]*/.exec(o[0] ?? "")?.[0], true)
      const r = ctx.of("mcp.restarted").slice(-1)[0]
      const ra = ctx.of("restart.after")[0]
      c("a secret change during the login restarts the servers that name it", ra?.oldAlive === 0 && ra?.servers === 4, { closeMs: r?.closeMs, buildMs: r?.buildMs, oldServersAlive: ra?.oldAlive, newServers: ra?.servers })
      c("the MCP call in flight fails with \"Connection closed\"; the script and the turn go on", /^WAIT failed after \d+ms: mcp\.playwright\.browser_wait_for: MCP error -32000: Connection closed$/.test(o[1] ?? ""), o[1], true)
      c("the login survives the restart: the sidecar's tab is still on the TOTP page, and the code completes the sign-in", o[2]?.includes("STILL \"http://chad-cred-site:8080/totp\"") && o[3]?.includes("Signed in as tim") && site.find((e) => e.ev === "totp.post")?.ok === true, { tab: o[2]?.split("\n").pop(), page: o[3] })
      c("after the restart every server types the new value", servers.every((s) => arrived(s, "SITE_PASSWORD") === want.password2), Object.fromEntries(servers.map((s) => [s, arrived(s, "SITE_PASSWORD") === want.password2])))
      const table = Object.fromEntries(servers.map((s) => [s, { quoted: arrived(s, "QUOTED") === want.quoted ? "exact" : "wrong " + arrived(s, "QUOTED"), hashy: arrived(s, "HASHY") === want.hashy ? "exact" : "wrong " + arrived(s, "HASHY") }]))
      c("the dotenv spelling matters: NAME='value' carried all three test values exactly; NAME=value cut one at \" #\"; NAME=\"value\" changed the one with a backslash", table.playwright.quoted === "exact" && table.playwright.hashy === "exact" && table.pwfd.quoted === "exact" && table.pwfd.hashy === "exact" && table.pwplain.hashy !== "exact" && table.pwshm.quoted !== "exact", { "single quotes, <(...)": table.playwright, "unquoted, <(...)": table.pwplain, "double quotes, /dev/shm file": table.pwshm, "single quotes, /dev/shm file opened then unlinked": table.pwfd, expected: { quoted: want.quoted, hashy: want.hashy } }, true)
      const last = o[o.length - 1] ?? ""
      c("process substitution and the unlinked file leave nothing behind; the plain /dev/shm file stays, mode 600, with the value in it", last.includes("SHM pwmcp-secrets.env \n") && last.includes("SHMFILE 600 1"), last.split("\n").slice(0, 2))
      c("no plaintext copy on the data volume outside secrets/", last.trim().split("\n").pop() === "0", "files under /data holding the value, secrets/ excluded: " + last.trim().split("\n").pop())
      c("the value is in each server's environment, which the agent can read from /proc", /4 ENVIRON 1/.test(last), last.split("\n").filter((l) => l.includes("ENVIRON")).map((l) => l.trim()), true)
      const found = leaks(ctx, { ...STORED, "SITE_PASSWORD after the change": FAKE.password2, HASHY: FAKE.hashy })
      c("no stored value in any of chad's outputs or under home/", Object.keys(found).length === 0, found)
      const calls = ctx.of("model.call")
      c("no model call saw a stored value", calls.every((e) => big(e.sees).length === 0), { calls: calls.length })
      const built = ctx.of("mcp.built")
      c("four Playwright MCP servers from the volume connect, 25 tools each", built.length > 0 && Object.values(built[0].status).every((s: any) => s.connected && s.tools === 25), { firstBuildMs: built[0]?.ms, restarts: ctx.of("mcp.restarted").length })
    }
  }
]

// --- the sidecar probes: no clanka, containers only ----------------------------------------

const sidecar = async () => {
  results.push("## sidecar: how the chad container reaches Chromium's CDP port (TIM-541, item 1)")
  const c = checker("sidecar")
  await browserUp()
  const probe = (network: string, url: string) =>
    podman("run", "--rm", "--name", "chad-cred-probe", "--network", network, NODE_IMAGE, "node", "-e", "fetch(" + JSON.stringify(url) + ").then(async r=>console.log(r.status, (await r.text()).slice(0,120).replace(/\\s+/g,' '))).catch(e=>console.log('ERR', e.cause?.code ?? e.message))").out.trim()
  const same = probe("container:chad-cred-chromium", "http://127.0.0.1:9222/json/version")
  c("from a container sharing the sidecar's network namespace, as in a pod, CDP answers on 127.0.0.1:9222", same.startsWith("200"), same.slice(0, 110))
  const other = probe("chad-cred-net", "http://chad-cred-chromium:9222/json/version")
  c("from another container on the same network, by name, the port is refused: this Chrome ignores --remote-debugging-address=0.0.0.0 and listens on loopback only", other.includes("ECONNREFUSED"), other, true)
  const listen = podman("exec", "chad-cred-chromium", "node", "-e", "require('fs').readFileSync('/proc/net/tcp','utf8').split('\\n').filter(l=>/ 0A /.test(l)).forEach(l=>console.log(l.trim().split(/\\s+/)[1]))").out.trim()
  c("the listening socket is 127.0.0.1:9222 (0100007F:2406 in /proc/net/tcp)", listen.includes("0100007F:2406") && !listen.includes("00000000:2406"), listen.replace(/\n/g, " "))
  // A forwarder in the sidecar's namespace, for a layout where the two containers do not share one.
  podman("rm", "-f", "-t", "1", "chad-cred-fwd")
  podman("run", "-d", "--name", "chad-cred-fwd", "--network", "container:chad-cred-chromium", NODE_IMAGE, "node", "-e", "require('net').createServer(s=>{const u=require('net').connect(9222,'127.0.0.1');s.pipe(u).pipe(s);s.on('error',()=>{});u.on('error',()=>{})}).listen(9223,'0.0.0.0')")
  await sleep(1500)
  const byName = probe("chad-cred-net", "http://chad-cred-chromium:9223/json/version")
  const ip = podman("inspect", "chad-cred-chromium", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}").out.trim()
  const byIp = probe("chad-cred-net", "http://" + ip + ":9223/json/version")
  c("through a TCP forwarder in the sidecar: what Chrome answers to a request by container name and by IP address", byIp.startsWith("200"), { byName: byName.slice(0, 110), byIp: byIp.slice(0, 60) }, true)
  podman("rm", "-f", "-t", "1", "chad-cred-fwd")
  const tools = podman("run", "--rm", "--name", "chad-cred-probe", "--userns=keep-id", "-v", join(HERE, "vol/home/.local") + ":/data/home/.local:ro", "-e", "PATH=/data/home/.local/bin:/usr/local/bin:/usr/bin:/bin", NODE_IMAGE, "bash", "-c", "agent-browser --version; playwright-mcp --version; echo uid=$(id -u); echo sudo=$(command -v sudo || echo none)").out.trim()
  c("TIM-541: agent-browser and Playwright MCP install with npm under ~/.local on the volume and run from there as a user with no sudo", tools.includes("agent-browser 0.43.0") && tools.includes("0.0.85") && tools.includes("sudo=none"), tools.replace(/\n/g, " | "))
}

// --- main ----------------------------------------------------------------------------------

const wanted = process.argv.slice(2)
const chosen = wanted.length === 0 ? specs : specs.filter((s) => wanted.includes(s.id))
mkdirSync(OUT, { recursive: true })
toolsUp()
// The host scenarios share no file, so they run side by side. The browser ones share the sidecar.
const browser = (async () => {
  if (wanted.length === 0 || wanted.includes("sidecar")) await sidecar()
  for (const spec of chosen.filter((s) => s.container)) await runSpec(spec)
})()
await Promise.all([...chosen.filter((s) => !s.container).map(runSpec), browser])
const removed = containersDown()
console.log("\nremoved: " + removed.join(", "))
if (wanted.length === 0) {
  const lines: Array<string> = []
  for (const id of ["sidecar", ...specs.map((s) => s.id)]) {
    lines.push("", results.find((l) => l.startsWith("## " + id + ":"))!)
    lines.push(...results.filter((l) => l.includes("  [" + id + "]  ")))
  }
  const pass = lines.filter((l) => l.startsWith("PASS")).length, fail = lines.filter((l) => l.startsWith("FAIL")).length, found = lines.filter((l) => l.includes("]  FOUND: ")).length
  writeFileSync(join(OUT, "results.txt"), "node " + process.version + " on the host, " + NODE_IMAGE + " in the containers, " + new Date().toISOString() + "\n" + pass + " passed, " + fail + " failed, " + found + " marked FOUND\nA FOUND line records behaviour that TIM-546 did not settle or got wrong. PASS on it means the behaviour was observed as the line says.\n" + lines.join("\n") + "\n")
}
const failed = results.filter((l) => l.startsWith("FAIL")).length
console.log("\n" + results.filter((l) => l.startsWith("PASS")).length + " passed, " + failed + " failed")
process.exit(failed === 0 ? 0 : 1)
