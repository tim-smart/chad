// Stand-in for a bundled plugin in a directory. The agent reads this at /data/repo/examples/cron/.
import { Plugin } from "chad"
import * as Effect from "effect/Effect"
import { nextRun } from "./schedule.ts"

export default Plugin.make(
  Plugin.background(Effect.sync(() => nextRun("0 8 * * *")))
)
