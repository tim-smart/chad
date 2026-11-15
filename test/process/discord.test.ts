import { spawnSync } from "node:child_process"
import { expect, it } from "vitest"
import { path } from "../support/repo.ts"

it("TST-205 the nightly Discord job fails and names each secret it lacks, and runs no test without them", () => {
  const {
    DISCORD_CHAD_TOKEN: _,
    DISCORD_DRIVER_TOKEN: __,
    ...environment
  } = process.env
  const job = (env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [path("scripts/discord.ts")], {
      env: { ...environment, ...env },
      encoding: "utf8",
    })
  expect(job({})).toMatchObject({
    status: 1,
    stdout: "",
    stderr: "missing secrets: DISCORD_CHAD_TOKEN, DISCORD_DRIVER_TOKEN\n",
  })
  // GitHub hands a job an empty string for a secret that is not set.
  expect(
    job({ DISCORD_CHAD_TOKEN: "a-token", DISCORD_DRIVER_TOKEN: "" }),
  ).toMatchObject({
    status: 1,
    stdout: "",
    stderr: "missing secrets: DISCORD_DRIVER_TOKEN\n",
  })
})
