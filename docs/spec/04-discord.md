# What a turn looks like in Discord

This part covers what the owner sees in Discord from the moment a message is sent until the turn is over. That is the status message, the answer, files in both directions, the login code, the two buttons, and the wording of the notices that belong to a turn. It also lists what the bot needs from Discord and the limits of effect/chat's Discord adapter that the design works inside. It leans on 03-sessions-and-turns.md for what a session and a turn are, for `/new` and `/stop` and for the resume after a restart, on 05-model-and-login.md for the login itself, on 15-credentials.md for the commands behind the Enter button, on 06-plugin-api.md for the tool and plugin shapes, on 16-failures-logs-status.md for the wording of a failed turn and of every notice outside a turn, and on 17-testing.md for how this part is tested. Nothing in this part has been run against a real Discord bot.

Four terms are used throughout. The owner is a person whose Discord user id is on chad's allowlist. A session's thread is the DM channel or the Discord thread the session lives in, and a server thread is a session's thread that sits in a Discord server and not in a DM. A notice is a short message that chad itself writes, as opposed to the model's answer. Subtext is Discord's small grey text, which a line gets by starting with `-# `.

## How chad reaches Discord

DIS-3 and DIS-4 are facts about Discord itself. A scripted gateway answers as its author thinks Discord does and cannot show either, so neither has a test on the scripted gateway, and the hand checks confirm both (see 17-testing.md).

- **DIS-1** chad connects to Discord over the gateway through dfx, so it needs no inbound port. Which gateway layer it uses and how events are replayed after a restart are in 03-sessions-and-turns.md.
- **DIS-2** Button clicks and modal submits arrive over the same gateway through `layerGatewayInteractions` and are handled by a `ChatInteraction.Handler`. They are not chat events and carry no dedupe key.
- **DIS-3** The bot needs Discord's privileged message content intent. Without it chad cannot read an owner's message in a thread when the message does not mention the bot. What `chad setup` does about the intent is in 10-cli.md.
- **DIS-4** The bot needs the Create Public Threads permission in a server channel where it is mentioned, because a mention in a plain channel opens a thread on that message (see 03-sessions-and-turns.md).
- **DIS-86** chad identifies to the gateway with the intents for guilds, guild messages, direct messages and message content.
- **DIS-87** In a server channel the bot needs the permissions View Channel, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History and Attach Files.
- **DIS-88** One constant in chad holds the intents of DIS-86 and the permissions of DIS-87. The intents chad identifies with come from it, and so do the permissions in the invite URL that `chad connection add discord` prints and the privileged intents that its output names. Message content is the only privileged intent in the list. The constant is written when chad first identifies to the gateway, for DIS-86, and what this rule adds to it is the invite URL and the named intents. The command, the URL's scopes and what `chad setup` shows of it are in 10-cli.md.
- **DIS-89** The intents of DIS-86 and the permissions of DIS-87 have not been run against a real Discord, and the hand checks are what confirm them (see 17-testing.md). This rule has no test in the gate.
- **DIS-5** chad registers no Discord slash commands. Its chat commands, such as `/new` and `/stop`, are plain text, and none of them reaches the model. The list of the chat commands is in 10-cli.md, how they are matched is in 03-sessions-and-turns.md, and each command is specified in 03-sessions-and-turns.md, 05-model-and-login.md, 10-cli.md or 15-credentials.md.
- **DIS-6** Only an owner's message triggers chad. A message from anyone else is ignored and never enters a session's history.
- **DIS-80** chad drops its own messages before it checks for an owner, and an id on the allowlist is an owner whether or not it belongs to a bot. Both rules are in 03-sessions-and-turns.md.
- **DIS-7** chad posts only in threads it already knows, because effect/chat cannot open a DM from a user id.
- **DIS-110** chad writes the log line `chat.connected` when the gateway session is up or resumed, `chat.disconnected` with the close code when the gateway closes, and `chat.refused` when Discord closes the gateway for good, as it does for a bad token or for intents the bot may not use. What dfx exposes for these three is found out in the wire slice, and the event table is in 16-failures-logs-status.md.
- **DIS-115** When Discord closes a connection's gateway for good, chad takes that connection's gateway down and does not dial Discord for it again until the daemon restarts. The daemon stays up, and it keeps serving its other connections and its socket. A close is for good when its code is 4004, 4010, 4011, 4012, 4013 or 4014, which Discord sends for a bad token, a wrong shard, a wrong API version, and intents that are not valid or not allowed.
- **DIS-111** chad writes the log line `message.ignored` for a message it drops under DIS-6 or DIS-80, with the reason `not-owner` or `own` and the author's id, and never the message's content. The `not-owner` line is at Info level, because it is how a wrong owner id shows up at first setup. The other reasons for this line are in 16-failures-logs-status.md.

## Limits of the Discord adapter

These are properties of effect/chat's Discord adapter and of clanka, read from source at effect commit `e1ae842` and at clanka 0.28.0. chad does not work around them in v1.

