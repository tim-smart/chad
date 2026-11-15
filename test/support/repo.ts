import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parse, parseAllDocuments } from "yaml"

/** The root of the checkout. */
export const root = fileURLToPath(new URL("../..", import.meta.url))

export const path = (file: string) => root + file
export const exists = (file: string) => existsSync(path(file))
export const read = (file: string) => readFileSync(path(file), "utf8")
export const json = (file: string) => JSON.parse(read(file))
export const yaml = (file: string) => parse(read(file))

/** The lockfile. pnpm writes the package manager's own packages as a first document, ahead of the project's. */
export const lockfile = () =>
  parseAllDocuments(read("pnpm-lock.yaml")).at(-1)?.toJS()

/** Every `run` line of the gate's workflow, by job. */
export const gateRuns = (): Record<string, ReadonlyArray<string>> => {
  const jobs: Record<string, { steps: ReadonlyArray<{ run?: string }> }> = yaml(
    ".github/workflows/gate.yml",
  ).jobs
  return Object.fromEntries(
    Object.entries(jobs).map(([name, job]) => [
      name,
      job.steps.flatMap((step) => (step.run ? [step.run] : [])),
    ]),
  )
}
