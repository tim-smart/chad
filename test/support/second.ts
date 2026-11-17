// The entry of the image layer's second container. It holds the local platform and the fake model server, and serves
// the test-only requests beside the adapter's at `run/local.sock`. The image tests bundle it into one file, which is
// all of the repository that container is given.
import { join } from "node:path"
import { Effect, Layer } from "effect"
import * as LocalChat from "../../dist/daemon/LocalChat.js"
import * as Fakes from "./fakes.ts"
import * as Model from "./model.ts"
import * as Platform from "./platform.ts"

/** The event log, one JSON object to a line on standard output, which the engine keeps as the container's log. */
const record = (kind: string, fields: object) =>
  console.log(JSON.stringify({ at: Date.now(), kind, ...fields }))

const path = join(process.env["CHAD_DATA"] ?? "/data", "run/local.sock")
// The daemon is in another container, so the model fake listens on every address and on the port it is told.
const model = await Model.start({
  host: "0.0.0.0",
  port: Number(process.argv[2]),
  heard: ({ index, path }) => record("model", { index, path }),
})

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const platform = yield* Platform.make(record)
      yield* Layer.build(
        Platform.serve(
          LocalChat.Rpcs.merge(Fakes.Rpcs),
          Layer.merge(
            platform.handlers,
            Fakes.handlers(Fakes.direct(platform, model)),
          ),
          path,
        ),
      )
      record("listening", { path, model: model.url })
      return yield* Effect.never
    }),
  ),
)
