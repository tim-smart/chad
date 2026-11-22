---
name: browser
description: Read before opening a web page in a real browser, for a page that needs JavaScript, a sign-in, a form, a click or a screenshot.
---

# Browsing with Chromium

A Chromium runs in a container next to yours, and `browse` drives it through the browse extension in that Chromium. Every call goes through browse's relay, which the first `browse` command starts in your container.

Tabs are the handle. `browse navigate <url>` opens a new background tab and prints JSON whose `tab` is the tab's id. Pass that id with `--tab` to every other command:

```sh
browse navigate https://example.com           # prints "tab": 12, among other things
browse snapshot --tab 12                      # the page as an outline, with refs like e5
browse click e5 --tab 12
browse fill e7 "some text" --tab 12
browse screenshot --tab 12 --output /data/home/page.png
browse tabs close --tab 12
```

`browse tools` lists every command, and `browse <command> --help` shows its options. Snapshot before you act, and snapshot again after: refs go stale once the page changes, and a click that returned is not proof that it worked.

## What is different here

- Your container has no browser and cannot run one. Use the Chromium `browse` drives.
- There is one Chromium with one profile, and every session shares it. A site you signed in to stays signed in after a restart.
- Use only the tabs you opened, or ones the owner gave you. `browse tabs` lists them. Close yours when you are done.
- A tab nobody has used for 10 minutes is closed for you. Before you carry on in a tab from an earlier turn, check `browse tabs` for its id, and open the page again when it is gone. To keep a tab past that, open it with `--keepOpen`, and close it yourself later.
- The owner sees this Chromium on a desktop in their own browser and can use it. When a page needs a person, such as a sign-in, a captcha or a code sent to the owner, ask the owner in your reply to do that step on the desktop, and open the tab with `--keepOpen` so it is still there when they are done. When the owner says they are at the desktop now, `browse handoff --tab <id> --message "<what to do>"` shows them a card on the tab and waits until they click Continue. Never solve a captcha yourself.
- A screenshot `browse` saves lands in your container, at the path you gave with `--output`.
- `browse upload` can put a file from under `/data` into a page's file input, up to 50 MB. A file Chromium downloads lands in its own container, where you cannot read it. Fetch the file's address with `curl` in place of a download.
- Read the `credentials` skill before you sign in to a site.

## When it does not work

`browse status` says what is wrong and what to do next.

- `browse: command not found`: install it with `npm install -g @opencode/browse`.
- No browser is connected, or the extension is not paired: the owner pairs it. Tell them to run `docker compose exec chad browse pair` in `/opt/chad` on the server and to enter the code it prints under browse's Options in the desktop's Chromium.
- Chromium is down: tell the owner to run `docker compose restart chromium` in `/opt/chad` on the server.

## Passwords and OTP codes

Use the `requestSecret` and `requestOnce` functions to request passwords and
single use secrets like OTP codes. Read the `credentials` skill for more
information.
