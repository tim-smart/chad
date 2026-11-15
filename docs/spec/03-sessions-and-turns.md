# Sessions and turns

This part covers how a chat message becomes a turn of the agent, and what happens to a session across a restart. It defines the session, the `Session` entity that runs it on effect cluster, steering, `/new` and `/stop`, what is stored, passivation, the resume of a turn that a restart cut, the graceful stop, compaction, and the order in which chad calls plugin hooks around a turn. It leans on 02-storage.md for the tables and the volume layout, 04-discord.md for everything the owner sees, 06-plugin-api.md for the hook signatures, 08-apply-and-swap.md for the Agent rebuild and the system prompt, 05-model-and-login.md for the model layer, 13-timers-and-cron.md for plugin turns that a timer starts, 16-failures-logs-status.md for failed turns, the history reconcile and a full data volume, and 17-testing.md for how these rules are tested.

## What a session is

A session is one conversation between an owner and the agent. It has one history, one working directory and one executor, which is the clanka service that runs the agent's scripts and background processes. A turn is one run of the agent, from a prompt to an outcome. An owner is a user whose id is on chad's allowlist. A thread in this part means effect/chat's thread, which on Discord is a channel id, so a DM channel and a Discord thread are both threads.

- **SES-1** A DM is one session per DM channel.
- **SES-2** A message inside an existing Discord thread belongs to the session of that thread.
- **SES-3** A mention of chad in a plain server channel opens a Discord thread on that message with `startThread`, and the session is that thread.
- **SES-4** (a) `startThread` is get-or-create. (b) The gateway handler opens the thread before it saves the message, so a replayed event lands on the same thread.
- **SES-5** If opening the thread fails, chad says so in the channel and drops the event. The wording is in 04-discord.md.
- **SES-6** Only an owner's message can start or steer a turn. A message from anyone else is ignored and never enters the history.
- **SES-122** chad drops a message that is `isSelf`, which is a message that chad's own bot sent, before the owner check.
- **SES-123** Apart from that drop, the allowlist is by user id and nothing else. An id on the list is an owner whether or not it is a bot, and there is no flag for bots. What `chad owner add` says for a bot's id is in 10-cli.md.
- **SES-124** The docs, which are the user documentation that 00-overview.md defines, say in one sentence that a webhook id on the list makes everyone who holds the webhook URL an owner.
- **SES-7** A DM never needs a mention. A plain server channel always needs one. In a thread that already has a session, any owner message triggers chad without a mention.
- **SES-187** An owner's first message in an existing Discord thread that has no session needs a mention. Without one it is dropped with the reason `not-mentioned`. With one, the session is that thread itself and chad opens no new thread.
- **SES-167** A plugin turn addressed to a plain server channel runs in a session of kind `channel` that only plugin turns run in, and its answer is posted in the channel. Owner messages in that channel still follow SES-3 and SES-7 (see 06-plugin-api.md).
- **SES-183** `/stop`, the Stop button and `/new` act on a session of kind `channel` as they act on any other session. A `/stop` or a `/new` sent as a mention in a channel that has such a session acts on that session and opens no thread. SES-148 covers a channel that has no session.
- **SES-8** Seeing thread messages that do not mention chad needs Discord's privileged message content intent. How the intent is turned on is in 10-cli.md.
- **SES-9** A session has its own id, and every reset creates a fresh one. The thread says where the conversation lives. The session id says which conversation it is.
- **SES-10** A session never ends without `/new`, and its `sessions` row is never deleted.
- **SES-11** A session works in `sessions/<session-id>/` on the data volume, which is its Agent's startup directory. It has one executor, which is kept when the Agent is rebuilt (see 02-storage.md and 08-apply-and-swap.md).
- **SES-12** chad imports no history from Hermes.

## The Session entity

chad runs sessions on effect cluster. An entity is an addressable actor that handles requests. A persisted request is saved to storage before it is handled, so it survives a crash, and cluster delivers an unprocessed one again from the start when the process comes back. `SingleRunner` is cluster's layer for a single process and needs only a `SqlClient`. chad gives it the client of `db/chad.db` (see 02-storage.md), so cluster's tables sit next to chad's own.

- **SES-13** Each session thread is one `Session` entity, keyed by the chat thread, on `SingleRunner` over the SQLite file.
- **SES-149** The entity id is the thread string `ChatThread.toString(thread)`, which on Discord is `discord:<channel id>`. effect/chat defines that form and a codec for it, and chad defines no second format.
- **SES-150** The same thread string is the value of every stored thread column, which covers the `sessions` rows, the `timers` rows, `PluginTurn.thread` and the cron plugin's job records (see 02-storage.md, 06-plugin-api.md and 13-timers-and-cron.md).
- **SES-185** A session answers through the chat connection its message arrived on. Each connection has its own adapter and its own `Chat` router, because effect/chat's adapter registry holds one adapter for a platform and two connections can share a platform (see 02-storage.md). The `message` request carries the name of its connection, so a reply never goes out with another connection's token.
- **SES-14** An owner message is a persisted request to that entity. Its primary key is `ChatEvent.dedupeKey` of the event. chad has no hand-written inbox and no dedupe table.
- **SES-151** The `message` request stores the whole chat message in effect/chat's own encoded form, plus the attachment ids, so that a redelivered request rebuilds `Origin.Message` without asking Discord again.
- **SES-152** A stored request that no longer decodes ends as `Failed` with the reason `Internal` and a message in the thread. It does not block the boot and is not retried. A deploy is a graceful stop, so a cut turn is redelivered under the new image, and effect/chat's encoding can differ between two images.
- **SES-153** What cluster does with a stored request that does not decode has not been run. A process scenario covers it (see 17-testing.md).
- **SES-15** A turn that a plugin starts with `Turns.start` or `Turns.queue`, or that a timer starts, is a persisted request to the same entity.
- **SES-16** The core derives the key of a scheduled run from the plugin, the timer name and the scheduled time, so one scheduled time starts one turn. An immediate `Turns.start` gets a fresh id per call, so two calls are two turns. A plugin never passes a key.
- **SES-17** The entity posts to chat itself. The reply to a request is only its outcome.
- **SES-125** Nothing in chad learns a turn's end from cluster's reply alone. The session's own in-memory record of the end resolves a `Turns.start` call and a timer handler that wait in the same process (see 16-failures-logs-status.md).
- **SES-18** The entity runs with unbounded concurrency. Several requests to one session can be open at once, and the entity's own code decides which one holds the turn.
- **SES-19** A session never has two `send` calls open at once. clanka does not reject a second `send`, and a second one would start a second loop over the same history, so the entity is what prevents it.
- **SES-20** `disableFatalDefects` is on. A defect that escapes a handler fails that one request. The entity is not restarted, the same activation handles the next message, and the failed request is not redelivered after a restart. A defect inside a turn does not get this far, because chad ends that turn as `Failed` with the reason `Internal` (see 16-failures-logs-status.md), so this rule is the backstop for a defect that chad's own handling of a turn does not catch.
- **SES-21** `MessageRetention` for the `Session` entity is one day. After that cluster deletes a completed request.
- **SES-22** Completed requests of the `Timer` entity can be pruned with `MessageRetention` as well, because its handler checks each request against the `timers` row and does not rely on stored replies (see 13-timers-and-cron.md).
- **SES-23** A persisted request reaches the local entity straight after it is saved. It does not wait for cluster's storage poll.
- **SES-24** `entityMessagePollInterval` is 1 second. Only a request that carries a delivery time waits for this poll, which is how a timer fires under a second late (see 13-timers-and-cron.md).
- **SES-25** `SingleRunner` runs with `shardsPerGroup: 1`, from the first release.
- **SES-26** The shard count the database was made with is kept in a database row (see 02-storage.md). A daemon configured with another count refuses to start and names both numbers, because a changed count silently strands stored requests.
- **SES-27** Where the shard check sits in the boot and what a boot that it refuses writes are in 01-image-and-volume.md and 16-failures-logs-status.md. Whether that boot counts as unclean is in 02-storage.md.
- **SES-28** Cluster's shard lock is keyed by runner address and does not stop a second daemon on the same file. The daemon lock in 10-cli.md does that.
- **SES-29** When the database cannot be opened or migrated, for any reason other than a `state/version` newer than the image, chad stays up without sessions and answers any owner message with the error. `/status` still answers in that state (see 02-storage.md and 16-failures-logs-status.md).
- **SES-126** Every duration that chad sets in this part is a default of the `Timings` service, and the shipped daemon has no setting that changes one (see 17-testing.md).

The protocol below is the one the prototype ran, with its test helpers removed. The request that carries `/new` (SES-138) was not in the prototype and is not shown. `Steered` and `Dropped` are replies that only an owner message can get. The plugin API's `Outcome` has the first three tags only (see 06-plugin-api.md).

