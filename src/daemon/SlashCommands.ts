import { ChatInteraction } from "effect/chat"
import * as Messages from "../Messages.ts"

/**
 * The chat commands as the platform's slash commands. Each does what the typed command of the same name does, and
 * the typed commands still work. `Handler.interactions` answers them, and the Discord connection registers them with
 * Discord when it starts.
 */
export const New = ChatInteraction.command("new", {
  description: Messages.commandDescriptions.new,
})

export const Stop = ChatInteraction.command("stop", {
  description: Messages.commandDescriptions.stop,
})

export const Status = ChatInteraction.command("status", {
  description: Messages.commandDescriptions.status,
})

export const Model = ChatInteraction.command("model", {
  description: Messages.commandDescriptions.model,
  argument: { name: "setting", description: Messages.commandArguments.model },
})

export const Safe = ChatInteraction.command("safe", {
  description: Messages.commandDescriptions.safe,
  argument: { name: "mode", description: Messages.commandArguments.safe },
})

/** Every slash command, in the order the platform lists them. */
export const all = ChatInteraction.group(New, Stop, Status, Model, Safe)
