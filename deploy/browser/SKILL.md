---
name: browser
description: Read before opening a web page in a real browser, such as pages that need JavaScript, a sign-in, a form, a click, or a screenshot.
---

# Browsing with Chromium

Chromium runs in a container alongside yours, and the `browse` MCP server drives it through the browse extension. Its tools live under `mcp.browse.<tool>(options)`. List them with `searchTools({ server: "browse" })` and check a tool's declaration before calling it the first time.

Every action targets a tab. Calling `navigate` with a `url` and no `tab` opens a new background tab and returns its id as `tab`. Pass that `tab` to every follow-up call:

```ts
const { tab } = await mcp.browse.navigate({ url: "https://example.com" })
console.log(await mcp.browse.snapshot({ tab })) // page outline with element refs like e5
await mcp.browse.click({ tab, ref: "e5" })
await mcp.browse.fill({ tab, ref: "e7", value: "some text" })
await mcp.browse.screenshot({ tab, path: "/data/home/page.png" })
await mcp.browse.tabs({ action: "close", tab })
```

Take a snapshot before acting and another one after. Element refs go stale as soon as the page changes, and a click returning doesn't prove it worked. Batch several steps into one script when you can.

## How this browser works

- Your container has no browser of its own and can't run one. Always use the Chromium driven by `browse`.
- All sessions share a single Chromium instance and profile, so sites you sign in to stay signed in across restarts.
- Only use tabs you opened yourself, or tabs the owner shared via the browse toolbar button. Call `tabs` with no `action` to list them, and close your tabs when you're done.
- Idle tabs close automatically after 10 minutes. Before reusing a tab from an earlier turn, check `tabs` to make sure it's still open, and reopen the page if it's gone. To keep a tab open longer, pass `keepOpen: true` when opening it and close it yourself later.
- The owner can view and use this Chromium on a desktop in their own browser. When a page needs a person (a sign-in, a captcha, or a verification code), open the tab with `keepOpen: true` and ask the owner in your reply to complete that step on the desktop. If the owner says they're already at the desktop, call `handoff` with `tab` and a `message` to show a card on the tab and wait up to 10 minutes for them to click Continue. Never solve a captcha yourself.
- Screenshots come back as images attached to your next message. Pass `path` if you also want to save the file in your container.
- `upload` can attach files from `/data` (up to 50 MB) to a page's file input. Files downloaded in Chromium stay in its container where you can't read them, so fetch the URL directly with `curl` instead.
- For passwords and one-off codes like OTPs, use `requestSecret` and `requestOnce`. Read the `credentials` skill before signing in to a site.

## Troubleshooting

Call `status` first to see what's wrong and what to do next.

- **`browse` server missing or disconnected**: check `mcp` in `chad status`. If `browse` isn't installed, install it with `npm install -g @opencode/browse` and run `chad mcp restart`.
- **No browser connected or extension unpaired**: the owner has to pair it. Ask them to run `docker compose exec chad browse pair` in `/opt/chad` on the server and enter the printed code under browse's Options in the desktop Chromium.
- **Chromium is down**: ask the owner to run `docker compose restart chromium` in `/opt/chad` on the server.
