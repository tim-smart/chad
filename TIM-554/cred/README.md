# Credential tools on real clanka and a browser sidecar

A throwaway prototype for TIM-554. It runs the design agreed in TIM-546 on clanka 0.27.0 and effect 4.1.4, with a scripted model in place of a real one, effect's ChatTest in place of Discord, and a real Chromium in a second container. Nothing here is meant to be kept except the findings.

All secrets in it are invented and say so (FAKE-pw-not-real-0001 and friends, in fake.ts).

## How to run

    node run.ts

That takes about five and a half minutes, because one scenario waits a real five minutes. It needs rootless podman, and network access the first time, to pull node:26-trixie-slim and mcr.microsoft.com/playwright:v1.61.1-jammy and to npm install agent-browser 0.43.0 and @playwright/mcp 0.0.85 into vol/. node_modules is a symlink to ../swap/node_modules.

The driver starts the containers it needs (all named chad-cred-*, on the network chad-cred-net) and removes them when it ends. It writes:

- out/results.txt, one PASS or FAIL line per check with the measured evidence
- out/<scenario>.jsonl, the event log of each scenario
- out/<scenario>/, that scenario's data volume, stdout, and for the browser ones the test site's own log (site.jsonl)

node run.ts run code runs only the named scenarios and prints the lines without rewriting results.txt.

A line that starts with FOUND: records behaviour TIM-546 did not settle or got wrong. PASS on such a line means the behaviour was seen as the line describes it. It does not mean the behaviour is good.

The last full run: 179 passed, 0 failed, 28 marked FOUND. Three full runs were made. The first passed with 177 checks, before two more were added. The second failed two checks in signin, because the reused code step depended on where the TOTP window fell. That step was rewritten to force the case, signin then passed three times alone, and the third full run passed.

## What is in here

- chad/secrets.ts, chad/cli.ts, chad/rpcs.ts, bin/chad: the store, TOTP, and the chad secret commands (set, list, rm, run, code, request).
- chad/host.ts: the daemon. Sessions on real clanka Agents, the spawner wrap that adds CHAD_SESSION, the masking floor, the AgentExecutor wrap (PROTO_WRAP=1), the request queue, buttons and the modal, the MCP layer with ${NAME} expansion and restart.
- scenarios.ts: one scripted scenario per claim. run.ts: the driver and the checks.
- site/server.ts: the local login form (password, then TOTP, rejects a reused code, logs a hash of what it received). site/mcp-echo.mjs: a small stdio MCP server that reports its own key. site/mcp-playwright.json: four spellings of the Playwright MCP recipe.
- in-container.sh: runs one scenario in node:26-trixie-slim, sharing the Chromium container's network namespace.
- vol/: stands in for the data volume's home/.local, with the two browser tools installed by npm as an unprivileged user. It is 88 MB of npm packages and can be deleted. The driver reinstalls it.
- notes/: the two tickets and the tools' help text as read.

## Scenarios

| id | what it runs | where |
| --- | --- | --- |
| sidecar | how a container reaches Chromium's CDP port, and the tools on the volume | containers |
| run | chad secret run through clanka's bash: --env, --stdin, exit codes, the quoting trap | host |
| run-nomask | the same with masking off, to see what run does by itself | host |
| code | RFC 6238 vectors, the wait near the end of a window, refusals | host |
| mask-floor | scripts that print stored values, then a grep of every place chad writes, then a restart | host |
| mask-wrap | the same steps with the AgentExecutor wrap on | host |
| paste | the owner pastes a password that is not stored yet | host |
| button | Enter button, modal, non-owner click and submit, save path, MCP restart, name length | host |
| button-await | the same with the modal reply waiting for the daemon's queue | host |
| code-request | request --code | host |
| interrupt | an owner message and /stop during a pending request | host |
| repeat | repeat requests, a save from a terminal, a lost memory | host |
| noowner | plugin turns, outlived commands, no session, /secret in chat | host |
| wait5 | the real five minutes in bash with timeoutMs 330000, and in run() | host |
| script-limit | clanka's scriptTimeout set to 2 s against a 6 s wait | host |
| signin | agent-browser from the volume signs in to the form through the sidecar | containers |
| pwmcp | Playwright MCP through clanka's MCP layer, dotenv spellings, a secret change mid login | containers |

## What each claim showed

The numbers are from out/results.txt. Item numbers are TIM-546's.