- **DIS-8** effect/chat has no typing indicator, and chad does not call Discord's typing endpoint itself. The status message is what shows that chad is working.
- **DIS-9** effect/chat has no operation that adds a reaction, so chad never reacts to a message.
- **DIS-10** effect/chat does not deliver inbound edits and deletes. chad acts on a message as it was first sent, and an owner's later edit or deletion of it changes nothing.
- **DIS-11** chad does not stream the answer token by token. clanka's text deltas carry reasoning and answer text as the same output part, so chad waits for the clean final answer, which arrives when clanka's stream ends with `AgentFinished`.
- **DIS-12** The adapter refuses a post or an edit over 2,000 code points with `TooLarge` before it calls Discord.
- **DIS-13** The adapter declares a floor of 1.5 seconds between two writes to one thread. `ChatMarkdown.post` and `stream` pace their parts by it. The adapter's own `post` and `edit` do not wait, so chad's edits of the status message are paced only by the 2 seconds of DIS-21.
- **DIS-14** One outgoing message carries at most 10 files and at most 10 MiB. Files go out through `post` and not through `stream`.
- **DIS-15** Every write sends `allowed_mentions: { parse: [] }` and suppresses link embeds unless `withPostOptions` says otherwise, and a reply does not ping its author by default. chad keeps these defaults everywhere except in DIS-55, DIS-58, DIS-60, DIS-62 and DIS-74.
- **DIS-16** An `edit` that passes no `actions` removes the buttons the message had.
- **DIS-17** A click has to be answered inside Discord's 3 seconds, of which the handler gets 2. A modal can open only as the reply to a click or to a slash command, and chad registers no slash commands (DIS-5), so in chad a modal opens only from a button.
- **DIS-18** A modal's text field cannot be masked, because neither the adapter nor Discord has a masked input.

## The status message

The status message is one message that chad posts when a turn starts and edits in place while the agent works. It is a short log of what the agent is doing. An action is one thing the agent did that gets a line in it.

- **DIS-19** For a turn that an owner's message started, posting the status message is the first thing chad does after the turn's request takes the session. That is before the wait for a plugin swap, the request for a login token, the prompt renders and the `beforeTurn` hooks (see 03-sessions-and-turns.md).
- **DIS-90** chad writes the status message's id into the turn's row of the `turns` table as soon as the post returns, before anything else in the turn runs (see 02-storage.md).
- **DIS-91** For a turn that a plugin started, the logged-out check of 05-model-and-login.md runs before the status message is posted, and a turn that the check ends posts no status message. Posting first would make every skipped cron run post and delete a status message, which makes a sound in a DM each time.
- **DIS-20** The status message is a header line that carries a Discord relative timestamp (`<t:…:R>`), followed by the last 5 or so actions with one line each. Each line is truncated to one line, and older actions drop off.
- **DIS-21** chad edits the status message only when an action happens, and at most once every 2 seconds. Discord renders the relative timestamp as elapsed time by itself, so no edit is needed to keep the time current.
- **DIS-22** The status message is written in Discord subtext and contains no emoji.
- **DIS-23** The status message shows no reasoning text and no script output.
- **DIS-24** A script's line is the script's own source, truncated. chad does not work out which tools a script calls.
- **DIS-25** chad takes a script's source from clanka's `ScriptDelta` part. clanka sends the whole source in one such part, after the model has finished writing it and before the script runs, so chad never assembles a script from pieces.
- **DIS-26** A sub-agent's line is the start of its prompt.
- **DIS-27** A compaction gets a line.
- **DIS-28** While clanka retries a model error, the status message shows a retry line that names the cause of the error and the count of retries. Its wording and how the count is made are in 16-failures-logs-status.md.
- **DIS-29** While a login is pending for the session, the status message shows "Waiting for login" and chad does not show clanka's retry parts (see 05-model-and-login.md).
- **DIS-92** "Waiting for login" shows whenever a login is pending for the session, for a login at the start of a turn as well as for one lost part way through. The rule is in 05-model-and-login.md.
- **DIS-30** When the agent reads a message that steered the turn, the status message gets the line "Read your message: <first 60 characters>" for that message. chad knows the agent has read it when it recognises the batch of stored history that carries the steering messages (see 03-sessions-and-turns.md), and it adds the line and writes the `turn.steered` log line for that batch. `steer` returning is not what triggers the line.
- **DIS-31** A steering message shows nothing until the agent reads it. If the turn ends first, the message starts the next turn, and that turn's status message is the acknowledgement.
- **DIS-32** A turn that is resumed after a restart edits the same status message, whose id is stored in the turn's row of the `turns` table (see 02-storage.md and 03-sessions-and-turns.md), and adds the line "Restarted mid-turn, picking it back up."
- **DIS-33** The status message carries the Stop button, and every edit sends the button again so that DIS-16 does not remove it.
- **DIS-34** chad masks nothing. A script's source appears in the status message as the agent wrote it, and no stored secret value is replaced in the status message or in anything else chad posts. Keeping a stored value out of a script is the job of the credential commands and the `credentials` skill (see 15-credentials.md).
- **DIS-35** chad removes the status message when the turn ends, however it ends. An answered turn leaves only the answer.
- **DIS-36** Once the status message is removed, the steps that came before a failure or a stop are only in the logs (see 16-failures-logs-status.md).
- **DIS-37** A turn that a plugin started looks like any other turn. It has a status message with a Stop button, and the message is removed at the end. The two cases in which such a turn has no status message are in DIS-91 and DIS-112.
- **DIS-81** Every action that gets a line in the status message also gets a log line, written by the same function (see 16-failures-logs-status.md).
- **DIS-93** When a post, an edit or the removal of the status message fails, chad logs the failure and carries on with the turn. The status message is a view of the turn, and a turn does not fail over it.
- **DIS-94** The one exception to DIS-93 is a first post that fails because the thread no longer exists. chad then ends the turn as a failed turn with the reason `ThreadGone` before the model runs (see 16-failures-logs-status.md). Without this a cron job in a deleted thread would run its whole turn and find out only when the answer cannot be posted.
- **DIS-95** When chad closes a turn's row that an earlier process left as running, it makes one attempt to delete the status message whose id is in the row and posts nothing. The rule is in 03-sessions-and-turns.md.

