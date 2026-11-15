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
