// scripts/kubernetes.ts at its kubectl boundary: a fake kubectl on PATH, so what the script does with a cluster's answers
// is tested with no cluster. The checks themselves run on a real one by hand (TST-110, TST-111).
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, onTestFinished } from "vitest"
import { path } from "../support/repo.ts"

/**
 * A kubectl that records each call, gives just enough JSON for the script to reach its end, and fails the wait for
 * chad's pod to be deleted. Every other call succeeds with no output, so most checks fail, which this test ignores.
 */
const kubectl = `#!/bin/sh
echo "$*" >> "$KUBECTL_CALLS"
case "$*" in
  "config current-context") echo fake ;;
  *"get pod "*) echo '{"items":[{"spec":{"containers":[{"name":"chad"}]},"status":{"containerStatuses":[]}}]}' ;;
  *"get pvc "*) echo '{"spec":{"volumeName":"fake"}}' ;;
  *"get pv "*) echo '{"metadata":{}}' ;;
  *--for=delete*) echo "timed out waiting for the condition" >&2; exit 1 ;;
esac
`

it("IMG-108 TST-110 when chad's pod is not gone after the scale to 0 the cluster check fails that check, never runs the pod-down backup job and still deletes its namespace", () => {
  const bin = mkdtempSync(join(tmpdir(), "chad-kubectl-"))
  onTestFinished(() => rmSync(bin, { recursive: true, force: true }))
  writeFileSync(join(bin, "kubectl"), kubectl)
  chmodSync(join(bin, "kubectl"), 0o755)
  const calls = join(bin, "calls")

  const run = spawnSync(process.execPath, [path("scripts/kubernetes.ts")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"]}`,
      KUBECTL_CALLS: calls,
    },
  })
  const made = readFileSync(calls, "utf8").split("\n")

  expect(run.stderr).toBe("")
  expect(run.stdout).toContain("FAIL chad's pod is gone after the scale to 0")
  expect(run.status).toBe(1)
  // A backup run while the pod is still there goes through chad's queue and proves nothing about a pod that is down.
  expect(made.some((call) => call.includes("check-running"))).toBe(true)
  expect(made.some((call) => call.includes("check-down"))).toBe(false)
  expect(made.at(-2)).toMatch(/^delete namespace chad-check-/)
})
