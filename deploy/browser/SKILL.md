---
name: browser
description: Read before opening a web page in a real browser, for a page that needs JavaScript, a sign-in, a form, a click or a screenshot.
---

# Browsing with Chromium

A headless Chromium runs in a container next to yours, and `agent-browser` drives it over the DevTools protocol. `AGENT_BROWSER_CONFIG` already points `agent-browser` at that Chromium, so run it with no `--cdp` flag.

Run `agent-browser skills get core` before your first command in a session. It is the usage guide for the installed version.

```sh
agent-browser open https://example.com
agent-browser snapshot
agent-browser screenshot /data/home/page.png
```

## What is different here

- Your container has no browser and cannot run one. Never run `agent-browser install`, and never pass `--executable-path`.
- There is one Chromium with one profile, and every session shares it. A site you signed in to stays signed in after a restart. Close the tabs you opened when you are done.
- A screenshot or a PDF that `agent-browser` saves lands in your container, at the path you gave.
- Chromium cannot read your files, so a file upload from a path in your container does not work. A file Chromium downloads lands in its own container, where you cannot read it. Fetch the file's address with `curl` in place of a download.
- Read the `credentials` skill before you sign in to a site.

## When it does not work

- `agent-browser: command not found`: install it with `npm install -g agent-browser`.
- It cannot connect: Chromium is down. Tell the owner to run `docker compose restart chromium` in `/opt/chad` on the server.
