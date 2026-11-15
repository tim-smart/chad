// PROTOTYPE (TIM-554). A login form with a password step and a TOTP step, for one invented account.
// It logs what it received as hashes, so the log can be kept without holding the fake password.
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"
import { createServer } from "node:http"
import * as S from "../chad/secrets.ts"
import { FAKE } from "../fake.ts"

const LOG = process.env.SITE_LOG ?? "site.jsonl"
const PORT = Number(process.env.SITE_PORT ?? 8080)
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const log = (ev: string, data: object = {}) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ev, ...data }) + "\n")
const parsed = S.parseTotp(FAKE.totp)
if ("error" in parsed) throw new Error(parsed.error)
const entry: S.Entry = { value: parsed.seed, kind: "totp", date: "", totp: parsed.totp }

/** The password the account has now. POST /admin/password changes it, as the owner would on the site. */
let password = FAKE.password
const half = new Set<string>()
const full = new Set<string>()
const usedCodes = new Set<string>()

const page = (title: string, body: string) =>
  "<!doctype html><html><head><meta charset=utf-8><title>" + title + "</title></head><body><h1>" + title + "</h1>" + body + "</body></html>"
const loginPage = (error = "") =>
  page("Sign in", (error ? "<p id=error>" + error + "</p>" : "") +
    '<form method=post action=/login><label>Username <input id=username name=username autocomplete=username></label>' +
    '<label>Password <input id=password name=password type=password autocomplete=current-password></label><button id=submit type=submit>Sign in</button></form>')
const totpPage = (error = "") =>
  page("Two-step verification", (error ? "<p id=error>" + error + "</p>" : "") +
    '<form method=post action=/totp><label>Code <input id=code name=code inputmode=numeric autocomplete=one-time-code></label><button id=verify type=submit>Verify</button></form>')

const cookie = (req: any, name: string) => new RegExp("(?:^|; )" + name + "=([^;]+)").exec(req.headers.cookie ?? "")?.[1]
const body = (req: any) =>
  new Promise<URLSearchParams>((resolve) => {
    let text = ""
    req.on("data", (d: Buffer) => (text += d))
    req.on("end", () => resolve(new URLSearchParams(text)))
  })

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://site")
  const send = (status: number, html: string, headers: Record<string, string> = {}) => (res.writeHead(status, { "content-type": "text/html", ...headers }), res.end(html))
  const go = (to: string, headers: Record<string, string> = {}) => (res.writeHead(303, { location: to, ...headers }), res.end())
  if (req.method === "GET" && url.pathname === "/login") return send(200, loginPage())
  if (req.method === "POST" && url.pathname === "/login") {
    const form = await body(req)
    const ok = form.get("username") === FAKE.user && form.get("password") === password
    log("login.post", { username: form.get("username"), passwordSha: sha(form.get("password") ?? ""), passwordLength: (form.get("password") ?? "").length, ok })
    if (!ok) return send(200, loginPage("Wrong username or password"))
    const id = randomUUID()
    half.add(id)
    return go("/totp", { "set-cookie": "half=" + id + "; Path=/; HttpOnly" })
  }
  if (req.method === "GET" && url.pathname === "/totp") return half.has(cookie(req, "half") ?? "") ? send(200, totpPage()) : go("/login")
  if (req.method === "POST" && url.pathname === "/totp") {
    const id = cookie(req, "half") ?? ""
    if (!half.has(id)) return go("/login")
    const code = ((await body(req)).get("code") ?? "").trim()
    const now = Date.now()
    const valid = [now - 30_000, now].map((ms) => S.codeAt(entry, ms).code)
    const reused = usedCodes.has(code)
    const ok = valid.includes(code) && !reused
    log("totp.post", { codeLength: code.length, window: code === valid[1] ? "current" : code === valid[0] ? "previous" : "none", reused, ok })
    if (!ok) return send(200, totpPage(reused ? "That code was already used" : "Wrong code"))
    usedCodes.add(code)
    half.delete(id)
    const session = randomUUID()
    full.add(session)
    return go("/account", { "set-cookie": "session=" + session + "; Path=/; HttpOnly" })
  }
  if (req.method === "GET" && url.pathname === "/account") {
    return full.has(cookie(req, "session") ?? "") ? send(200, page("Account", "<p id=who>Signed in as " + FAKE.user + "</p><a href=/logout>Sign out</a>")) : go("/login")
  }
  if (url.pathname === "/logout") {
    full.delete(cookie(req, "session") ?? "")
    return go("/login", { "set-cookie": "session=; Path=/; Max-Age=0" })
  }
  if (req.method === "POST" && url.pathname === "/admin/password") {
    password = (await body(req)).get("password") ?? password
    log("admin.password", { passwordSha: sha(password) })
    return send(200, "ok")
  }
  send(404, page("Not found", ""))
}).listen(PORT, "0.0.0.0", () => log("site.listening", { port: PORT }))
