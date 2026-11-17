// The two bundles in dist/, built after `tsc` has written the package's own modules there. Each is one file directly
// in dist/, so a module that finds a file of the package from its own URL finds it from either. Neither writes a
// source map.
import { defineConfig, type UserConfig } from "tsdown"

const shared: UserConfig = {
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: false,
  dts: false,
  // `tsc` writes dist/ first, so neither bundle clears it.
  clean: false,
  fixedExtension: false,
  logLevel: "warn",
  // One file each, with every dynamic import inlined.
  outputOptions: { codeSplitting: false },
}

export default defineConfig([
  {
    ...shared,
    // `chad serve`. chad's own code is bundled and every package stays in node_modules, so the daemon runs the effect
    // that plugins are given.
    entry: { "daemon.bundle": "src/daemon.ts" },
  },
  {
    ...shared,
    // Every other command. It carries its packages with it, except the Claude SDK, which only the daemon loads.
    entry: { "cli.bundle": "src/cli.ts" },
    deps: {
      alwaysBundle: [/./],
      neverBundle: ["@anthropic-ai/claude-agent-sdk"],
      onlyBundle: false,
    },
  },
])