```ts
import * as ChatMessage from "effect/chat/ChatMessage" // adjusted: TIM-559 ruling on SES-G5
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as Entity from "effect/cluster/Entity"
import * as MessageRetention from "effect/cluster/MessageRetention"
import * as SingleRunner from "effect/cluster/SingleRunner"
import * as PrimaryKey from "effect/PrimaryKey"
import * as Rpc from "effect/rpc/Rpc"
import * as Schema from "effect/Schema"

export const Outcome = Schema.Union([
  Schema.TaggedStruct("Answered", { text: Schema.String }),
  Schema.TaggedStruct("Failed", { reason: FailedReason }), // adjusted: TIM-557 item 12, a closed set of tags listed in 16-failures-logs-status.md
  Schema.TaggedStruct("Stopped", {}),
  // The two replies only an owner message can get: it joined a running turn, or the turn it was steering was stopped.
  Schema.TaggedStruct("Steered", {}),
  Schema.TaggedStruct("Dropped", {})
])

export class Incoming extends Schema.Class<Incoming>("proto/Incoming")({
  key: Schema.String, // ChatEvent.dedupeKey(event)
  thread: Schema.String, // ChatThread.toString(thread), "discord:<channel id>" // adjusted: TIM-559 ruling on SES-G4
  message: ChatMessage.ChatMessage, // adjusted: TIM-559 ruling on SES-G5, the whole chat message in effect/chat's encoded form
  attachments: Schema.Array(Schema.String), // adjusted: TIM-559 ruling on SES-G5, attachment ids only
  sentAt: Schema.Number
}) {
  [PrimaryKey.symbol]() {
    return this.key
  }
}

export class PluginTurn extends Schema.Class<PluginTurn>("proto/PluginTurn")({
  key: Schema.String, // "start/<fresh id>", or "timer/<plugin>/<name>/<scheduled time>" for a scheduled run
  thread: Schema.String, // ChatThread.toString(thread) // adjusted: TIM-559 ruling on SES-G4
  prompt: Schema.String,
  plugin: Schema.String,
  label: Schema.String,
  timer: Schema.optionalKey(Schema.Struct({ name: Schema.String, scheduledAt: Schema.Number })),
  mention: Schema.optionalKey(Schema.String),
  sentAt: Schema.Number
}) {
  [PrimaryKey.symbol]() {
    return this.key
  }
}

export const Session = Entity.make("Session", [
  Rpc.make("message", { payload: Incoming, success: Outcome }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("pluginTurn", { payload: PluginTurn, success: Outcome }).annotate(ClusterSchema.Persisted, true),
  // Not persisted: a stop that is lost in a crash has nothing left to stop.
  Rpc.make("stop", { payload: Schema.Struct({ by: Schema.String }), success: Schema.Struct({ stopped: Schema.Boolean }) })
])

export const SessionLive = Session.toLayer(handlers, {
  concurrency: "unbounded",
  maxIdleTime: 30 * 60_000,
  disableFatalDefects: true
})

MessageRetention.make({ entity: Session, retention: "1 day" }) // adjusted: TIM-532 item 2, the prototype used a test value

SingleRunner.layer({
  shardingConfig: { entityMessagePollInterval: 1000, shardsPerGroup: 1 } // adjusted: TIM-543 decision 2, TIM-553 decision 4
})
```

The refusal the prototype printed when a database made at cluster's default of 300 shards met a daemon set to 1:

```
chad serve: this database was made with 300 shards and this chad uses 1. Messages stored under the old count would never be delivered, so chad will not start.
```

## From a chat event to a saved request

effect/chat runs chad's handler inline, one event at a time for the whole bot. Under `layerDispatchHook` a handler slower than about 41 seconds makes the Discord shard reconnect. So the handler does as little as it can, and the turn runs in the entity.

- **SES-30** (a) Discord events arrive through `layerDispatchHook`, with dfx's shard state stored in the same SQLite file. This is the at-least-once path. It resumes after a restart and replays an event that was refused (b) or was in flight.
- **SES-31** For a message, the gateway handler checks the owner and the mention, opens the thread if one is needed, saves the message as a request to the session's entity and returns. It does not wait for the turn.
- **SES-32** The handler refuses an event only when the save fails. A save that fails because the data volume is full has its own rule (SES-127). An event that chad drops under SES-180 is accepted and not refused, because a refused event blocks the shard (SES-128).
- **SES-127** When the save fails because the data volume is full, chad answers in the thread and accepts the event once the reply is posted, so the event is not replayed. If the reply cannot be posted either, chad refuses the event. The wording of the reply is in 16-failures-logs-status.md.
- **SES-128** A refused event is not held for a restart. dfx reconnects and resumes in the same process after 1 second, doubling up to 2 minutes, and it blocks later events on the shard while it does. That backoff is dfx's own and runs at its real length. It is not a duration of the `Timings` service.
- **SES-33** An event that is delivered a second time is dropped by its primary key while cluster still holds the request.
- **SES-180** A message that chad drops writes the log event `message.ignored`, which carries a reason and the author's id and never the content. The reason is `not-owner` under SES-6, `own` under SES-122, `not-mentioned` under SES-7 and `duplicate` for an event that is delivered a second time. The event's row, with its level, is in 16-failures-logs-status.md.
- **SES-194** A second delivery of an event is logged as `message.ignored` with the reason `duplicate` in two places. The gateway handler writes it when cluster still holds a request with the event's key, and the entity writes it when it answers a request from a `turns` row or a `steers` row. An event that Discord sends again because its first save failed is not a duplicate.
- **SES-34** Chat commands are plain text, matched after the mention is stripped. There are no Discord slash commands.
- **SES-145** A chat command is matched on the first word of the trimmed message, without regard to case. The rest of the message is the command's arguments, and any other text goes to the model.
- **SES-146** `/new`, `/stop` and `/status` ignore trailing text and still run. A "/stop please" that reached the model as a steering message would be the worst outcome available.
- **SES-147** A mentioned command in a plain channel with no session is answered in the channel and opens no thread, because a thread would create a session that nothing has been said in.
- **SES-148** In a plain channel with no session, `/new` and `/stop` create nothing and say that there is no session there.
- **SES-186** The reply of SES-148 is the subtext notice "There is no session in this channel. Mention me with a message and I'll open a thread for it.", posted in the channel.
- **SES-188** `/stop` as the first message in a DM or a thread that has no `sessions` row posts "Nothing is running." and creates no row. `/new` there creates the thread's first row and posts its notice.
- **SES-35** `/new` and `/stop` are specified in this part. `/status`, `/safe` and `/model` run the same daemon calls as the CLI, print the same text and do not go through the model (see 10-cli.md).
- **SES-36** `/secret NAME`, `/secret NAME totp` and `/secret` are plain text like `/new`, follow the same mention rule and never reach the session (see 15-credentials.md).
- **SES-37** When dfx has to identify again instead of resuming, chad reads forward with `Chat.history` from the last message it saw in each session that was active in the past 7 days, and sends what it finds through the normal persisted path.
- **SES-38** effect/chat does not say whether the gateway resumed or identified again. chad watches the gateway dispatch itself, where dfx's shard tells `READY` from `RESUMED`, to know when to catch up.
- **SES-170** The last message chad saw in a session is a column on its `sessions` row, and the catch-up of SES-37 reads forward from it (see 02-storage.md).
- **SES-199** A session is active for the catch-up of SES-37 when it has not ended and the owner message of its mark (SES-170) was sent less than 7 days ago. The `sessions` row keeps that message's time beside the mark, so a session that `/new` ended is not caught up.
- **SES-171** The gateway handler writes that mark after the save of the request succeeds, and not in one transaction with the save. A mark that lags is harmless, because SES-33 and SES-90 drop a message that is read twice.
- **SES-172** The mark only moves forward, and it advances for every message chad handled in that thread, chat commands included, so the catch-up never replays a `/new` or a `/stop`.
- **SES-203** A chat command runs once for each chat message, however often the message is delivered while the process runs: by both connections of a thread that two bots share, by a replay, or by two catch-ups that overlap. In such a thread, a message belongs to the connection whose delivery reaches chad first, the catch-up's included, and the session answers through it (SES-185).
- **SES-204** A chat command also runs once for each chat message across a restart, and however many other commands came between: a delivery after the restart, by a replay or a catch-up through either connection, finds the message's row in `commands` (STO-208) and does not run it. The row is written before the command runs, so a kill between the two leaves the command not run, and the owner sends it again.
- **SES-196** The mark orders two messages by their times, and two messages of one time by their ids: a longer id is later, and ids of one length compare as text. Discord's ids and the local platform's both count up that way. `/new` gives the new row the later of the old row's mark and the command's own, by that order.
- **SES-39** A mention in a plain channel with no session that the catch-up cannot find is lost. This is accepted.
- **SES-129** The gateway behaviours in SES-4, SES-30, SES-37 and SES-38 have not been run. They are tested by the Discord wire slice. Of them only the mention of SES-4 meets a real gateway, in the hand checks (see 17-testing.md).
- **SES-40** An image up to 10 MB goes to the model as a `FilePart`.
- **SES-41** Every other file is saved under `inbox/` in the session's working directory, and the prompt names its path.
- **SES-198** The prompt names a saved file by its absolute path, because the Agent's working directory moves with each `cd` and the inbox stays in the session's directory.
- **SES-42** A file over 25 MB is skipped with a line in the prompt. The notice the owner sees is in 04-discord.md.
- **SES-43** The entity downloads attachments when the turn starts, so the stored request holds attachment ids only.
- **SES-189** An attachment id in a stored request is the attachment's id in the stored chat message. chad turns it into bytes with the chat adapter's `download` operation on every platform, the local one included, and reads a file's size from the message before it downloads anything.
- **SES-190** When a download fails, the turn carries on. The prompt gets a line about the file, and the owner sees the subtext notice "Skipped `<name>`. I couldn't download it."
- **SES-191** An attachment is an image when its declared content type is `image/png`, `image/jpeg`, `image/gif` or `image/webp`. The 10 MB and 25 MB limits are binary, so they are 10 × 1024 × 1024 and 25 × 1024 × 1024 bytes. An image over 10 MB and up to 25 MB is saved under `inbox/` like any other file.
- **SES-154** For a message that steers a running turn, chad downloads the attachments before it calls `steer` and saves every one of them, images included, under `inbox/` with its path in the steering text. SES-42 applies. clanka's `steer` takes a string, so a steering message is poorer than a first message, because the model gets the path of an image and not the image.
- **SES-155** A message that was waiting to steer and starts the next turn under SES-46 is handled as a first message, so its image goes to the model as a `FilePart` under SES-40. How a message's attachments are handled is therefore decided when the message joins a running turn or starts one, and not when it arrives.

