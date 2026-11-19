import { Clock, Effect, Layer } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { join } from "node:path"
import { expect, test } from "vitest"
import * as Plugin from "../../dist/Plugin.js"
import staleTabs from "../../dist/plugins/stale-tabs.js"
import { applied } from "../support/applied.ts"
import * as AdjustableClock from "../support/clock.ts"
import { fresh, scenario } from "../support/driver.ts"
import { eventually, rows } from "../support/owner.ts"

/**
 * Chromium's DevTools HTTP endpoint in memory: `GET /json/list` gives the open pages and one browser target, and
 * `GET /json/close/<id>` closes a page. A page in `lingering` answers its close and stays listed, as a page Chromium
 * is still closing does. Every other route is a 404.
 */
const devtools = () => {
  const pages = new Map<string, string>()
  const lingering = new Set<string>()
  const state = { lists: 0, closed: [] as Array<string> }
  const client = HttpClient.make((request, url) => {
    const respond = (status: number, body: string) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status })),
      )
    if (request.method !== "GET") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: `unexpected ${request.method}`,
          }),
        }),
      )
    }
    if (url.pathname === "/json/list") {
      state.lists++
      const targets = [
        ...[...pages].map(([id, url]) => ({ id, type: "page", url })),
        { id: "popup", type: "browser_ui", url: "chrome://omnibox-popup/" },
      ]
      return respond(200, JSON.stringify(targets))
    }
    const close = /^\/json\/close\/(.+)$/.exec(url.pathname)?.[1]
    if (close !== undefined && pages.has(close)) {
      if (!lingering.has(close)) pages.delete(close)
      state.closed.push(close)
      return respond(200, "Target is closing")
    }
    return respond(404, `No such target id: ${close}`)
  })
  return { pages, lingering, state, client }
}

test("a tab whose URL has not changed for longer than maxAge is closed, one that changed inside it is kept, when every tab is stale the one that changed last stays open, and a tab still closing is never the one left open", async () => {
  const browser = devtools()
  const clock = AdjustableClock.make()
  const plugin = Plugin.make(
    staleTabs.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, browser.client),
          Layer.succeed(Clock.Clock, clock),
        ),
      ),
    ),
  )
  const directory = fresh()
  applied(join(directory, "data", "repo"), {
    "chad.json": JSON.stringify({
      plugins: {
        "stale-tabs": {
          enabled: true,
          settings: { url: "http://172.30.72.10:9223", maxAge: "12 hours" },
        },
      },
    }),
  })
  browser.pages.set("a", "https://a.example/")
  browser.pages.set("b", "https://b.example/")
  const running = await scenario({
    directory,
    plugins: [{ name: "stale-tabs", plugin }],
  })

  /** Waits for the sweep the load or the last advance started to finish, which is when the fiber sleeps until the next. */
  let lists = 0
  const swept = async () => {
    await eventually(
      () => browser.state.lists > lists && clock.sleeping("1 minute"),
      Boolean,
    )
    lists = browser.state.lists
  }
  const remembered = () =>
    rows(running, `SELECT id FROM "plugin_kv_stale-tabs" ORDER BY id`).map(
      (row) => String(row["id"]),
    )

  await swept()
  expect(remembered()).toEqual(["tab/a", "tab/b"])

  // The owner moves b to another page and opens c, which the sweep 11 hours on sees. An advance runs the sweep it
  // wakes before it returns, so each change to the browser comes before the advance.
  browser.pages.set("b", "https://b.example/next")
  browser.pages.set("c", "https://c.example/")
  clock.advance("11 hours")
  await swept()

  // At 13 hours a is past the 12 hour maxAge, and b and c are two hours old.
  clock.advance("2 hours")
  await swept()
  // a's record stays, marked as closing, until a list shows it gone.
  expect(browser.state.closed).toEqual(["a"])
  expect(remembered()).toEqual(["tab/a", "tab/b", "tab/c"])

  // b changes once more, and 13 hours later both tabs are stale. The one that changed last is left open, and c, which
  // Chromium is slow to close, is still listed at the next sweep. It is sent its close again, and b is never closed.
  browser.pages.set("b", "https://b.example/again")
  browser.lingering.add("c")
  clock.advance("1 hour")
  await swept()
  clock.advance("13 hours")
  await swept()
  expect(browser.state.closed).toEqual(["a", "c"])
  clock.advance("5 minutes")
  await swept()
  expect(browser.state.closed).toEqual(["a", "c", "c"])
  expect(remembered()).toEqual(["tab/b", "tab/c"])

  // c moves to another URL while its close is still outstanding. That does not say the close was cancelled, so c is
  // still not the tab left open, and it is not sent a close for its new URL. b, stale and the only other tab, stays.
  browser.pages.set("c", "https://c.example/moved")
  clock.advance("5 minutes")
  await swept()
  expect(browser.state.closed).toEqual(["a", "c", "c"])

  // c comes back to the URL its close was sent for. Its age started again when it moved, so it is not sent another.
  browser.pages.set("c", "https://c.example/")
  clock.advance("5 minutes")
  await swept()
  expect(browser.state.closed).toEqual(["a", "c", "c"])

  // Once c is gone, the plugin forgets it.
  browser.lingering.delete("c")
  browser.pages.delete("c")
  clock.advance("5 minutes")
  await swept()
  expect(browser.state.closed).toEqual(["a", "c", "c"])
  expect([...browser.pages.keys()]).toEqual(["b"])
  expect(remembered()).toEqual(["tab/b"])
})
