import { availableParallelism } from "node:os"
import { defineConfig } from "vitest/config"

// One project per layer of the suite: types (1), unit (2), daemon (3), process (4) and image. A layer with no test yet
// is an empty project.
export const layers = ["types", "unit", "daemon", "process", "image"]

/** The number of scenario files run at once, which is the runner's core count. This is the one place that sets it. */
export const files = availableParallelism()

/** The timezone every suite runs in. Timezone bugs hide in UTC. */
export const timezone = "Pacific/Auckland"

/** The id of this run. Each scenario keeps its event log, the daemon's log and the database under it. */
const run = Date.now().toString(36)

export default defineConfig({
  test: {
    passWithNoTests: true,
    maxWorkers: files,
    // The scenarios import the built package, so the build comes first.
    globalSetup: ["test/support/build.ts"],
    projects: layers.map((name) => ({
      test: {
        name,
        include: [`test/${name}/**/*.test.ts`],
        pool: "forks",
        // A daemon or process scenario waits on what the daemon does, never on a clock, so its time limit only
        // bounds a hang. The default 5 seconds is under twice what the longest takes on a healthy runner.
        ...(name === "daemon" || name === "process"
          ? { testTimeout: 20_000 }
          : {}),
        env: { TZ: timezone, CHAD_TEST_RUN: run },
        // The built package is loaded by Node itself and never through vite, as a plugin's imports are.
        server: { deps: { external: [/\/dist\//] } },
      },
    })),
  },
})
