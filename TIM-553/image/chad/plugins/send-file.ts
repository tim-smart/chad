// Stand-in for a bundled plugin in one file. The agent reads this at /data/repo/examples/send-file.ts.
import { Plugin } from "chad"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const tools = Toolkit.make(
  Tool.make("sendFile", {
    description: "Send a file from the session's directory to the owner.",
    parameters: Schema.Struct({ path: Schema.String }),
    success: Schema.String
  })
)

export default Plugin.make(
  Plugin.toolkit(tools, { sendFile: ({ path }: { readonly path: string }) => Effect.succeed("sent " + path) })
)
