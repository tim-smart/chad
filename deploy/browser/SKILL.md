---
name: browser
description: Read before opening a web page in a real browser, for a page that needs JavaScript, a sign-in, a form, a click or a screenshot.
---

# Browsing with Chromium

A Chromium runs in a container next to yours, and the `browse` MCP server drives it through the browse extension in that Chromium. Its tools are `mcp.browse.<tool>(options)`. List them with `searchTools({ server: "browse" })` and print a tool's declaration before you first call it.

Tabs are the handle. `navigate` with a `url` and no `tab` opens a new background tab and returns its id as `tab`. Pass that `tab` to every other call:

```ts
const { tab } = await mcp.browse.navigate({ url: "https://example.com" })
console.log(await mcp.browse.snapshot({ tab })) // the page as an outline, with refs like e5
await mcp.browse.click({ tab, ref: "e5" })
await mcp.browse.fill({ tab, ref: "e7", value: "some text" })
await mcp.browse.screenshot({ tab, path: "/data/home/page.png" })
await mcp.browse.tabs({ action: "close", tab })
```

Snapshot before you act, and snapshot again after: refs go stale once the page changes, and a click that returned is not proof that it worked. Do several steps in one script when you can.

## What is different here

- Your container has no browser and cannot run one. Use the Chromium `browse` drives.
- There is one Chromium with one profile, and every session shares it. A site you signed in to stays signed in after a restart.
- Use only the tabs you opened, or ones the owner lent you with the browse button on the toolbar. `tabs` with no `action` lists them. Close yours when you are done.
- A tab nobody has used for 10 minutes is closed for you. Before you carry on in a tab from an earlier turn, check that `tabs` still lists it, and open the page again when it is gone. To keep a tab past that, open it with `keepOpen: true`, and close it yourself later.
- The owner sees this Chromium on a desktop in their own browser and can use it. When a page needs a person, such as a sign-in, a captcha or a code sent to the owner, ask the owner in your reply to do that step on the desktop, and open the tab with `keepOpen: true` so it is still there when they are done. When the owner says they are at the desktop now, `handoff` with the `tab` and a `message` shows them a card on the tab and waits, up to 10 minutes, until they click Continue. Never solve a captcha yourself.
- A screenshot comes back as an image, attached to your next message. Give it a `path` to save it in your container as well.
- `upload` can put files from under `/data` into a page's file input, up to 50 MB. A file Chromium downloads lands in its own container, where you cannot read it. Fetch the file's address with `curl` in place of a download.
- Read the `credentials` skill before you sign in to a site.

## When it does not work

`status` says what is wrong and what to do next.

- The `browse` server is missing or not connected: `chad status` lists it under `mcp`. If `browse` is not installed, `npm install -g @opencode/browse` installs it, then `chad mcp restart`.
- No browser is connected, or the extension is not paired: the owner pairs it. Tell them to run `docker compose exec chad browse pair` in `/opt/chad` on the server and to enter the code it prints under browse's Options in the desktop's Chromium.
- Chromium is down: tell the owner to run `docker compose restart chromium` in `/opt/chad` on the server.

## Passwords and OTP codes

Use the `requestSecret` and `requestOnce` functions to request passwords and
single use secrets like OTP codes. Read the `credentials` skill for more
information.
