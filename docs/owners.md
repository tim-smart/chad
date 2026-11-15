# Owners

chad answers its owners and no one else. An owner is a user id on the allowlist of a chat connection, and each
connection has its own list.

A message from an id that is not on the list starts nothing. chad does not answer it and does not keep it, and the log
gets one `message.ignored` line with the reason `not-owner` and the author's id. That line is the first place to look
when chad stays silent after setup, because a wrong owner id shows up there.

The list is by id and nothing else. An id on it is an owner whether it belongs to a person or to a bot. A webhook id on
the list makes everyone who holds the webhook URL an owner.

chad never answers its own messages, even when its own id is on the list.
