---
name: browser
description: Read before opening a web page in a real browser, for a page that needs JavaScript, a sign-in, a form, a click or a screenshot.
---

# Browsing with Chromium

A Chromium runs in a container next to yours, and `agent-browser` drives it over the DevTools protocol. `AGENT_BROWSER_CDP` is set in every command you run and already points `agent-browser` at that Chromium, so run it with no `--cdp` flag and no `connect`.

Run `agent-browser skills get core` before your first command in a session. It is the usage guide for the installed version.

```sh
agent-browser open https://example.com
agent-browser snapshot
agent-browser screenshot /data/home/page.png
```

## What is different here

- Your container has no browser and cannot run one. Never run `agent-browser install`, and never pass `--executable-path`.
- There is one Chromium with one profile, and every session shares it. A site you signed in to stays signed in after a restart. Close the tabs you opened when you are done.
- A tab whose address has not changed for an hour is closed for you, whoever opened it, and one tab is always left open. A tab you left for the owner to finish a step in is gone once it has sat that long, so open the page again.
- When the tab you were using has been closed, `agent-browser` does not fail. Its next command runs in another open tab, which can be one the owner is using, or in a new blank one. Before you carry on in a tab from an earlier turn, run `agent-browser tab list` and check that the tab you want is still there.
- The owner sees this Chromium in their own browser and can use it. When a page needs a person, such as a captcha or a code sent to the owner, ask the owner to do that step there and then carry on in the same tab.
- A screenshot or a PDF that `agent-browser` saves lands in your container, at the path you gave.
- Chromium cannot read your files, so a file upload from a path in your container does not work. A file Chromium downloads lands in its own container, where you cannot read it. Fetch the file's address with `curl` in place of a download.
- Read the `credentials` skill before you sign in to a site.

## When it does not work

- `agent-browser: command not found`: install it with `npm install -g agent-browser`.
- It cannot connect: Chromium is down. Tell the owner to run `docker compose restart chromium` in `/opt/chad` on the server.
