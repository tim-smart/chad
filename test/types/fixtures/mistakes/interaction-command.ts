// One of the six deliberate mistakes a plugin can make. It must fail to compile.
import { ChatInteraction } from "effect/chat"
import { Effect } from "effect"
import { Plugin } from "chad"

const Deploy = ChatInteraction.command("deploy", { description: "Deploys." })

// A slash command among a plugin's buttons.
export default Plugin.make(
  Plugin.interactions(ChatInteraction.group(Deploy), {
    deploy: () => Effect.succeed(ChatInteraction.respond({ markdown: "no" })),
  }),
)