## Starting a turn and steering

Three clanka facts shape this. A second `send` during a turn is not rejected and starts a second loop over the same history. `steer` puts a message into a running turn, waits until a run reads it, and withdraws the message if the waiting effect is interrupted. A run reads every waiting steering message in one step and appends them to the history as one batch (SES-176). chad acts on that batch as it is stored and never on the return of `steer`, for the `steers` row, the log event and the `Steered` reply alike (SES-157, SES-177 and SES-178). What the owner sees while a turn runs is in 04-discord.md.

- **SES-44** When an owner message's handler finds the session idle, it starts a turn with that message as the prompt.
- **SES-45** When a turn is running, the handler calls `steer` and stays open until a run reads the message. The request is then answered `Steered`.
- **SES-46** If the turn ends before the message is read, that same handler starts the next turn with the message as its prompt.
- **SES-47** A message sent near the end of a turn either steers it or becomes the next turn, and which one depends on timing. It is never lost, and it is in the stored history exactly once.
- **SES-156** chad records each owner message that steered a turn in a table of its own, keyed by the request's key and naming the turn it joined, so `turns` stays one row per turn. The table and its SQL are in 02-storage.md.
- **SES-176** clanka takes every steering message that is waiting in one step. It resumes each waiting `steer` call and appends the messages as one `HistoryAppended` batch of user messages with string content, in the order the calls were made. A test of its own holds this against the pinned clanka, with two steers that arrive as one batch in order.
- **SES-177** clanka does not order a resumed `steer` call against the consumer of the `send` stream, so chad can store that batch before it sees `steer` return. The return of `steer` is therefore not what chad acts on.
- **SES-178** chad recognises the batch that carries its steering messages. It is a `HistoryAppended` batch in which every message is a user message with string content, and whose contents equal, in order, the texts of the oldest steers that chad has passed to `steer` and not yet recorded.
- **SES-157** The row of SES-156 is written in the transaction that stores that batch in the history, and before the request is answered `Steered`. Two separate writes with a kill between them would make a redelivery drop a message that the history never got.
- **SES-179** chad writes the log event `turn.steered` for a steering message together with that row, when the batch is stored, and not when `steer` returns (see 16-failures-logs-status.md).
- **SES-158** A redelivered owner message whose key has such a row is answered `Steered` and does nothing else.
- **SES-159** Those rows are never deleted, for the reason SES-89 gives for `turns` rows.
- **SES-160** A process scenario kills chad on each side of that commit. After a kill before the commit the redelivered message steers again. After a kill after the commit it does not. The stored history holds the message once in both cases. This has not been run, and SES-47 counts as proven only once it has (see 17-testing.md).
- **SES-164** When a turn ends and several requests are waiting at the session, owner messages take the session first and plugin turns after them, each group in the order of `sentAt`, because an owner is waiting on a reply and a scheduled run is not.
- **SES-48** A plugin turn waits inside its request for the session to be idle. It never steers.
- **SES-49** A tool handler queues a turn for its own thread with `Turns.queue`, which returns once the request is saved and does not wait for the outcome, because the queued turn runs only after the calling turn ends. `Turns.start` called from a tool handler for the thread of its own turn fails at once with a message that names `Turns.queue` (see 06-plugin-api.md and 13-timers-and-cron.md).
- **SES-50** clanka runs with `ConversationMode` on, so a turn ends at a text reply with nothing waiting.
- **SES-51** clanka keeps a turn open while a background sub-agent runs, even after the model has answered. An owner message sent in that time steers the open turn, and no new turn starts until the sub-agent finishes. What this means after an apply is in 08-apply-and-swap.md.
- **SES-52** While `chad secret request` is waiting in a thread, an owner message there ends the request first and then steers the turn as usual (see 15-credentials.md).
- **SES-53** For a turn a plugin started, an answer that is exactly `[SILENT]` is not posted. In a server thread, the `mention` given to `Turns.start` or `Turns.schedule` goes at the start of the answer, and the core drops a mention whose id is not on the allowlist (see 13-timers-and-cron.md).

## What chad does when a turn starts

The rules in this section are the steps between a request taking the session and the `send` call. Hooks are the functions a plugin registers with `Plugin.prompt`, `Plugin.beforeTurn`, `Plugin.afterTurn` and `Plugin.onSession` (see 06-plugin-api.md).

- **SES-162** Where the first post of the status message sits among the steps of this section, and when its id is written to the `turns` row, are in 04-discord.md.
- **SES-54** A turn that starts while a plugin swap is running waits for the activation, 40 seconds at most, before its `beforeTurn` hooks run and before it builds its Agent (see 08-apply-and-swap.md).
- **SES-55** A session whose generation is behind rebuilds its Agent at the start of its next turn and carries the history and the environment over. A running turn is never interrupted for this, and an idle session does nothing (see 08-apply-and-swap.md).
- **SES-56** chad asks the shared login for a token at the start of every turn, before the session's model layer is built and before `send` (see 05-model-and-login.md).
- **SES-57** Before each turn chad renders every plugin's prompt chunk and compares it with the text the session last saw. The differences go into one `<environment-update>` user message, and the system prompt stays frozen (see 08-apply-and-swap.md).
- **SES-58** A chunk whose render fails or runs past its budget keeps the text the session last saw. It does not count as removed, and no update message is sent for it.
- **SES-130** When chad has posted a failed-turn message, a "Stopped" line or a notice in the thread since the session's last turn that ended `Answered`, the next turn tells the model so in one update message. It is sent the way the chunk update message of SES-57 is sent, and when a chunk change is due on the same turn both go in that one message (see 16-failures-logs-status.md).
- **SES-59** `beforeTurn` hooks run when a turn starts. They do not run for a message that steers a running turn.
- **SES-60** Text that a `beforeTurn` hook returns becomes its own user message in the same `send`, wrapped as `<plugin-context plugin="name">`.
- **SES-61** The messages of one `send` are in this order: the chunk update message, the hook messages in plugin name order, then the turn's prompt.
- **SES-62** Hook text stays in the history until a compaction.
- **SES-63** `Turn.prompt` is what chad sends the model, which includes attachment lines and, for a resumed turn, the restart note. The owner's own words are `turn.origin.message.text`.

```
<plugin-context plugin="asphodel">
(the text the hook returned)
</plugin-context>
```

## When a turn ends

- **SES-64** A turn ends as `Answered`, `Failed` or `Stopped`.
- **SES-131** `Failed` carries a reason, which is one tag of a closed set (see 16-failures-logs-status.md).
- **SES-132** A turn whose answer could not be posted to a thread that still exists ends as `Answered`. A `[SILENT]` answer ends as `Answered` with the text `[SILENT]`, so a plugin can tell, and its `turns` row says `answered`.
- **SES-133** chad itself ends a turn in two cases that clanka would keep retrying, which are a model call that says nothing for 15 minutes and a provider's usage limit. Both end as `Failed` (see 16-failures-logs-status.md).
- **SES-65** `afterTurn` runs once for a turn, after it ends and off the reply path. One plugin's `afterTurn` and `onSession` hooks run one at a time in order, and different plugins run side by side.
- **SES-66** Messages that steered a turn reach `afterTurn` in `TurnEnded.steers` (see 06-plugin-api.md).
- **SES-67** A hook that fails, dies or runs past its budget is logged and skipped, and the turn carries on. The default budgets are 2 seconds for a prompt chunk, 5 for `beforeTurn`, 30 for `afterTurn` and 10 for `onSession`.
- **SES-68** `afterTurn` and `Compacted` hooks are not durable. A hook that is queued when chad is killed is never delivered, which is accepted for v1.

