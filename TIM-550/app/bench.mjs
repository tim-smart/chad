// Claim I: median wall time of 10 runs each (after 1 warm-up). Needs a running daemon for health.
import { spawnSync } from "node:child_process"
const cases = [
  ["(c) empty script", ["empty.mjs"], {}],
  ["(a) health, unbundled .ts", ["chad.ts", "health"], {}],
  ["(b) health, esbuild bundle", ["../dist/chad.mjs", "health"], {}],
  ["(b2) health, esbuild bundle minified", ["../dist/chad.min.mjs", "health"], {}],
  ["(a+cc) health, unbundled .ts + NODE_COMPILE_CACHE", ["chad.ts", "health"], { NODE_COMPILE_CACHE: "../dist/cc-ts" }],
  ["(b+cc) health, bundle + NODE_COMPILE_CACHE", ["../dist/chad.mjs", "health"], { NODE_COMPILE_CACHE: "../dist/cc-bundle" }],
  ["--help, unbundled .ts", ["chad.ts", "--help"], {}],
  ["--help, esbuild bundle", ["../dist/chad.mjs", "--help"], {}],
  ["--help, bundle + NODE_COMPILE_CACHE", ["../dist/chad.mjs", "--help"], { NODE_COMPILE_CACHE: "../dist/cc-bundle" }]
]
for (const [name, args, env] of cases) {
  const times = []
  let status
  for (let i = 0; i < 11; i++) {
    const s = process.hrtime.bigint()
    const r = spawnSync(process.execPath, args, { stdio: "ignore", env: { ...process.env, ...env } })
    const ms = Number(process.hrtime.bigint() - s) / 1e6
    status = r.status
    if (i > 0) times.push(ms)
  }
  times.sort((a, b) => a - b)
  const median = (times[4] + times[5]) / 2
  console.log(`${name.padEnd(52)} median ${median.toFixed(1)} ms  min ${times[0].toFixed(1)}  max ${times[9].toFixed(1)}  exit ${status}`)
}
