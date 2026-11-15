import { defineConfig } from "vitest/config"

// One project per layer of docs/spec/17-testing.md. A layer with no test yet is an empty project.
export const layers = ["types", "unit", "daemon", "process", "image"]

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: layers.map((name) => ({
      test: { name, include: [`test/${name}/**/*.test.ts`] },
    })),
  },
})