1. chad secret run (items 7, 8). Held. The child saw the value (length 21, the sha256 matched) and CHAD_SESSION=s-c1 from the spawner wrap. Every Calling "bash" line shows P=SITE_PASSWORD and never the value. --stdin delivered 21 bytes, no newline, then end of file. A missing name gave "chad secret run: no secret named NO_SUCH_NAME" with exit 125. Exit codes 7, 143 (SIGTERM) and 127 passed through. With masking switched off entirely the value still reached none of chad's outputs, so this part of the promise does not lean on masking.

2. chad secret code (items 4, 8). Held. All 18 vectors of RFC 6238 appendix B pass through the CLI. With 6 and 5 seconds left the code came in 107 and 118 ms. With 4 seconds left it waited 3913 ms and printed the next window's code, with 1 second left 914 ms. run waits the same way (about 3 seconds with 3 seconds left). A plain secret gave "chad secret code: SITE_PASSWORD is not a TOTP secret", exit 1.

3. The masking floor (item 18). Held for the places it names, with one hole. After a turn that printed the store, the environment and the seed, a grep found no stored value in the history rows, the turns table including Failed.reason, every other table in the database (cluster's own included), the log, every post and edit chad made, what afterTurn received, or home/. The status message is masked before it is cut. After a restart the session reloads <secret:NAME> and no value. The hole is a value that contains a quote or a backslash. See the findings.

4. The AgentExecutor wrap (item 19). Held, with no clanka change. It is five lines in chad/host.ts (wrapExecutor). It joins the stream execute returns and masks it once, which costs nothing because clanka joins the same stream before it uses it. With the floor alone, 8 of 10 model calls in the turn saw the password. With the wrap, 0 of 10 saw any stored value, sub-agent and background task included, and the first turn took 2810 ms against 2848 ms.

5. Enter button and modal (items 9, 10, 16). Held. The owner's click got its modal in 1 ms. A non-owner click was acknowledged and ignored. The submit stored the value through the same queue as chad secret set, the MCP server that names the secret restarted with it (key length 0 before, 22 after), and the message became "Saved API_KEY" with no button.

6. The five minute wait (items 12, 23). Held. Inside bash with timeoutMs 330000 the stored form waited 300020 ms and --code 300024 ms, and both exited 1 with "chad secret request: timed out after 300 s". clanka put no limit on the script around the call. run() returned after 119186 ms with 'Task "bash_1" is still running in the background', so the skill is right to forbid it.

7. Owner message and /stop (item 12). Held. The request ended 60 to 139 ms after the owner's message with "chad secret request: owner replied in chat instead", exit 1, and the message then steered the turn. /stop killed the command in 34 to 204 ms, as a direct child and under bash, and the daemon edited the --code message to "Cancelled" 18 ms after the stop.

8. request --code (item 11). Held. The script got 482915 on stdout 44 ms after the submit, in the same turn. secrets.json was byte for byte unchanged. The message became "Code received".

9. Repeats (item 14). Held while the daemon stays up. A second request for the same name in the same thread posted nothing and printed "Already asked for DUP at 20:20:52 UTC". A save from a terminal edited both remembered buttons, in two threads, to "Saved DUP". After a restart it is weaker than item 14 says. See the findings.

10. agent-browser and a sidecar (items 1, 23). Held, with a change to how the sidecar is reached. auth save with --password-stdin, auth login over CDP and a code from chad secret code signed in to the form. The site received the exact password and the page read "Signed in as tim". No model call saw a value.

11. Playwright MCP (items 22, 23). Held, and the recipe is now known. --secrets does take a dotenv file and does read a process substitution. Typing the text SITE_PASSWORD into a field fills the value. A secret change during a login killed the call in flight and left the login itself intact.

## What the run found that TIM-546 did not settle

On reaching the browser:

- Chrome 149 ignores --remote-debugging-address=0.0.0.0 and listens on 127.0.0.1 only. From another container on the same network the port is refused. A forwarder in the sidecar gets further, but Chrome then answers a request by container name with "500 Host header is specified and is not an IP address or localhost". It works by IP address, or when the two containers share a network namespace as in a pod. The prototype shares the namespace. TIM-541 says "reached over CDP" and not how.

On masking:

- A value with a quote or a backslash in it passes the floor when it is JSON-escaped twice. That is what happens when the model's answer quotes a tool result that printed secrets.json. The spelling was found in the log, the history rows, the turns table, a chat post and the afterTurn input. The floor covers the raw value and the once-escaped one. With the wrap on, the spelling never forms, because the tool result was masked before the model could quote it.
- A value the script encodes passes every mask. base64 of the password came back through bash, and through Playwright MCP's browser_evaluate, past Playwright's own mask and chad's. Item 2 already says there is no promise against an agent that goes looking. This is the cheapest way to do it.
- clanka saves an output over 30,000 characters to a temp file and tells the model the path. chad does not write that file, so the value is in it unmasked, mode 644, outside the data volume. The wrap does not change that.
- The wrap covers what scripts print. It does not cover a value the model wrote into a script itself. That stays in the live context until the session is rebuilt from the masked rows.
- When the owner pastes a password (item 17), the script that saves it carries it, and chad's status message posts that script back into the chat. The value also stays in clear in every row written before the save, which is what item 20 accepts.

On the button and the modal:

- The reply to the modal must not wait for the daemon's queue. With the queue held for 5 seconds, a submit that waited was reported Late at 3000 ms and the typed value was lost. Replying first and saving after worked (reply in 1 ms, saved when the queue freed). The price is that a failed save can only be reported by editing the message.
- A submit from a non-owner on a modal the owner opened is a separate case from a non-owner click. It is ignored here. Item 9 only names the click.
- The button id carries the name and kind, so names have a length cap nobody chose. With this encoding a 75 character name posts and 76 fails with "chad secret request: the message could not be posted (TooLarge)". The modal's id plus metadata passes ChatTest's declared 100 at a 70 character name. ChatTest does not enforce that on a modal reply, so the 70 is a count and not a refusal I saw.
- After a restart, a save edits the button that was clicked and the ones posted since. A forgotten button in another thread stays live with its old text. Item 14 prices the restart at one extra ping.
- A --code message whose request ended because the owner spoke needs a text. Item 12 names none. The prototype uses "Answered in chat".
- set on an existing name without --note drops the old note. Item 5 does not say.

On clanka:

- Limits.scriptTimeout exists (AgentExecutor.ts line 290) and has no default. If chad ever sets it, it cuts the script around a request ("Script timed out: it reached its 2000ms limit and was stopped. Pending tool calls were cancelled.") and the request dies as it does on /stop.

On the browser tools:

- agent-browser's vault is a second copy of the password. It is AES-256-GCM, and the key is a file beside it (~/.agent-browser/.encryption-key, mode 600). The two files together gave the password back. A grep of home/ for the value finds nothing, which is misleading.
- auth login prints "Logged in as 'testsite'" for a login the site refused. It reports that it submitted. The agent has to check the page.
- After a password change, auth login sends the old password until auth save runs again. Item 23 has this right.
- A second code in the same window is refused by a site that tracks used codes. Sleeping past the window and asking again worked. chad has no flag for that. The seconds left are printed, so the skill can teach the sleep.
- The dotenv spelling matters. NAME='value' carried all three test values exactly. NAME=value cut "FAKE pw #not real 0009" at the " #". NAME="value" processed the backslash in the quoted test value.
- Process substitution, and a /dev/shm file opened and then unlinked, leave nothing behind. A plain /dev/shm file stays, mode 600, with the value in it.
- Whatever the dotenv step does, the value is in the server's environment, because that is how mcp.json hands it over. All four server processes had SITE_PASSWORD in /proc/<pid>/environ.
- A secret change closes the MCP call in flight: "MCP error -32000: Connection closed" after 1874 ms. The script and the turn went on. The sidecar's tab was still on the TOTP page after the restart and the login completed. So the cost of saving a secret mid login is one failed call, not a lost login, when the browser is a sidecar.
- The prototype restarts every server when any of them names the changed secret (close 59 ms, build 389 ms for four). Per-server restart was not built.

## What was not run, and why

- A real Discord modal. It needs a bot token and a server. Everything about buttons and modals here is ChatTest's model of them, including the 3 second rule and the 100 character limits.
- A real model. The model is a script. Whether a real model follows the skill, avoids the quoting trap or resists printing a value was not tested.
- A real site. The login form is local and simple. No captcha, no bot detection, no WebAuthn, no SMS.
- The gateway mask switched off (PROTO_NO_GATEWAY_MASK=1) as a contrast run. The switch exists and was not used in the driver.
- ${NAME} in mcp.json naming a TOTP secret failing the apply (item 8). The prototype reads mcp.json at boot only and has no apply step. The check that throws is written (chad/host.ts) and was not exercised. The other half of item 8, set NAME --totp refused while mcp.json names NAME, did run.
- Per-server MCP restart, and the gate and drain around a restart. Those belong to the MCP ticket.
- A derived image with a browser in it (the other half of item 1). Only the sidecar was run.
- Playwright MCP with a value that contains a newline. Only three values were tried, one of them with a single quote, a double quote and a backslash in it.
- The credentials skill as a file. The recipes were run as scripted steps. No skill text was written or loaded.
- chad backup with browser state. The sidecar's profile lives in the sidecar, as item 23 says, and no backup was run.
- Docker. Everything ran on rootless podman 5.8.6.
