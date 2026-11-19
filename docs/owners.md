# Owners

chad answers its owners and no one else. An owner is a user id on the allowlist of a chat connection, and each
connection has its own list.

A message from an id that is not on the list starts nothing. chad does not answer it and does not keep it, and the log
gets one `message.ignored` line with the reason `not-owner` and the author's id. That line is the first place to look
when chad stays silent after setup, because a wrong owner id shows up there.

The list is by id and nothing else. An id on it is an owner whether it belongs to a person or to a bot. A webhook id on
the list makes everyone who holds the webhook URL an owner.

chad never answers its own messages, even when its own id is on the list.

## Channels that need no mention

In a server channel an owner's message needs a mention of chad, and chad opens a thread on it. A direct message and a
thread that already has a session need none. A connection can also list channels where an owner's message needs no
mention either:

```sh
chad channel add <connection> <channel-id>
chad channel remove <connection> <channel-id>
```

The id is the one the platform sends with a message. For Discord it is the channel id, which you copy with Developer
Mode on. A thread id works too. In a listed channel an owner's message is read as if it mentioned chad, so each one
opens a thread of its own, as a mention does. Every other channel keeps needing a mention.

An owner can do the same from chat, in the channel itself. `/mention off` puts the channel or thread it runs in on its
connection's list, `/mention on` takes it off again, and `/mention` alone says which holds. It works as a slash command
and typed. Typed in a channel that still needs a mention, it needs one itself, as in `@chad /mention off`. It changes
only that channel, and only on the connection it came in on. In a direct message it changes nothing, because a direct
message needs no mention. In a thread that has a session `/mention on` takes the thread off the list, but the thread
still needs no mention, and chad says so. A `/mention` that is still waiting when its connection is swapped, by a
token change or a remove and add, or when its sender stops being an owner, changes nothing.

The list is off by default, and it changes nothing about who chad answers: a message from someone who is not an owner
is still ignored with the reason `not-owner`, in a listed channel too. The change applies at the next message, with no
restart. `chad connection list` shows each connection's channels after its owners, and the list is kept with the
connection in `secrets/connections.json`.