The lines with a fixed wording:

| Action | Line |
| --- | --- |
| The agent read a steering message | `Read your message: <first 60 characters>` |
| clanka is retrying a model error | The retry line in 16-failures-logs-status.md |
| The turn was resumed after a restart | `Restarted mid-turn, picking it back up.` |
| A login is pending for the session | `Waiting for login` |

The session prototype posted, and removed, the status message like this. The edit line is added to match the rules above.

```ts
import * as ChatInteraction from "effect/chat/ChatInteraction"

export const StopButton = ChatInteraction.button("stop", { label: "Stop", style: "danger" })
const Buttons = ChatInteraction.group(StopButton)

// When the turn starts.
const status = yield* chat.post(thread(threadId), { markdown: statusText, actions: [StopButton.of()] }) // adjusted: TIM-533 items 1 and 2

// On an action, at most once every 2 seconds. The button is passed again.
yield* chat.edit(thread(threadId), status.id, { markdown: statusText, actions: [StopButton.of()] }) // adjusted: TIM-533 items 1 and 8

// When the turn ends, however it ends.
yield* Effect.ignore(chat.delete(thread(threadId), status.id))
```

## Buttons and the modal

- **DIS-38** v1 has two buttons, Stop and Enter, and one modal. It has no selects.
- **DIS-39** The Stop button sits on the status message and does what `/stop` does. The click goes to the session's entity as a `stop` request that is not persisted, and chad acknowledges it inside the deadline in DIS-17 (see 03-sessions-and-turns.md). In the session prototype the acknowledgement took 2 to 38 ms.
- **DIS-40** A click on the Stop button from anyone who is not an owner is ignored.
- **DIS-41** The Enter button is posted in the session's thread by `chad secret request` and by `/secret NAME` in chat. An owner's click opens a modal with one text field. A click from anyone who is not an owner is ignored, which means no modal opens, nothing is stored and the button stays.
- **DIS-96** A click on either button from anyone who is not an owner is answered with the plain acknowledgement, inside the deadline in DIS-17, and chad posts nothing. The acknowledgement ends the click and tells a stranger nothing.
- **DIS-42** What the owner types into the modal is not a channel message. It arrives as a `ModalSubmitted` interaction and never enters a session or its history.
- **DIS-43** On a submit chad checks the input, replies to Discord, saves the value, and then edits the message, in that order. The reply comes before the save because a submit that waited for the daemon's queue first was late at 3001 ms and the typed value was lost.
- **DIS-44** If the save fails after the reply, the message says so and the button stays.
- **DIS-45** After a submit chad edits the button's message to "Saved NAME" for a stored secret, or to "Code received" for a one-off code, and removes the button.
- **DIS-46** A button's message ends in one of the states in the table below. The commands, waits and exit codes behind each state are in 15-credentials.md.
- **DIS-47** The Enter button's id carries the secret's name and its kind, so a click is handled from the id alone and a button still works after a restart. A secret's name matches `[A-Z_][A-Z0-9_]*` and is 64 characters at most, which keeps the id inside Discord's limit.
- **DIS-48** When an owner clicks a button that the daemon has forgotten after a restart, chad compares the time the secret was saved with the time of the button's message. If the secret was saved later, chad edits the message to "Saved NAME" and opens no modal.
- **DIS-49** The message that carries the Enter button reads as the agent asking. It names the session and quotes the `-m` text as the agent's words. When no owner is present in the turn, the stored form posts the button with a ping (see 15-credentials.md).
- **DIS-97** After `/stop` kills a waiting stored-form command, the Enter button stays and its message is not edited, as after a timeout and after an answer in chat. The button works from its id alone.

| What happened | Stored form (`chad secret request NAME`, `/secret NAME`) | One-off code (`chad secret request --code`) |
| --- | --- | --- |
| The owner submitted the modal | Edited to `Saved NAME`, button removed | Edited to `Code received`, button removed |
| The 5 minute wait ran out | Button stays | Edited to `Timed out`, button removed |
| The owner sent a message in the thread instead | Button stays | Edited to `Answered in chat`, button removed |
| `/stop` killed the waiting command | Button stays | Edited to `Cancelled`, button removed |
| The name was saved by another path | Every remembered button for the name, in every thread, is edited to `Saved NAME` | Does not apply |

The Stop button's click handler in the session prototype:

```ts
const ButtonsLive = Buttons.toLayer(Effect.gen(function*() {
  const makeSession = yield* Session.client
  return {
    stop: (click: any) =>
      Effect.gen(function*() {
        // adjusted: TIM-533 item 8. A click from anyone who is not an owner returns the acknowledgement here and does not reach the entity.
        yield* makeSession(ChatThread.toString(click.thread)).stop({ by: "button" }).pipe(Effect.orDie) // adjusted: TIM-559 ruling on SES-G4. The entity id is the thread string, see 03-sessions-and-turns.md.
        return ChatInteraction.ack
      })
  }
}))
```

## The answer

