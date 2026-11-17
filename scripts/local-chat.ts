// A developer's way to type into the local platform. It listens at `run/local.sock` under the data directory, where
// the adapter client of a daemon with a `local` connection looks for its chat platform, and it is no part of chad.
// Each line typed is a direct message from the user id given with `--as`, and what chad posts is printed.
//
//   pnpm build && CHAD_DATA=/path/to/data node scripts/local-chat.ts --as <user id>
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Effect, Layer, Stream } from "effect"
import * as LocalChat from "../dist/daemon/LocalChat.js"
import * as Platform from "../test/support/platform.ts"

const flag = process.argv.indexOf("--as")
const author = flag === -1 ? "owner" : (process.argv[flag + 1] ?? "owner")
const path = join(process.env["CHAD_DATA"] ?? "/data", "run/local.sock")

const program = Effect.gen(function* () {
  const platform = yield* Platform.make(() => {})
  yield* Layer.build(Platform.serve(LocalChat.Rpcs, platform.handlers, path))
  const thread = yield* platform.chat.makeThread("direct")

  // Prints each message of chad's once, after the write that made or changed it.
  const printed = new Set<string>()
  yield* Effect.gen(function* () {
    let seen = 0
    for (;;) {
      yield* platform.written(seen)
      seen = platform.writes()
      for (const message of yield* platform.chat.messages(thread)) {
        if (!message.author.isSelf || printed.has(message.id)) continue
        printed.add(message.id)
        console.log(`chad: ${message.text}`)
      }
    }
  }).pipe(Effect.forkScoped)

  console.log(`listening at ${path} as ${author}`)
  yield* Stream.fromAsyncIterable(
    createInterface({ input: process.stdin }),
    (cause) => cause,
  ).pipe(
    Stream.filter((line) => line.trim() !== ""),
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        const event = yield* platform.chat.userPosts(thread, {
          text: line,
          authorId: author,
        })
        yield* platform
          .deliver(event)
          .pipe(
            Effect.catchTag("NotAccepted", () =>
              Effect.sync(() =>
                console.log("the daemon did not accept the message"),
              ),
            ),
          )
      }),
    ),
    Effect.orDie,
  )
})

await Effect.runPromise(Effect.scoped(program))
