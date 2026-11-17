// The bundled asphodel plugin across a kill in layer 4: the daemon is a child process that a kill cuts in the middle of a
// turn. The fake asphodel daemon stays in the test's process behind an HTTP server, so it outlives the kill and keeps
// every request both starts sent.
import { DateTime } from "effect"
import { expect, test } from "vitest"
import * as Messages from "../../dist/Messages.js"
import * as Daemon from "../fixtures/asphodel/daemon.ts"
import { serve } from "../support/asphodel.ts"
import { eventually, found, prompted, rows, says } from "../support/owner.ts"
import { daemon } from "../support/process.ts"

/** A request as "METHOD path", with `/v1` and the bank left out. */
const route = (request: Daemon.Request) =>
  `${request.method} ${request.path.replace(/^\/v1(\/banks\/chad)?/, "")}`

test("a turn that a kill cut after its prefetch is resumed with no second prefetch and no second block fetch, and is ingested once with the owner's message, its time and the first attempt's recall id", async () => {
  const fake = Daemon.make()
  const url = await serve(fake)
  const running = await daemon({
    asphodel: { settings: { url, ownerName: "Tim" } },
  })
  const { fakes } = running
  await fakes.model.script([
    { text: "never sent", hold: true },
    { text: "Booked." },
  ])
  const routes = () => fake.state.requests.map(route)
  const first = await running.start()
  const thread = await fakes.chat.makeThread("direct")
  const message = await says(running, thread, "book a table for two")
  // The model is called once the prompt chunk and the prefetch are done, and the response it holds is the kill point.
  await fakes.model.received(1)
  expect(routes()).toEqual([
    "GET /health",
    "PUT ",
    "GET /system-prompt",
    "POST /prefetch",
  ])
  const [turn] = await found(running, "SELECT turn_id FROM turns")
  const [session] = rows(running, "SELECT id FROM sessions")
  expect(
    rows(running, "SELECT id FROM plugin_kv_asphodel ORDER BY id").map(
      (row) => row["id"],
    ),
  ).toEqual([`block/${session!["id"]}`, `recall/${turn!["turn_id"]}`])
  await first.kill()

  await running.start()
  const calls = await fakes.model.received(2)
  expect(prompted(calls[1])).toBe(Messages.restartNote())
  // The block from the store is still in the resumed turn's system prompt.
  expect(JSON.stringify(calls[1]!.body)).toContain("[asphodel agenda, block-1]")
  await fakes.chat.answers(thread, 1)
  await eventually(routes, (sent) => sent.includes("POST /turns"))
  await found(running, "SELECT 1 FROM turns WHERE outcome = 'answered'")
  // The second start's load, and then only the ingest: no block fetch and no prefetch for the resumed turn.
  expect(routes()).toEqual([
    "GET /health",
    "PUT ",
    "GET /system-prompt",
    "POST /prefetch",
    "GET /health",
    "PUT ",
    "POST /turns",
  ])
  const ingest = fake.state.requests.at(-1)!
  expect(ingest.body).toMatchObject({
    session_id: session!["id"],
    message_at: DateTime.formatIso(message.message.timestamp),
    user_text: "book a table for two",
    assistant_text: "Booked.",
    recall_id: "recall-1",
    forget_requested: false,
  })
  // The recall id went with its turn, and the block stays.
  expect(
    rows(running, "SELECT id FROM plugin_kv_asphodel ORDER BY id").map(
      (row) => row["id"],
    ),
  ).toEqual([`block/${session!["id"]}`])
}, 20_000)
