import { join } from "node:path"
import { Effect, FileSystem, Stream } from "effect"
import { Prompt } from "effect/ai"
import type { ChatMessage } from "effect/chat"
import * as Messages from "../Messages.ts"
import type { ChatService } from "./Chats.ts"
import type { Format } from "./Format.ts"

/**
 * The files on an owner's message. An image on a message that starts a turn goes to the model, and every other file
 * is saved under `inbox/` in the session's directory with its path in the prompt. A message that steers a running
 * turn has every file saved, images included, because clanka's `steer` takes a string.
 */

/** The largest image that goes to the model, and the largest file chad takes at all. Both are binary. */
export const imageLimit = 10 * 1024 * 1024
export const fileLimit = 25 * 1024 * 1024

/** The content types that count as an image. */
const images = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** The name a file gets under `inbox/`: the message's id and the file's own name, reduced to what is safe in a path. */
export const inboxName = (message: string, name: string | undefined) => {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, "_")
  const file = safe(name ?? "").replace(/^\.+/, "")
  return `${safe(message)}-${file === "" ? "file" : file}`
}

export interface Read {
  /** The message's text, followed by a line for each file that did not go to the model as an image. */
  readonly text: string
  readonly images: ReadonlyArray<Prompt.FilePart>
  /** What the owner is told about the files chad skipped. */
  readonly notices: ReadonlyArray<string>
}

/** The prompt of a message that starts a turn. */
export const prompt = (
  read: Read,
  options: Prompt.ProviderOptions = {},
): Prompt.Message =>
  Prompt.userMessage({
    content: [Prompt.textPart({ text: read.text }), ...read.images],
    options,
  })

/**
 * Downloads the files of a message. `asImages` says whether an image may go to the model, which it may on a message
 * that starts a turn. A file that is too large is not downloaded, and one whose download fails is skipped the same
 * way, so the turn carries on.
 */
export const read = Effect.fnUntraced(function* (options: {
  readonly chat: ChatService
  /** The formatter of the connection's platform, which writes the notices. */
  readonly format: Format
  readonly message: ChatMessage.ChatMessage
  /** The ids of the attachments the stored request names. */
  readonly attachments: ReadonlyArray<string>
  readonly directory: string
  readonly asImages: boolean
}) {
  const { message } = options
  const fs = yield* FileSystem.FileSystem
  const lines: Array<string> = []
  const parts: Array<Prompt.FilePart> = []
  const notices: Array<string> = []
  for (const attachment of message.attachments) {
    if (!options.attachments.includes(attachment.id)) continue
    const name = attachment.name ?? "file"
    if (attachment.size !== undefined && attachment.size > fileLimit) {
      lines.push(Messages.promptFileSkipped(name, attachment.size))
      notices.push(Messages.fileSkipped(options.format, name, attachment.size))
      continue
    }
    const bytes = yield* options.chat
      .download(message.thread, attachment, { maxBytes: fileLimit })
      .pipe(
        Stream.runCollect,
        Effect.map((chunks) => Buffer.concat(chunks)),
        Effect.catch(() => Effect.undefined),
      )
    if (bytes === undefined) {
      lines.push(Messages.promptFileFailed(name))
      notices.push(Messages.fileFailed(options.format, name))
      continue
    }
    const type = attachment.contentType?.split(";")[0]?.trim().toLowerCase()
    if (
      options.asImages &&
      type !== undefined &&
      images.has(type) &&
      bytes.length <= imageLimit
    ) {
      parts.push(
        Prompt.filePart({
          mediaType: type,
          fileName: name,
          data: new Uint8Array(bytes),
        }),
      )
      continue
    }
    // The path is absolute, because the Agent's working directory moves with every `cd` and the inbox does not. The
    // session's directory is resolved already, also when CHAD_DATA is relative.
    const inbox = join(options.directory, "inbox")
    const path = join(inbox, inboxName(message.id, attachment.name))
    // A save that fails is a defect, so the turn fails as `Internal`, on a full disk too.
    yield* fs
      .makeDirectory(inbox, { recursive: true })
      .pipe(Effect.andThen(fs.writeFile(path, bytes)), Effect.orDie)
    lines.push(Messages.promptFileSaved(name, path))
  }
  const read: Read = {
    text: [message.text, ...lines].filter((line) => line !== "").join("\n\n"),
    images: parts,
    notices,
  }
  return read
})