- **DIS-50** When the turn ends with an answer, chad posts the answer as a normal post through `ChatMarkdown.post`. The answer is not subtext.
- **DIS-51** The answer goes out in up to 5 messages, and whatever is left after the fifth is attached as one file named `answer.md`. `ChatMarkdown.post` splits long Markdown at block boundaries and reopens a code fence that a split cuts.
- **DIS-52** Link embeds stay suppressed in the answer, and mentions inside the answer stay inert.
- **DIS-53** In a DM the answer is a plain post.
- **DIS-54** If posting the answer fails, chad tries the unsent remainder once more and then logs the failure as `turn.answer-unposted`. The answer is in the session's history either way, and while the thread still exists the turn still ends as answered (see 16-failures-logs-status.md).
- **DIS-55** In a server thread the first part of the answer is a reply to the owner's message, with the reply ping on.
- **DIS-56** The answer of a turn that a plugin started is a plain post, because there is no message to reply to.
- **DIS-57** For every turn that a plugin started, an answer that is exactly `[SILENT]` is not posted, and the status message is removed as usual. This is a rule in the core and not in the cron plugin.
- **DIS-58** When a plugin-started turn carries a `mention` with a user id, the core puts a mention of that user at the start of the answer in a server thread and ignores it in a DM. This is how a cron job's answer pings the owner (see 13-timers-and-cron.md).
- **DIS-98** The answer and the failed-turn message reply to the message that started the turn, also when other messages steered the turn. A steering message has its acknowledgement in the status message (DIS-30).
- **DIS-99** The id of the message that started the turn is kept in the turn's saved request, so a turn that is resumed after a restart replies to the same message (see 03-sessions-and-turns.md).
- **DIS-100** When the message that a post would reply to no longer exists, the post goes out as a plain post, and the missing message does not make the post fail. This holds for every post chad makes as a reply, which covers the answer (DIS-55), the failed-turn message (DIS-60) and the give-up message (DIS-62). The last two are covered because the owner still has to be told that the turn failed.
- **DIS-101** The message that carries a plugin-started turn's `mention` allows that one user id in its allowed mentions and leaves every other mention in it inert (see 13-timers-and-cron.md).
- **DIS-102** chad drops a `mention` whose user id is not on the allowlist when it posts. No plugin can therefore ping anyone who is not an owner, and an owner who was removed from the allowlist stops being pinged.

## Turns that end without an answer

- **DIS-59** A stopped turn posts a notice with the time the turn ran, in the form "Stopped after 48s."
- **DIS-60** A failed turn posts a normal message, not subtext. In a server thread the message is a reply to the owner's message with the reply ping on, like an answer, and the message of a plugin-started turn that carries a `mention` starts with that mention. The message ends with one subtext line that carries the turn's id. The wording for each kind of failure, and the kinds of failure that post a different message or nothing in the thread, are in 16-failures-logs-status.md.
- **DIS-61** chad puts no bound on how long a turn runs in v1, and the owner has Stop. chad does end a turn when one model call has had no answer from the provider for 15 minutes (see 16-failures-logs-status.md).
- **DIS-62** chad gives up on a turn after two of its starts ended in a kill. A start that a graceful stop cut does not count, and such a turn is resumed however often that happens (see 03-sessions-and-turns.md). When chad gives up, it removes the status message the turn left behind and posts the give-up message in place of the failed-turn message. Like the failed-turn message, it ends with the subtext line that carries the turn's id, and in a server thread it is a reply to the owner's message with the reply ping on. Its wording is in 16-failures-logs-status.md.
- **DIS-104** The give-up message and the messages for a login that timed out or failed are normal messages, not subtext. The rule is in 16-failures-logs-status.md.
- **DIS-82** When the data volume is full and chad cannot save an owner's message, chad posts a message of its own in the thread. That rule and its wording are in 16-failures-logs-status.md.

## Files in and out

Incoming files are handled when a turn starts, and the rules for them are in 03-sessions-and-turns.md. clanka has no output part that carries a file, so outgoing files go through a tool.

- **DIS-63** An incoming image up to 10 MB on the message that starts a turn goes to the model. Every other incoming file is saved under `inbox/` in the session's directory and named in the prompt, and so is every file on a message that steers a running turn, images included (see 03-sessions-and-turns.md and 02-storage.md).
- **DIS-64** An incoming file over 25 MB is skipped. The owner sees a notice with the file's name and size, in the form "Skipped `big.zip` (48 MB). The limit is 25 MB.", and the prompt gets a line about it.
- **DIS-65** The agent sends a file with the tool `sendFile({ path, caption? })`, which comes from a bundled plugin.
- **DIS-66** `sendFile` posts its own message in the session's thread straight away. It does not wait for the answer.
- **DIS-67** `sendFile` returns an error to the agent when the file is over 10 MiB or when Discord refuses it.
- **DIS-68** `sendFile` accepts any path the agent can read.
- **DIS-69** The `sendFile` plugin uses only the plugin API. It posts through effect/chat's `Chat` service and finds the session's thread through `Session.CurrentSession` (see 06-plugin-api.md). Its source ships with chad and is reachable as an example at `/data/repo/examples/send-file.ts` (see 14-self-edit-skill.md).
- **DIS-105** The `caption` given to `sendFile` is the text of the message that carries the file.
- **DIS-106** The description of the `sendFile` tool says that it sends any file the agent can read.
- **DIS-107** `sendFile` is not an owner-only tool (see 06-plugin-api.md). It posts only in the session's own thread, and a plugin-started turn such as a cron job can call it.

The stand-in for the plugin that the image prototype shipped, with the caption added. Its handler is a stub that posts nothing.

```ts
import { Plugin } from "chad"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const tools = Toolkit.make(
  Tool.make("sendFile", {
    description: "Send any file you can read to the owner, in this session's thread.", // adjusted: TIM-559 ruling on DIS-G15. DIS-106 fixes what it says, and the exact wording is the builder's.
    parameters: Schema.Struct({
      path: Schema.String,
      caption: Schema.optionalKey(Schema.String) // adjusted: TIM-533 item 7
    }),
    success: Schema.String
  })
)

export default Plugin.make(
  // Stub from the stand-in. The real handler posts the file and fails as DIS-67 says.
  Plugin.toolkit(tools, { sendFile: ({ path }: { readonly path: string }) => Effect.succeed("sent " + path) })
)
```