## /stop and the Stop button

- **SES-69** (a) `/stop` interrupts the running turn, which ends as `Stopped`. (b) `afterTurn` still runs.
- **SES-70** Messages that were waiting to steer the stopped turn are dropped, and their requests are answered `Dropped`.
- **SES-71** After a `/stop`, queued plugin turns stay queued and background processes keep running.
- **SES-72** With nothing running, chad posts the notice "Nothing is running."
- **SES-73** A stop reaches the entity as a `stop` request that is not persisted. The reply does not wait for clanka to unwind.
- **SES-74** A click on the Stop button on the status message does what `/stop` does. A click is not a chat event and has no dedupe key, so it goes to the entity as the same `stop` request, and it is acknowledged inside Discord's 3 second interaction deadline.
- **SES-75** A Stop click from anyone who is not an owner is ignored.
- **SES-76** A stopped session is intact. The same Agent takes the next turn, and the stored history of the stopped turn loads into a new Agent.

## /new

- **SES-77** `/new` ends the current `sessions` row and starts a new session in the same thread, with a new session id and a new executor.
- **SES-78** `/new` during a running turn stops that turn first. The old executor's background processes are stopped.
- **SES-138** `/new` reaches the entity as a request that is not persisted, as a stop does.
- **SES-139** The gateway handler waits for the entity to accept the reset, not to finish it, before it returns, so a message sent after `/new` never starts or steers a turn in the old session.
- **SES-140** `/new` answers the messages that were waiting to steer the running turn with `Dropped`, as `/stop` does.
- **SES-141** Queued plugin turns stay queued across `/new` and run in the new session, because a plugin turn belongs to the thread.
- **SES-79** The old session's history stays in SQLite for 30 days and is then pruned (see 02-storage.md). chad never loads it again.
- **SES-80** `/new` tells plugins through `Plugin.onSession` with `Reset { previous, session }`. Plugins get no call that reads a session's history in v1.
- **SES-142** The first turn of the new session does not start until the hooks that each plugin has queued ahead of it, the last of which is `Reset`, have finished or run out of budget. `Reset` has therefore run or timed out before the new session's first `beforeTurn`, so a plugin that flushes its state on `Reset`, such as a memory plugin, has done so when the owner sends `/new` and then asks about the earlier conversation. The doc comment of `onSession` that tells a plugin this is in 06-plugin-api.md.
- **SES-143** For one plugin that wait is at most 10 seconds after a `/new` on an idle session, and at most 30 seconds and then 10 when `/new` stopped a turn, because the stopped turn's `afterTurn` runs before `Reset`. Plugins' queues run side by side, so the wait is that of the slowest plugin, not the sum over plugins.
- **SES-181** The wait of SES-142 and the wait after a compaction (SES-119) are one mechanism. Both hold a turn at the same point, which is after the turn's request has taken the session and before its prompt chunks are rendered and its `beforeTurn` hooks run. SES-120 holds for both. The hooks that the wait is for are not the waiting turn's own. After a `/new` they belong to the old session, and after a compaction they belong to the turn that compacted.
- **SES-182** A `/stop` or a click on the Stop button during that wait ends the wait and stops the turn that was waiting, which ends as `Stopped` under SES-69. The stop ends only the wait. It does not interrupt or shorten the hooks that the wait was for, and each of them runs on until it finishes or its own budget runs out. After a `/new` those hooks are the old session's `Reset` hooks and, when `/new` stopped a turn, that turn's `afterTurn` hooks ahead of them, and they run on because they belong to the old session. A stop during the wait after a compaction works the same way.
- **SES-184** A turn that starts after that stop, while a hook that the wait was for is still running, is held for it in the same way. The stopped turn ran no `beforeTurn`, because the wait sits before it, so what SES-142 says about the new session's first `beforeTurn` holds after a stop too.
- **SES-81** The new session renders its system prompt from scratch, with the plugin chunks folded in (see 08-apply-and-swap.md).
- **SES-82** A cron job belongs to its thread and runs in that thread's current session, so `/new` keeps it (see 13-timers-and-cron.md).
- **SES-83** chad posts the notice "New session started. Nothing from the earlier conversation carries over."
- **SES-144** That notice is posted before the wait of SES-142, not after it.

## What is stored

The two session tables and the `turns` table live in `db/chad.db`. Their columns are in 02-storage.md. This section says what the session runtime writes and when.

- **SES-84** `sessions` has one row per session. It holds the id, the thread, the kind, the created and ended times, clanka's environment, the system prompt last sent, the chunk text last seen, the generation, and a fingerprint, which is a hash of the system prompt as chad would render it now with the plugin chunks left out (see 08-apply-and-swap.md).
- **SES-165** The `kind` of a `sessions` row is read from effect/chat for the session's thread, not from the event that opened the session, because the event of a mention in a plain channel has the kind `channel`.
- **SES-166** A DM session has the kind `direct`, and every session that an owner's message opens in a server has the kind `thread`. On Discord only the session of SES-167 has the kind `channel`.
- **SES-163** chad writes clanka's environment to the `sessions` row in the same transaction as each batch of history rows, and again in the end-of-turn reconcile of SES-134. clanka changes the environment in the middle of a turn when a script changes directory, so a kill there would otherwise restore a history and an environment that disagree.
- **SES-85** `session_messages` is append-only. chad writes to it on every `HistoryAppended` part of the `send` stream. On `HistoryReplaced` it swaps the session's rows in one transaction.
- **SES-134** At the end of every turn, however it ends, chad also makes the stored history equal to the Agent's history, before it records the turn's end. The compare covers the session's whole history, not only what the turn added (see 16-failures-logs-status.md).
- **SES-195** The end-of-turn reconcile matches the messages it writes against the turn's outstanding steers, in order and by text. For each match it writes the `steers` row in the reconcile's transaction, writes `turn.steered` after it and answers the request `Steered`. A steer with no match is answered `Dropped` when the turn was stopped, and starts the next turn otherwise.
- **SES-197** A message the reconcile of SES-195 writes is matched against a steer only when the Agent took it during the turn and no batch delivered it. The turn's own prompt and any message of an earlier turn that the reconcile writes again never match, whatever their text.
- **SES-86** History rows are stored as clanka produced them. chad masks no secret values in them.
- **SES-87** chad keeps the system prompt it last sent, because with Codex the system prompt is not in the history. It sends that text again through the function form of `send({ system })`.
- **SES-88** `turns` has one row per turn request, keyed by the request's key in the column `request_key`. It holds the first attempt's turn id, the session, the origin, the start and end times, the outcome, the failure reason, the status message id, the number of starts, the number of starts that a graceful stop cut, the model and the token usage. The end time and the outcome are null while the turn runs. The usage columns and when chad writes them are in 16-failures-logs-status.md.
- **SES-89** `turns` rows are never deleted. The row is chad's record of what has run. Once `MessageRetention` has pruned a request, cluster delivers a replayed event again, and the `turns` row is what stops a second turn.
- **SES-90** A request whose `turns` row says the turn already ended is answered from the row and starts nothing. The reply has the row's outcome, with the reason of a failed turn read from the row. The row holds no answer text, so a turn that ended `Answered` is answered `Answered` with an empty text. The reply posts nothing in the thread and runs no hook. A caller of `Turns.start` that is still waiting can get this reply only if the entity failed between writing the row and saving the reply (see 06-plugin-api.md).
- **SES-91** A script that a kill cut off leaves no trace in the stored history, because clanka appends a script's call and its result together when the script finishes.
- **SES-137** What chad does when the data volume fills during a turn, including a turn's end that it keeps in memory and writes later, is in 16-failures-logs-status.md.

## Passivation and restore

Passivation is cluster closing an idle entity's activation. Nothing is deleted. The Agent, the executor and the model layer of that session leave memory, and the rows stay. A background task is clanka's term for a process that the agent starts through the executor's task functions and leaves running. The process belongs to the session's executor (see 08-apply-and-swap.md).

