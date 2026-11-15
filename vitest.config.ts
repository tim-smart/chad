import { availableParallelism } from "node:os"
import { defineConfig } from "vitest/config"

// One project per layer of docs/spec/17-testing.md. A layer with no test yet is an empty project.
export const layers = ["types", "unit", "daemon", "process", "image"]

/**
 * The projects of layer 6, which need a real Discord, a real login or a real model. Each is a nightly or a live item,
 * and no pull request runs one.
 */
export const live = ["discord"]

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
    projects: [...layers, ...live].map((name) => ({
      test: {
        name,
        include: [`test/${name}/**/*.test.ts`],
        // A live item waits on a real service.
        ...(live.includes(name) ? { testTimeout: 120_000 } : {}),
        pool: "forks",
        env: { TZ: timezone, CHAD_TEST_RUN: run },
        setupFiles: ["test/support/modules.ts"],
        // The built package is loaded by Node itself and never through vite, as a plugin's imports are.
        server: { deps: { external: [/\/dist\//] } },
      },
    })),
  },
})