## The login code

The login itself, its single shared wait and its timeout are in 05-model-and-login.md. These rules are the part the owner sees in a thread.

- **DIS-70** When a turn that an owner's message started needs a model login, chad posts the verify URL and the code in that turn's thread. The turn waits until the login completes or times out, and runs once the login completes.
- **DIS-71** When the login times out, after 15 minutes, every waiting turn ends as a failed turn. The message its thread gets, for a timeout and for a login that fails in any other way, is in 16-failures-logs-status.md.
- **DIS-72** A turn that an owner's message started in another thread, and that needs the login while one is pending, gets no code. chad posts the notice "Waiting for the login in <thread link>" in its thread.
- **DIS-73** A turn with no owner present never starts a login. When no login is pending it ends at once and posts nothing in its thread, and chad begins the keyed notice that chad is logged out if none is held (see 05-model-and-login.md). The notice's wording and when it may be sent again are in 16-failures-logs-status.md.
- **DIS-108** A turn with no owner present that starts while a login is already pending waits on that login, and ends as a failed turn with the reason `LoginFailed` if the login fails (see 05-model-and-login.md). When it ends that way chad posts nothing in its thread (see 16-failures-logs-status.md).
- **DIS-112** A plugin-started turn that waits on a pending login (DIS-108) posts nothing in its thread during the wait. It has no status message yet, and it does not get the notice of DIS-72. The reason is that such a turn posts nothing in its thread when it ends as `LoginFailed`.
- **DIS-113** When the login that a plugin-started turn waits on completes, chad posts the turn's status message, and the turn runs like any other turn.
- **DIS-114** The first message an owner sends in that thread during the wait of DIS-112 gets the notice of DIS-72, "Waiting for the login in <thread link>", in subtext. chad posts it once for a wait, and a later message in the same wait gets no notice. Without it the owner would type into silence for up to 15 minutes. What chad does with the message itself is in 03-sessions-and-turns.md.

## Notices

- **DIS-74** A notice inside a turn's flow is written in Discord subtext. A notice outside a turn is a normal message, and in a server thread it carries the owner's mention (see 16-failures-logs-status.md). No notice contains an emoji.
- **DIS-109** The notices of DIS-59, DIS-64, DIS-72, DIS-75 and DIS-76 each answer something the owner just did in that thread. They count as inside a turn's flow and are written in subtext. The notice of DIS-77 is the one notice of this part that is a normal message.
- **DIS-75** After `/new` chad posts the notice "New session started. Nothing from the earlier conversation carries over."
- **DIS-103** When `/new` arrives during a running turn, chad posts both notices, the "Stopped after" notice of DIS-59 first and the "New session started" notice of DIS-75 second.
- **DIS-76** After `/stop` with nothing running chad posts the notice "Nothing is running."
- **DIS-77** When chad cannot open a thread on a mention, it posts in the channel "I couldn't open a thread on that message (<Discord's reason>). I need Create Public Threads here, or you can DM me." and drops the event. This one is a normal message and not subtext, because it is the only thing the owner gets back for that message and it asks the owner to fix a permission.
- **DIS-78** A notice that belongs to no turn, such as a skipped plugin or an automatic safe mode, follows the notice rule in 16-failures-logs-status.md, which gives its wording, where it goes and when it may be sent again.
- **DIS-83** A command run from a session that changes what is loaded or deletes stored data posts one subtext line in that session's thread (see 16-failures-logs-status.md).
- **DIS-84** Every text chad posts in chat is a template in one `Messages` module, and tests refer to a message by its name there (see 17-testing.md).
- **DIS-79** The local dev adapter is a connection kind whose chat platform is effect/chat's `ChatTest`, running outside the daemon. The platform lives in the repo's test support and is not in the image (see 17-testing.md, and 10-cli.md for the `connection` commands). `ChatTest` shows subtext and relative timestamps as their raw text. It can press the Stop button through `click` and `interact`, and it supports modals.
- **DIS-85** What only a real Discord can show of this part is checked by a wire slice over a scripted gateway and by the checks a person does by hand once, at the end of the build (see 17-testing.md).

Every wording this part fixes, in one place. Text in angle brackets is filled in, and `big.zip`, "48 MB" and "48s" stand for the real name, size and duration. The wordings of a failed turn, of the give-up message, of a login that timed out or failed, of the retry line and of every notice outside a turn are in 16-failures-logs-status.md.

| Text | Form | When |
| --- | --- | --- |
| `Stopped after 48s.` | Notice | A turn was stopped (DIS-59) |
| `New session started. Nothing from the earlier conversation carries over.` | Notice | `/new` (DIS-75) |
| `Nothing is running.` | Notice | `/stop` with no turn running (DIS-76) |
| `I couldn't open a thread on that message (<Discord's reason>). I need Create Public Threads here, or you can DM me.` | Normal message in the channel | A thread could not be opened (DIS-77) |
| ``Skipped `big.zip` (48 MB). The limit is 25 MB.`` | Notice | An incoming file was over 25 MB (DIS-64) |
| `Waiting for the login in <thread link>` | Notice | Another thread's login is pending (DIS-72 and DIS-114) |
| `Read your message: <first 60 characters>` | Status line | The agent read a steering message (DIS-30) |
| `Restarted mid-turn, picking it back up.` | Status line | A turn was resumed after a restart (DIS-32) |
| `Waiting for login` | Status line | A login is pending for the session (DIS-29) |
| `Saved NAME`, `Code received`, `Timed out`, `Cancelled`, `Answered in chat` | Edit of the Enter button's message | See the table under DIS-49 |