- **SES-92** An idle session is passivated after 30 minutes.
- **SES-93** `Entity.keepAlive` holds a session while it has a background task running.
- **SES-94** A turn in flight needs no hold. A turn that runs longer than the idle time is not passivated.
- **SES-95** The next message restores the session from SQLite. chad builds a new Agent, sets its history from `session_messages` and sets its environment from the `sessions` row.
- **SES-192** chad writes the log event `session.passivated` when a session's entity leaves memory, which is after the idle time or when the daemon stops, and `session.restored` when it builds the Agent of a session that has stored history. `session.restored` carries the number of history messages it loaded (see 16-failures-logs-status.md).
- **SES-96** (a) On restore, a fingerprint that matches reuses the frozen system prompt, so the restored session sends the same bytes as before. (b) Reading the cached history on a new connection also needs the session id that chad sends as the `prompt_cache_key` and in the `session-id` header (see 05-model-and-login.md).
- **SES-97** A fingerprint that differs counts as a tool change, and the system prompt is rendered again. The fingerprint differs whenever the render without the chunks differs, which includes a persona change, a safe mode flip and a new image that changes the core block.
- **SES-98** The same restore runs after a restart. A restart also builds a new model layer for the session (see 05-model-and-login.md).
- **SES-168** On the first turn after a restore, the update message of SES-130 carries one line that names the background tasks that died with the process, because the model otherwise waits on tasks that no longer exist.
- **SES-169** chad records which background tasks a session has running, so that a restore can name them.
- **SES-193** chad learns of a background task through the `onTask` callback of the session's `AgentExecutor`, which it wraps. The running tasks are a JSON list of `{ id, kind }` in the `tasks` column of the `sessions` row. A task leaves the list when it ends, and the session holds `Entity.keepAlive` while the list is not empty.

## A turn cut by a restart

A kill is the process ending with no warning, such as SIGKILL, a crash or a power cut. A graceful stop is a shutdown that chad's SIGTERM handler runs. In both cases a turn that was running leaves its request unprocessed, and cluster delivers it again on the next start. chad counts those deliveries itself, in the request's `turns` row.

- **SES-136** Withdrawn.
- **SES-174** Withdrawn.
- **SES-175** Withdrawn.
- **SES-99** When a delivery of a request takes the session, chad adds one to the number of starts in the request's `turns` row before it does anything else for the turn, and so before the hooks and before the model runs. The delivery on which chad gives up is counted too, so a turn that chad gave up on after two kills and no graceful cut has three starts. One delivery is not counted: one that is answered from the row under SES-90, which starts nothing.
- **SES-100** The row keeps the first attempt's turn id and origin. Every later attempt reports them to hooks.
- **SES-101** Every start after the first is a resumed turn, and `Turn.resumed` is `true`. Its prompt is the restart note in place of the original prompt, except in the case of SES-161.
- **SES-161** When the stored history does not hold the turn's prompt, because the kill came before the prompt was stored, a resumed turn sends the original prompt and then the restart note in the same `send`, so that the note is true in every case.
- **SES-102** The restart note says that the process restarted and that a cut-off script's side effects already happened. Given SES-91, it is the only thing that tells the model.
- **SES-103** A resume needs nothing from the owner. Cluster redelivers the request when the daemon starts.
- **SES-200** After a restart, the request of a turn that a kill or a graceful stop cut takes its session first. While a session has a `turns` row with no outcome, every other request waits until that row's request has taken the session, so a message that waited to steer the cut turn steers its resumed start (SES-160).
- **SES-104** A resumed turn edits the status message whose id is stored in the `turns` row (see 04-discord.md).
- **SES-105** A start that a graceful stop cut is recorded in the row before the process exits, and it does not count against the turn. There is no limit on graceful cuts.
- **SES-106** chad gives up on a turn after two starts that ended in a kill. On the next delivery it does not run the model. It ends the turn as `Failed` with the reason `GaveUp`, posts the give-up message below and waits for the owner.
- **SES-202** A start that SIGTERM began to stop and a kill ended before the cut at 15 seconds counts as a kill, so two such restarts in the middle of one turn end it with the give-up of SES-106.
- **SES-107** `beforeTurn` runs again for every resumed start, and the plugin decides what to do with `resumed: true`. `afterTurn` runs once, for the attempt that finishes.
- **SES-108** When chad gives up, `afterTurn` runs once with `Failed`, the first attempt's id and `resumed: true`. `beforeTurn` does not run for the give-up.
- **SES-109** A timer's turn that is cut is resumed like any other turn, as the same scheduled time. It does not start a second turn (see 13-timers-and-cron.md).

The restart note the prototype ran with:

```
[chad restarted while this turn was running. A script that was cut off may already have had its side effects. Check before you repeat anything, then finish the request above.]
```

The give-up message, without the turn id line that ends it (see 16-failures-logs-status.md):

```
This turn was cut off by a crash twice, so I've stopped retrying it. Whatever its scripts already did is done. Send a message to carry on.
```

The table shows how the counts decide what a delivery does. "Start number" is the value of `starts` after the increment of SES-99, so the delivery that gives up has a start number of its own. "Kills so far" is the number of starts before this one, minus the number of starts that a graceful stop cut.

| Start number | Kills so far | What chad does |
| --- | --- | --- |
| 1 | 0 | Runs the turn with the original prompt. |
| 2 or more | 0 or 1 | Runs the turn with the restart note and `resumed: true`. |
| 3 or more | 2 | Gives up, with `afterTurn` once as `Failed`. |

## Graceful stop

This section covers what a graceful stop does to sessions. The whole stop sequence, its 60 second limit and its exit codes are in 01-image-and-volume.md.

- **SES-110** A graceful stop waits up to 15 seconds, which is cluster's `entityTerminationTimeout`, for requests in flight.
- **SES-111** A turn that ends inside those 15 seconds finishes normally and is not redelivered.
- **SES-112** A longer turn is cut at 15 seconds, recorded as a graceful cut (SES-105) and resumed on the next start.
- **SES-201** No turn starts inside the wait of a graceful stop. A request that would start one, a new owner message or a message that waited to steer a turn that ended in the wait, is left unprocessed, and cluster delivers it at the next start.
- **SES-113** A timer whose plugin is not loaded is held inside its request until the plugin comes back. The request stays unprocessed, so a kill redelivers it and it is held again (see 13-timers-and-cron.md).
- **SES-114** A timer held for an unloaded plugin and a plugin turn waiting for an idle session are requests in flight, so a stop with either one takes the full 15 seconds.
- **SES-115** After the wait, chad runs the hooks queued off the reply path, each inside its budget, before it closes the plugins' scopes. The stop's deadline ends this drain 50 seconds after SIGTERM at the latest, and a hook that is still queued then is dropped and logged. The stop's order and its deadline are in 01-image-and-volume.md.
- **SES-173** A graceful stop gives the prune job no wait of its own. What a cut prune leaves behind and how its next run finishes are in 02-storage.md.

## Compaction

Compaction is clanka replacing old history with a summary. clanka starts it in the background at 200k tokens. It runs the summarizer next to one model call and applies the result before a later one. The `HistoryReplaced` part, which clanka emits only from compaction and only on an open `send` stream, is the one signal on the stream that a compaction happened.

- **SES-116** (a) chad always provides clanka's `SummarizerModel` layer, on the same model as the agent (b) unless the summarizer override is set (see 05-model-and-login.md). (a) Without the layer, a summarizer that is still running when its turn ends is cancelled.
- **SES-117** A compaction belongs to the turn whose `send` stream carried `HistoryReplaced`. That can be a later turn than the one that started the summarizer.
- **SES-135** A compaction that the reconcile of SES-134 finds, because the stream did not deliver its `HistoryReplaced`, counts as a compaction of the turn the reconcile ran for, and `Compacted` is delivered for it under SES-118 (see 16-failures-logs-status.md).
- **SES-118** chad delivers `Compacted` to `onSession` hooks once after that turn ends, after the turn's `afterTurn`, even if the turn compacted twice. It never delivers it mid-turn.
- **SES-119** After a turn that compacted, the session's next turn does not start until that turn's queued `afterTurn` and `Compacted` hooks have finished or run out of budget. For one plugin that is at most 30 seconds and then 10, and the wait is that of the slowest plugin, not the sum over plugins.
- **SES-120** A message that arrives during that wait is not lost. It runs afterwards.
- **SES-121** The turn after a compaction renders the system prompt again with the chunks folded in, because clanka drops `<environment-update>` messages when it compacts (see 08-apply-and-swap.md).

```ts
import { Agent } from "clanka"
import * as Compaction from "clanka/Compaction"

Agent.ConversationMode.layer(true)
Compaction.layerSummarizerModel(Model) // adjusted: TIM-543 decision 1, always provided
```

## Measured numbers

These come from the prototype runs and are sizes to test against, not limits chad enforces.

