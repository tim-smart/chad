// Every command but `serve`. This file is the entry of the one bundled file, and it hands `runCli` the real outside
// world.
import { FetchHttpClient } from "effect/http"
import { runCli } from "./cli/runCli.ts"
import { defaults } from "./Timings.ts"

process.exitCode = await runCli({
  args: process.argv.slice(2),
  httpClient: FetchHttpClient.layer,
  timings: defaults,
})
// The command has ended. A read of standard input it left, such as `chad restore -` done or ended by a signal before the
// producer closed the pipe, would keep Node running until that EOF.
process.stdin.destroy()