## Gaps

- **DIS-G1** [builder] The text of the status message's header line. TIM-533 item 1 fixes only that it carries a relative timestamp.
- **DIS-G2** [builder] The exact number of actions shown. TIM-533 item 1 says "the last 5 or so".
- **DIS-G3** [builder] The length a script's line is cut to, and how the line is kept from being read as Markdown. TIM-533 assumes whitespace collapsed to one line and a cut at about 70 characters, says Tim was not asked, and leaves the choice between escaping and inline code to the build.
- **DIS-G4** [builder] How much of a sub-agent's prompt its line shows, and whether a background sub-agent is marked. TIM-533 item 2.
- **DIS-G5** [builder] The wording of the compaction line. TIM-533 item 2.
- **DIS-G6** [builder] Whether a line changes when its script or sub-agent finishes. TIM-533 item 2 gives lines only for what starts.
- **DIS-G10** [builder] The duration format beyond the two examples the tickets give, "48s" for a stopped turn and "2m 3s" for a failed one. TIM-533 items 4 and 5.
- **DIS-G13** [builder] How the reply ping and the mentions in DIS-55, DIS-58, DIS-60, DIS-62 and DIS-74 get past the adapter's default of inert mentions, and how a reply to a message that is gone goes out as a plain post (DIS-100). The facts name `withPostOptions` and no ticket states the options. The adapter's documentation at effect commit `e1ae842` names `withPostOptions({ failIfNotExists: false })` for the second. TIM-533 item 6, TIM-540 item 14, TIM-557 items 15 and 37 and TIM-559.
- **DIS-G14** [builder] The wording and form of the login prompt that carries the verify URL and the code. The login prototype logged "Open <verify URL> and enter <code>". TIM-533 item 10 and TIM-544.
- **DIS-G15** [builder] The value `sendFile` returns on success and the text of its errors. TIM-533 item 7.
- **DIS-G16** [builder] When the skipped-file notice is posted relative to the status message, and the wording of the matching line in the prompt. TIM-532 item 15 and TIM-533 item 12.
- **DIS-G19** [builder] The style of the Stop button and the label, title and style of the Enter button and its modal. The prototypes used a "danger" Stop, a "primary" Enter, the title "Enter a secret" and the field label "Value" (TIM-543, TIM-554).
- **DIS-G20** [builder] The wording of the Enter button's message when a save fails after the modal's reply. TIM-554 decision 5.
- **DIS-G26** [builder] Whether a click or a modal submit that Discord delivers a second time after the gateway resumes is handled a second time. DIS-2 says an interaction has no dedupe key and no rule says what a second delivery does. Recommended: find out in the wire slice whether dfx delivers one twice at all, and if it does, handle it again with no dedupe of chad's own.
- **DIS-G27** [builder] What the daemon does with a gateway that Discord has closed for good, after it writes `chat.refused` (DIS-110). One reading keeps the daemon up with that connection stopped until the token changes or the daemon restarts, and the other exits so that the container's restart policy takes over. Recommended: the daemon stays up, stops reconnecting that connection and keeps serving the socket, since 16-failures-logs-status.md lists a chat connection that is not connected under "Problems". Which closes write `chat.disconnected` and which fields the three lines carry belong with the event table in 16-failures-logs-status.md.
- **DIS-G28** [builder] What the notice of DIS-72 links to when the pending login was started by `chad login` or `chad model` and so has no thread of its own. Recommended: follow what 05-model-and-login.md settles for where such a login's code is posted. If the code also goes to the thread that a notice outside a turn goes to, link that thread.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| DIS-1 | Map, facts found at charting | charting | read |  | `rule` | `wire` |
| DIS-2 | TIM-533 facts comment, TIM-543, TIM-559 cold read | Tim | read |  | `rule` | `discord-ui` |
| DIS-3 | TIM-532 item 5, TIM-542 item 33, TIM-559 cold read | Tim | not run |  | `fact` | `wire` |
| DIS-4 | TIM-532 item 1, TIM-533 item 12 | Tim | not run |  | `fact` | `wire` |
| DIS-5 | TIM-532 item 6, TIM-542 item 22, TIM-546 item 15, TIM-559 cold read | Tim, and Architect (Tim has not read) for `/secret` | not run | TIM-546 | `rule` | `turns` |
| DIS-6 | Map, agreed at charting, TIM-532 item 5 | charting | not run |  | `rule` | `harness` |
| DIS-7 | TIM-530 resolution, TIM-533 facts comment | Tim | read |  | `rule` | `harness` |
| DIS-8 | Map, facts found at charting, TIM-533 item 1 | Tim | read |  | `rule` | `wire` |
| DIS-9 | Map, facts found at charting | charting | read |  | `fact` | `wire` |
| DIS-10 | Map, facts found at charting | charting | read |  | `fact` | `wire` |
| DIS-11 | Map, facts found at charting and out of scope, TIM-533 body | charting | read |  | `rule` | `harness` |
| DIS-12 | TIM-533 facts comment | Tim | read |  | `fact` | `discord-ui` |
| DIS-13 | TIM-533 facts comment, read again under TIM-559 round 2 R8 | Tim, and Architect (Tim has not read) for the wording after the second read | read |  | `fact` | `discord-ui` |
| DIS-14 | TIM-533 facts comment, map facts found at charting | Tim | read |  | `fact` | `discord-ui` |
| DIS-15 | TIM-533 facts comment, TIM-557 items 15 and 37 | Tim, and Architect (Tim has not read) for the exceptions in DIS-60, DIS-62 and DIS-74 | read |  | `rule` | `wire` |
| DIS-16 | TIM-533 facts comment | Tim | read |  | `fact` | `discord-ui` |
| DIS-17 | TIM-533 facts comment, TIM-546 facts comment, read again under TIM-559 round 2 R8 | Tim, and Architect (Tim has not read) for the wording after the second read | read |  | `fact` | `discord-ui` |
| DIS-18 | TIM-546 item 17 | Architect (Tim has not read) | read |  | `fact` | `settings` |
| DIS-19 | TIM-533 item 1, amended by TIM-559 ruling on DIS-G8 and SES-G10 | Tim, and Architect (Tim has not read) for the order | not run |  | `rule` | `discord-ui` |
| DIS-20 | TIM-533 item 1 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-21 | TIM-533 item 1 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-22 | TIM-533 item 12 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-23 | TIM-533 item 2 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-24 | TIM-533 item 2 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-25 | TIM-533 resolution, support section | Tim | read |  | `fact` | `discord-ui` |
| DIS-26 | TIM-533 item 2 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-27 | TIM-533 item 2 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-28 | TIM-533 item 2, amended by TIM-557 item 17 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `models` |
| DIS-29 | TIM-535 login section, TIM-544 item 4 | Tim | not run |  | `rule` | `models` |
| DIS-30 | TIM-533 item 2, amended by TIM-559 round 2 R3 | Tim, and Architect (Tim has not read) for how chad knows the message was read | read | TIM-559 | `rule` | `discord-ui` |
| DIS-31 | TIM-533 item 9 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-32 | TIM-533 item 12, TIM-536 item 11 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-33 | TIM-533 item 8 and facts comment | Tim | not run |  | `rule` | `discord-ui` |
| DIS-34 | TIM-554 decision 2, which removes TIM-546 item 18 and the TIM-546 change to TIM-533; answered for Tim by Jarvis, chat 2026-11-15 | Tim; the reading that this covers the status message and chad's posts kept by Jarvis, delegated by Tim on 2026-11-15 (Tim has not read) | not run |  | `rule` | `discord-ui` |
| DIS-35 | TIM-533 item 3 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-36 | TIM-533 resolution, passed on to other tickets | Tim | not run |  | `definition` | - |
| DIS-37 | TIM-533 item 11 | Tim | not run |  | `rule` | `plugin-api` |
| DIS-38 | TIM-533 item 8, amended by TIM-546 item 16 | Architect (Tim has not read) | not run | TIM-546 | `rule` | `settings` |
| DIS-39 | TIM-533 item 8, TIM-543 resolution | Tim | run |  | `rule` | `discord-ui` |
| DIS-40 | TIM-533 item 8 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-41 | TIM-546 items 9 and 15 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| DIS-42 | TIM-546 facts comment | Architect (Tim has not read) | read |  | `fact` | `settings` |
| DIS-43 | TIM-546 item 9, amended by TIM-554 decision 5 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| DIS-44 | TIM-554 decision 5 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| DIS-45 | TIM-546 items 9 and 11 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| DIS-46 | TIM-546 items 12 and 14, TIM-554 decision 8 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| DIS-47 | TIM-546 items 9 and 14, TIM-554 decision 6 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| DIS-48 | TIM-554 decision 7 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| DIS-49 | TIM-546 items 10 and 13 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| DIS-50 | Map, agreed at charting, TIM-533 item 6 | Tim | not run |  | `rule` | `harness` |
| DIS-51 | TIM-533 item 6 and facts comment | Tim | read |  | `rule` | `discord-ui` |
| DIS-52 | TIM-533 item 6 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-53 | TIM-533 item 6 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-54 | TIM-533 item 6, TIM-557 item 13, TIM-559 round 2 R4 | Tim, and Architect (Tim has not read) for the turn ending as answered and for the event name | not run |  | `rule` | `discord-ui` |
| DIS-55 | TIM-533 item 6 | Tim | not run |  | `rule` | `discord-ui` |
| DIS-56 | TIM-533 item 11 | Tim | not run |  | `rule` | `plugin-api` |
| DIS-57 | TIM-540 item 15 | Tim | not run |  | `rule` | `plugin-api` |
| DIS-58 | TIM-540 item 14, which amends TIM-533 item 11 | Tim | not run |  | `rule` | `plugin-api` |
| DIS-59 | TIM-533 item 4 | Tim | not run |  | `rule` | `turns` |
| DIS-60 | TIM-533 item 5, amended by TIM-557 items 14 and 15 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| DIS-61 | TIM-533 item 5, amended by TIM-557 items 18 and 19 | Tim, and Architect (Tim has not read) for the 15 minutes of silence | not run | TIM-557 | `rule` | `models` |
| DIS-62 | TIM-533 item 12, TIM-536 item 11, TIM-543 item 3, amended by TIM-557 items 14 and 15 and by TIM-559 ruling on DIS-G23 and FAIL-G25 | Tim, and Architect (Tim has not read) for the form and the wording | not run | TIM-557, TIM-559 | `rule` | `discord-ui` |
| DIS-63 | TIM-532 item 15, TIM-536 item 10, amended by TIM-559 ruling on SES-G6 | Tim, and Architect (Tim has not read) for the files on a steering message | not run | TIM-559 | `rule` | `turns` |
| DIS-64 | TIM-532 item 15, TIM-533 item 12 | Tim | not run |  | `rule` | `turns` |
| DIS-65 | TIM-533 item 7 | Tim | not run |  | `rule` | `plugin-api` |
| DIS-66 | TIM-533 item 7 | Tim | not run |  | `rule` | `plugin-api` |
| DIS-67 | TIM-533 item 7 | Tim | not run |  | `rule` | `plugin-api` |
| DIS-68 | TIM-533 item 7 | Tim | not run |  | `rule` | `plugin-api` |
| DIS-69 | TIM-533 facts comment, TIM-530 resolution, TIM-549, TIM-553 | Tim | read |  | `rule` | `apply` |
| DIS-70 | TIM-533 item 10, TIM-535 login section | Tim | run |  | `rule` | `models` |
| DIS-71 | TIM-533 item 10, TIM-535 login section, TIM-544, amended by TIM-557 items 12 and 14 | Tim, and Architect (Tim has not read) for the turn ending as failed | not run | TIM-557, TIM-559 | `rule` | `models` |
| DIS-72 | TIM-535 login section, TIM-544, amended by TIM-559 round 3 on DIS-G25 | Tim, and Architect (Tim has not read) for leaving out a plugin-started turn | run |  | `rule` | `models` |
| DIS-73 | TIM-535 login section, TIM-544, amended by TIM-557 items 12, 14, 36 and 40 and by TIM-559 rulings on MOD-G11 and FAIL-G2 | Tim, and Architect (Tim has not read) for nothing in the thread and for the notice rule | not run | TIM-557, TIM-559 | `rule` | `plugin-api` |
| DIS-74 | TIM-533 item 12, amended by TIM-557 item 37 | Tim, and Architect (Tim has not read) for notices outside a turn | not run | TIM-557 | `rule` | `failures` |
| DIS-75 | TIM-533 item 12 | Tim | not run |  | `rule` | `turns` |
| DIS-76 | TIM-533 item 12 | Tim | run |  | `rule` | `turns` |
| DIS-77 | TIM-532 item 1, TIM-533 item 12, amended by TIM-559 ruling on DIS-G22 | Tim, and Architect (Tim has not read) for the normal message | not run | TIM-559 | `rule` | `turns` |
| DIS-78 | TIM-534 item 15, amended by TIM-557 items 36, 38 and 40 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| DIS-79 | TIM-533 resolution, support section, TIM-546 facts comment, amended by TIM-558 items 20 to 22 | Tim, and Architect (Tim has not read) for the connection kind and `ChatTest` running outside the daemon | read |  | `rule` | `harness` |
| DIS-80 | TIM-558 item 40 | Architect (Tim has not read) | not run | TIM-558 | `rule` | `harness` |
| DIS-81 | TIM-557 item 4 | Architect (Tim has not read) | not run |  | `rule` | `discord-ui` |
| DIS-82 | TIM-557 items 32 and 33, amended by Tim's ruling on a full disk, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| DIS-83 | TIM-557 item 39 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| DIS-84 | TIM-558 items 30 and 33 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| DIS-85 | TIM-558 items 26, 36 and 37, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that chad has no release ceremony, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `definition` | - |
| DIS-86 | TIM-559 ruling on DIS-G17 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| DIS-87 | TIM-559 ruling on DIS-G17 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| DIS-88 | TIM-559 ruling on DIS-G17, amended by TIM-559 round 3 A4, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| DIS-89 | TIM-559 ruling on DIS-G17, TIM-559 cold read, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15, amended by Tim's ruling that tests are chosen by behaviour, chat 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| DIS-90 | TIM-559 ruling on DIS-G8 and SES-G10 | Architect (Tim has not read) | not run |  | `rule` | `discord-ui` |
| DIS-91 | TIM-559 ruling on DIS-G8 and SES-G10 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| DIS-92 | TIM-559 ruling on DIS-G7 and MOD-G10 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| DIS-93 | TIM-559 ruling on DIS-G9 | Architect (Tim has not read) | not run |  | `rule` | `discord-ui` |
| DIS-94 | TIM-559 ruling on DIS-G9 | Architect (Tim has not read) | not run |  | `rule` | `discord-ui` |
| DIS-95 | TIM-559 ruling on SES-G17 | Architect (Tim has not read) | not run |  | `rule` | `discord-ui` |
| DIS-96 | TIM-559 ruling on DIS-G18 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| DIS-97 | TIM-559 ruling on DIS-G20 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| DIS-98 | TIM-559 ruling on DIS-G12 | Architect (Tim has not read) | not run |  | `rule` | `discord-ui` |
| DIS-99 | TIM-559 ruling on DIS-G12 | Architect (Tim has not read) | not run |  | `rule` | `discord-ui` |
| DIS-100 | TIM-559 ruling on DIS-G12, widened by TIM-559 round 3 on DIS-G24 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `discord-ui` |
| DIS-101 | TIM-559 ruling on CRON-G11 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| DIS-102 | TIM-559 ruling on CRON-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| DIS-103 | TIM-559 ruling on DIS-G11 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| DIS-104 | TIM-559 ruling on DIS-G23 and FAIL-G25 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `models` |
| DIS-105 | TIM-559 ruling on DIS-G15 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| DIS-106 | TIM-559 ruling on DIS-G15 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| DIS-107 | TIM-559 ruling on DIS-G15 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| DIS-108 | TIM-559 ruling on MOD-G11 and FAIL-G2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| DIS-109 | TIM-559 ruling on DIS-G22, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `models` |
| DIS-110 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `wire` |
| DIS-111 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| DIS-112 | TIM-559 round 3 on DIS-G25 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| DIS-113 | TIM-559 round 3 on DIS-G25 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| DIS-114 | TIM-559 round 3 on DIS-G25 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| DIS-115 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `wire` |