| What | Measured |
| --- | --- |
| A persisted request reaching the entity | 16 ms warm, 111 ms cold |
| Redelivery of a cut request after the next start | 79 ms |
| `/stop` to the turn ending as `Stopped` | 14 ms |
| Stop button acknowledged | 2 to 38 ms, against Discord's 3 s |
| Passivation after `keepAlive` is released (3 s idle time in the test) | 3.8 s |
| Cached input tokens on the first call after a restore | 1792 of 1921, against 1792 of 1897 before passivation |
| Wait before the next turn after a compaction | 272 ms with hooks that return, 39.97 s with one plugin whose hooks hang |
| Idle CPU over 30 s with a 1 s storage poll | 68 and 84 ms, against 20 and 21 ms at 10 s |
| A timer firing late | about 0.6 s at a 1 s poll, 6 to 10 s at 10 s |
| Graceful stop with a turn running | 15.0 s in the entity layers |
| Idle close of `SingleRunner` | 9 to 53 ms at 1 shard, about 2 s at 300 |

## Gaps

- **SES-G8** [builder] The wording of the restart note. The tickets fix what it says, and the text shown above is the prototype's. TIM-532 item 13.
- **SES-G18** [builder] The wording of the reply that `/new` and `/stop` give in a plain channel with no session (SES-148). The TIM-559 ruling on SES-G3 fixes what it says and gives no text.
- **SES-G19** [builder] What an attachment id is, which operation turns one into the file's bytes on Discord and on the local platform, and what a turn does when that download fails, for example because a redelivered request finds the URL expired (SES-43, SES-151, SES-154). Recommended: the id is the attachment's id from the stored chat message, the chat adapter has a download operation that the local platform implements too, on Discord it fetches the attachment's URL through the `HttpClient` given to `runDaemon`, and sizes are read from the message before any download. When a download fails the turn carries on, the prompt gets a line about the file as it does under SES-42, and the owner sees a notice in the form of the skipped-file notice in 04-discord.md.
- **SES-G20** [builder] What counts as an image under SES-40, and whether the 10 MB and 25 MB limits are decimal or binary. Recommended: an attachment whose declared content type is PNG, JPEG, GIF or WebP is an image and every other type is saved under `inbox/`, and both limits are binary, as the limit on a file that chad sends is (see 04-discord.md).
- **SES-G21** [builder] The name a file gets under `inbox/` (SES-41, SES-154). The question and its recommendation are a gap of 02-storage.md, which owns the layout of a session's directory.
- **SES-G22** [builder] How a scenario sees that a session was passivated or restored (SES-92 to SES-95). No log event, no field of `chad status` and nothing in a model request shows it. Recommended: two log events, `session.passivated` and `session.restored`, added to the event list of 16-failures-logs-status.md as new rules.
- **SES-G23** [builder] How chad learns that a background task started or ended, what it records about a running one, and when the record is cleared (SES-93, SES-168, SES-169). Recommended: wrap the session's `AgentExecutor` (see 08-apply-and-swap.md), keep the ids and commands of the running tasks as JSON in a new column of the `sessions` row (see 02-storage.md for how a column is added), hold `Entity.keepAlive` while the list is not empty, and take a task off the list when it ends.
- **SES-G24** [builder] How chad knows that an event is a second delivery, so that it can write `message.ignored` with the reason `duplicate` (SES-180). Cluster drops the request by its primary key (SES-33), and the gateway handler does not read a reply (SES-31). Recommended: write it in the gateway handler when the save reports that the request already exists, and in the entity when SES-90 or SES-158 answers from a row, and not for an event that Discord sends again because its first save failed.
- **SES-G25** [builder] What the reconcile of SES-134 does with a steering message that the Agent holds and that no `HistoryAppended` batch delivered, which a stop can cause. The rules do not say whether its `steers` row and `turn.steered` are written, or whether its request is answered `Steered` or `Dropped` (SES-70, SES-157, SES-178). Recommended: run the match of SES-178 inside the reconcile's transaction, write the row and the event there, and answer `Steered`.
- **SES-G26** [builder] What an owner's first message does in an existing Discord thread that has no session. SES-7 covers a DM, a plain channel and a thread that already has a session. Recommended: it needs a mention, a message without one is dropped with the reason `not-mentioned`, and the session is that thread itself with no new thread opened. TIM-532 item 5.
- **SES-G27** [builder] What `/new` and `/stop` do as the first message in a DM or a thread that has no `sessions` row. SES-148 covers only a plain channel. Recommended: `/stop` posts "Nothing is running." and creates no row, and `/new` creates the first row and posts its notice.
- **SES-G28** [builder] What an owner's message in a plain server channel does in a build that has the `harness` slice and not yet the `turns` slice, which delivers the mention rule (SES-3, SES-7). The `wire` slice puts that build on a real gateway. Recommended: until `turns` is delivered, chad answers in DMs and in Discord threads only and drops every other message.
- **SES-G29** [builder] Which request takes the session first after a restart, when cluster redelivers a cut turn's request together with the owner messages that were waiting to steer it. SES-160 assumes that the cut turn does. Recommended: while a session has a running `turns` row with no later row, every other request waits until that row's request has taken the session.
- **SES-G30** [builder] What a start counts as when SIGTERM arrived and the process was killed before the cut at 15 seconds, as happens under Docker's default stop timeout of 10 seconds. SES-105 and SES-112 record a graceful cut only at the cut, so two such restarts in the middle of one turn end it with the give-up message. Recommended: it counts as a kill, as the rules read now, and the 90 second grace period of the examples in 01-image-and-volume.md is what keeps a restart graceful.
- **SES-G31** [builder] What happens to a request that would start a turn during the 15 second wait of a graceful stop. That is a new owner message, or a message that was waiting to steer a turn that ends inside the wait (SES-44, SES-46, SES-111). Recommended: chad starts no turn for it and leaves the request unprocessed, so that cluster delivers it on the next start.
- **SES-G32** [builder] What "active in the past 7 days" means for the catch-up of SES-37, and whether a session that `/new` ended counts. The `sessions` row holds the mark of SES-170 and no time. Recommended: a session that has not ended and whose last handled owner message is under 7 days old, with that time stored beside the mark.
- **SES-G33** [builder] Whether a stored request that no longer decodes (SES-152) gets a `turns` row and a turn id, which the failed-turn message uses. Recommended: a row keyed by the request's key with a fresh turn id, no start counted, the reason `Internal`, and a message with a duration of zero.
- **SES-G34** [builder] How a test provokes the defect of SES-20 from outside the core. Recommended: a fake model response that makes clanka die, with the test asserting that the next message is answered, that a background process started earlier is still alive, and that the request does not come back after a restart.

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| SES-1 | TIM-532 item 1 | Tim | read |  | `rule` | `harness` |
| SES-2 | TIM-532 item 1 | Tim | read |  | `rule` | `harness` |
| SES-3 | TIM-532 item 1 | Tim | read |  | `rule` | `turns` |
| SES-4 | TIM-532 item 1 | Tim | read |  | `rule` | `wire` |
| SES-5 | TIM-532 item 1, TIM-533 item 12 | Tim | read |  | `rule` | `turns` |
| SES-6 | Map "Agreed at charting", TIM-532 item 5 | Tim | read |  | `rule` | `harness` |
| SES-7 | TIM-532 item 5 | Tim | read |  | `rule` | `turns` |
| SES-8 | TIM-532 item 5 and "Passed on", TIM-559 cold read | Tim | read |  | `fact` | `wire` |
| SES-9 | TIM-532 item 11 | Tim | read |  | `rule` | `turns` |
| SES-10 | TIM-532 item 12, TIM-536 item 15 | Tim | read |  | `rule` | `turns` |
| SES-11 | TIM-536 item 10, TIM-531 item 4 | Tim | read |  | `rule` | `plugin-api` |
| SES-12 | Map "Out of scope", TIM-532 body | charting | not run |  | `definition` | - |
| SES-13 | TIM-532 item 2, TIM-543 | Tim | run |  | `rule` | `harness` |
| SES-14 | TIM-532 item 2 | Tim | run |  | `rule` | `harness` |
| SES-15 | TIM-532 item 2, TIM-540 item 12, amended by TIM-559 ruling on API-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-16 | TIM-540 item 12, TIM-532 "Not settled here" | Tim | run |  | `rule` | `timers-cron` |
| SES-17 | TIM-532 item 2 | Tim | run |  | `rule` | `harness` |
| SES-18 | TIM-532 item 4 | Tim | run |  | `rule` | `turns` |
| SES-19 | TIM-532 body and "How well each is supported", TIM-543 | Tim | run |  | `rule` | `turns` |
| SES-20 | TIM-532 item 2, TIM-543, TIM-559 cold read | Tim | run |  | `rule` | `kills` |
| SES-21 | TIM-532 item 2 | Tim | run |  | `rule` | `turns` |
| SES-22 | TIM-543 "Facts the spec can rely on" | Tim | run |  | `rule` | `timers-cron` |
| SES-23 | TIM-543 | Tim | run |  | `fact` | `harness` |
| SES-24 | TIM-543 decision 2 | Tim | run |  | `rule` | `timers-cron` |
| SES-25 | TIM-553 decision 4, comment on TIM-543 | Architect (Tim has not read) | run | TIM-553 | `rule` | `harness` |
| SES-26 | TIM-553 decision 4 | Architect (Tim has not read) | run | TIM-553 | `rule` | `harness` |
| SES-27 | TIM-553 decision 4, TIM-559 cold read | Architect (Tim has not read) | not run | TIM-553 | `definition` | - |
| SES-28 | TIM-536 "How well each is supported", TIM-543 body | Tim | read |  | `fact` | `cli` |
| SES-29 | TIM-536 item 14, amended by TIM-557 items 27 and 35 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| SES-30 | TIM-532 item 3, map "Facts found at charting" | Tim | read |  | `rule` | `wire` |
| SES-31 | TIM-532 item 3 | Tim | read |  | `rule` | `turns` |
| SES-32 | TIM-532 item 3, amended by TIM-557 item 32, TIM-559 cold read | Architect (Tim has not read) | not run | TIM-557 | `rule` | `wire` |
| SES-33 | TIM-532 item 2, TIM-543 finding 4 | Tim | run |  | `rule` | `harness` |
| SES-34 | TIM-532 item 6 | Tim | read |  | `rule` | `turns` |
| SES-35 | TIM-542 item 22 | Tim | read |  | `rule` | `apply` |
| SES-36 | TIM-546 item 15, comment on TIM-532 | Architect (Tim has not read) | not run | TIM-546 | `rule` | `settings` |
| SES-37 | TIM-532 item 14 | Tim | read |  | `rule` | `kills` |
| SES-38 | TIM-532 "How well each is supported" | Tim | read |  | `rule` | `wire` |
| SES-39 | TIM-532 item 14 | Tim | read |  | `definition` | - |
| SES-40 | TIM-532 item 15 | Tim | read |  | `rule` | `turns` |
| SES-41 | TIM-532 item 15, TIM-536 item 10 | Tim | read |  | `rule` | `turns` |
| SES-42 | TIM-532 item 15, TIM-533 item 12 | Tim | read |  | `rule` | `turns` |
| SES-43 | TIM-532 item 15 | Tim | read |  | `rule` | `turns` |
| SES-44 | TIM-532 item 4 | Tim | run |  | `rule` | `harness` |
| SES-45 | TIM-532 item 4, map "Agreed at charting" | Tim | run |  | `rule` | `turns` |
| SES-46 | TIM-532 item 4 | Tim | run |  | `rule` | `turns` |
| SES-47 | TIM-543, comment on TIM-532 | Tim | run |  | `rule` | `turns` |
| SES-48 | TIM-532 item 4 | Tim | run |  | `rule` | `plugin-api` |
| SES-49 | TIM-540 item 13, TIM-543, amended by TIM-559 ruling on API-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-50 | TIM-532 item 4 | Tim | run |  | `rule` | `harness` |
| SES-51 | TIM-552 comment on TIM-543, TIM-552 question 1 (Tim agreed on the ticket) | Tim | run |  | `rule` | `turns` |
| SES-52 | TIM-546 item 12, comment on TIM-532 | Architect (Tim has not read) | run | TIM-546 | `rule` | `settings` |
| SES-53 | TIM-540 items 14 and 15, amended by TIM-559 ruling on CRON-G11 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-54 | TIM-547 item 12, TIM-552 decision 5 (Tim agreed the TIM-552 part) | Architect (Tim has not read) | run | TIM-547 | `rule` | `apply` |
| SES-55 | TIM-531 item 1 | Tim | run |  | `rule` | `plugin-api` |
| SES-56 | TIM-535 "Login", TIM-544 decision 3 | Tim | run |  | `rule` | `models` |
| SES-57 | TIM-531 item 3 | Tim | run |  | `rule` | `plugin-api` |
| SES-58 | TIM-539 item 5, TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| SES-59 | TIM-532 item 9 | Tim | read |  | `rule` | `plugin-api` |
| SES-60 | TIM-532 item 9 | Tim | read |  | `rule` | `plugin-api` |
| SES-61 | TIM-532 item 9 | Tim | read |  | `rule` | `plugin-api` |
| SES-62 | TIM-532 item 9 | Tim | read |  | `rule` | `plugin-api` |
| SES-63 | TIM-539 "In the prototype, without a separate yes" | Tim | run |  | `rule` | `plugin-api` |
| SES-64 | TIM-530 "The API", TIM-540 | Tim | run |  | `rule` | `turns` |
| SES-65 | TIM-530 "In the API Tim reviewed", TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| SES-66 | TIM-530 "The API", TIM-539 body | Tim | read |  | `rule` | `plugin-api` |
| SES-67 | TIM-530 "Decided by Tim", TIM-543 decision 5 | Tim | run |  | `rule` | `plugin-api` |
| SES-68 | TIM-539 item 8 and "Not settled here" | Tim | run |  | `rule` | `plugin-api` |
| SES-69 | TIM-532 item 8 | Tim | run |  | `rule` | `turns` |
| SES-70 | TIM-532 item 8, TIM-543 | Tim | run |  | `rule` | `turns` |
| SES-71 | TIM-532 item 8 | Tim | read |  | `rule` | `plugin-api` |
| SES-72 | TIM-532 item 8, TIM-533 item 12 | Tim | run |  | `rule` | `turns` |
| SES-73 | TIM-543 | Tim | run |  | `rule` | `turns` |
| SES-74 | TIM-533 item 8, TIM-543 | Tim | run |  | `rule` | `discord-ui` |
| SES-75 | TIM-533 item 8 | Tim | read |  | `rule` | `discord-ui` |
| SES-76 | TIM-543 | Tim | run |  | `rule` | `turns` |
| SES-77 | TIM-532 item 7 | Tim | read |  | `rule` | `turns` |
| SES-78 | TIM-532 item 7 | Tim | read |  | `rule` | `turns` |
| SES-79 | TIM-532 item 7, TIM-536 item 15 | Tim | read |  | `rule` | `backup` |
| SES-80 | Map "Agreed at charting", TIM-530 "The API", TIM-539 item 7 | Tim | read |  | `rule` | `plugin-api` |
| SES-81 | TIM-531 item 3 | Tim | read |  | `rule` | `plugin-api` |
| SES-82 | TIM-540 items 1 and 4 | Tim | read |  | `rule` | `timers-cron` |
| SES-83 | TIM-533 item 12 | Tim | read |  | `rule` | `turns` |
| SES-84 | TIM-532 item 11, amended by TIM-559 ruling on SWAP-G2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-85 | TIM-532 item 11 | Tim | run |  | `rule` | `turns` |
| SES-86 | TIM-554 decision 2 and its comment on TIM-536, which overrides the TIM-546 comment on TIM-532 | Tim | not run |  | `rule` | `turns` |
| SES-87 | TIM-531 body and facts, TIM-543 | Tim | run |  | `rule` | `turns` |
| SES-88 | TIM-536 item 11, amended by TIM-543, TIM-557 item 23 and TIM-559 ruling on STO-G11 and FAIL-G11 | Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `turns` |
| SES-89 | TIM-543 "Facts the spec can rely on", TIM-536 item 15 | Tim | run |  | `rule` | `turns` |
| SES-90 | TIM-543 finding 4, TIM-559 cold read, TIM-559 round 5 item 7 | Tim | run |  | `rule` | `turns` |
| SES-91 | TIM-543 "Facts the spec can rely on" | Tim | run |  | `fact` | `kills` |
| SES-92 | TIM-532 item 12 | Tim | run |  | `rule` | `turns` |
| SES-93 | TIM-532 item 12 | Tim | run |  | `rule` | `turns` |
| SES-94 | TIM-543 | Tim | run |  | `fact` | `turns` |
| SES-95 | TIM-532 items 11 and 12 | Tim | run |  | `rule` | `turns` |
| SES-96 | TIM-532 item 11, TIM-543, TIM-544 decision 1 | Tim | run |  | `rule` | `turns` |
| SES-97 | TIM-532 item 11, amended by TIM-559 ruling on SWAP-G2 | Architect (Tim has not read) | not run | TIM-549, TIM-559 | `rule` | `plugin-api` |
| SES-98 | TIM-532 item 12, TIM-544 decision 2 | Tim | read |  | `rule` | `kills` |
| SES-99 | TIM-543, comment on TIM-532, TIM-559 cold read, TIM-559 round 5 item 8, amended by Jarvis's correction to Tim's ruling on a full disk, TIM-560 2026-11-15 | Tim | run |  | `rule` | `kills` |
| SES-100 | TIM-539 item 4, TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| SES-101 | TIM-532 item 13, TIM-543 decision 3, amended by TIM-559 ruling on SES-G9 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `kills` |
| SES-102 | TIM-532 item 13, TIM-543 "Facts the spec can rely on" | Tim | run |  | `rule` | `kills` |
| SES-103 | TIM-543 | Tim | run |  | `rule` | `kills` |
| SES-104 | TIM-533 "Passed on", TIM-536 body | Tim | read |  | `rule` | `discord-ui` |
| SES-105 | TIM-543 decision 3 | Tim | run |  | `rule` | `kills` |
| SES-106 | TIM-543 decision 3, TIM-532 item 13, TIM-533 item 12, amended by TIM-557 items 12 and 14 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `kills` |
| SES-107 | TIM-539 item 4, TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| SES-108 | TIM-539 item 4, TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| SES-109 | TIM-543 comment on TIM-540 | Tim | run |  | `rule` | `timers-cron` |
| SES-110 | TIM-543 "Facts the spec can rely on", comment on TIM-532 | Tim | run |  | `rule` | `kills` |
| SES-111 | TIM-543 "Facts the spec can rely on" | Tim | run |  | `rule` | `kills` |
| SES-112 | TIM-543 decision 3, comment on TIM-532 | Tim | run |  | `rule` | `kills` |
| SES-113 | TIM-543 decision 4 | Tim | run |  | `rule` | `timers-cron` |
| SES-114 | TIM-543 decision 4, TIM-547 body | Tim | run |  | `rule` | `timers-cron` |
| SES-115 | TIM-539 item 8, TIM-543, amended by TIM-541 item 25, TIM-553 question 1 and TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run | TIM-541, TIM-553, TIM-559 | `rule` | `plugin-api` |
| SES-116 | TIM-543 decision 1, TIM-535 "Model" | Tim | run |  | `rule` | `turns` |
| SES-117 | TIM-543 decision 1 | Tim | run |  | `rule` | `failures` |
| SES-118 | TIM-532 item 10 | Tim | run |  | `rule` | `plugin-api` |
| SES-119 | TIM-539 item 6, TIM-543 decisions 1 and 5 | Tim | run |  | `rule` | `plugin-api` |
| SES-120 | TIM-543 | Tim | run |  | `rule` | `plugin-api` |
| SES-121 | TIM-531 item 3 and its TIM-539 comment | Tim | read |  | `rule` | `plugin-api` |
| SES-122 | TIM-558 item 40 and its comment on TIM-532 | Architect (Tim has not read) | not run | TIM-558 | `rule` | `harness` |
| SES-123 | TIM-558 item 40 and its comment on TIM-532, TIM-559 cold read | Architect (Tim has not read) | not run | TIM-558 | `rule` | `harness` |
| SES-124 | TIM-558 item 40 and its comment on TIM-532, TIM-559 cold read | Architect (Tim has not read) | not run | TIM-558 | `rule` | `harness` |
| SES-125 | TIM-557 item 34 and its comments on TIM-530 and TIM-540 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| SES-126 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| SES-127 | TIM-557 item 32 and its comment on TIM-532 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| SES-128 | TIM-557 "What this changes in closed tickets" and its comment on TIM-532, TIM-559 cold read | Architect (Tim has not read) | read | TIM-557 | `fact` | `wire` |
| SES-129 | TIM-558 items 26, 27 and 36 and its comment on TIM-532, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Architect (Tim has not read) | not run | TIM-558 | `definition` | - |
| SES-130 | TIM-557 item 30 and its comment on TIM-532 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| SES-131 | TIM-557 item 12 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| SES-132 | TIM-557 item 13 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| SES-133 | TIM-557 items 18 and 20 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `models` |
| SES-134 | TIM-557 item 29 and its comment on TIM-532, TIM-559 cold read | Architect (Tim has not read) | not run | TIM-557 | `rule` | `turns` |
| SES-135 | TIM-557 item 29 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `plugin-api` |
| SES-136 | TIM-557 item 34 and its comment on TIM-532, withdrawn by Jarvis's correction to Tim's ruling on a full disk, TIM-560 2026-11-15 | Architect (Tim has not read) | not run | TIM-557 | `rule` | - |
| SES-137 | TIM-557 item 33 | Architect (Tim has not read) | not run |  | `definition` | - |
| SES-138 | TIM-559 ruling on SES-G1 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-139 | TIM-559 ruling on SES-G1 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-140 | TIM-559 ruling on SES-G1 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-141 | TIM-559 ruling on SES-G1 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| SES-142 | TIM-559 ruling on SES-G2, TIM-559 round 3 C1 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-143 | TIM-559 ruling on SES-G2, TIM-559 round 3 C1 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-144 | TIM-559 ruling on SES-G2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-145 | TIM-559 ruling on SES-G3 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-146 | TIM-559 ruling on SES-G3 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-147 | TIM-559 ruling on SES-G3 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `turns` |
| SES-148 | TIM-559 ruling on SES-G3 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `turns` |
| SES-149 | TIM-559 ruling on SES-G4 | Architect (Tim has not read) | read |  | `rule` | `harness` |
| SES-150 | TIM-559 ruling on SES-G4 and CRON-G3 | Architect (Tim has not read) | not run |  | `rule` | `timers-cron` |
| SES-151 | TIM-559 ruling on SES-G5 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| SES-152 | TIM-559 ruling on SES-G5 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| SES-153 | TIM-559 ruling on SES-G5 | Architect (Tim has not read) | not run |  | `fact` | `failures` |
| SES-154 | TIM-559 ruling on SES-G6 | Architect (Tim has not read) | read | TIM-559 | `rule` | `turns` |
| SES-155 | TIM-559 ruling on SES-G6, TIM-559 cold read | Architect (Tim has not read) | not run | TIM-559 | `rule` | `turns` |
| SES-156 | TIM-559 ruling on SES-G7 and STO-G12 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-157 | TIM-559 ruling on SES-G7 and STO-G12, TIM-559 round 2 R3 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-158 | TIM-559 ruling on SES-G7 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| SES-159 | TIM-559 ruling on SES-G7 and STO-G12 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-160 | TIM-559 ruling on SES-G7, TIM-559 round 2 R3 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| SES-161 | TIM-559 ruling on SES-G9 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-162 | TIM-559 ruling on SES-G10 and DIS-G8 | Architect (Tim has not read) | not run |  | `definition` | - |
| SES-163 | TIM-559 ruling on SES-G11 | Architect (Tim has not read) | read |  | `rule` | `turns` |
| SES-164 | TIM-559 ruling on SES-G12 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| SES-165 | TIM-559 ruling on SES-G13 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-166 | TIM-559 ruling on SES-G13 and API-G7, TIM-559 round 3 C6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `turns` |
| SES-167 | TIM-559 ruling on API-G7, TIM-559 round 3 C6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-168 | TIM-559 ruling on SES-G14 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| SES-169 | TIM-559 ruling on SES-G14 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-170 | TIM-559 ruling on SES-G15 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| SES-171 | TIM-559 ruling on SES-G15 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-172 | TIM-559 ruling on SES-G15 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-173 | TIM-559 ruling on SES-G16, IMG-G8 and STO-G25 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| SES-174 | TIM-559 ruling on SES-G17 and FAIL-G6, withdrawn by Jarvis's correction to Tim's ruling on a full disk, TIM-560 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| SES-175 | TIM-559 ruling on SES-G17 and FAIL-G6, withdrawn by Jarvis's correction to Tim's ruling on a full disk, TIM-560 2026-11-15 | Architect (Tim has not read) | not run |  | `rule` | - |
| SES-176 | TIM-559 round 2 R3, read at clanka 0.28.0 `src/Agent.ts:1144-1157` and `1529-1535` | Architect (Tim has not read) | read |  | `fact` | `turns` |
| SES-177 | TIM-559 round 2 R3, read at clanka 0.28.0 `src/Agent.ts:1144-1157` and `1529-1535` | Architect (Tim has not read) | read |  | `fact` | `turns` |
| SES-178 | TIM-559 round 2 R3 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-179 | TIM-559 round 2 R3 and R4 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-180 | TIM-559 round 2 R4 | Architect (Tim has not read) | not run |  | `rule` | `turns` |
| SES-181 | TIM-559 round 3 C1, TIM-543 for where the wait after a compaction sits, TIM-559 round 4 item 4 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-182 | TIM-559 round 3 C1, TIM-559 round 4 item 4 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-183 | TIM-559 round 3 C6, TIM-559 round 4 item 5 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-184 | TIM-559 round 3 C1 for what holds before the new session's first `beforeTurn`, TIM-559 round 4 item 4 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `plugin-api` |
| SES-185 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `wire` |
| SES-186 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-187 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-188 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-189 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-190 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-191 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-192 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-193 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-194 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-195 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-196 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-197 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-198 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| SES-199 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `kills` |
| SES-200 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `kills` |
| SES-201 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `kills` |
| SES-202 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `kills` |
| SES-203 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `kills` |
| SES-204 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `kills` |
