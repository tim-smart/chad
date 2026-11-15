#!/usr/bin/env node
// The whole launcher. `serve` loads the daemon from separate files, so its effect is the one in
// node_modules that plugins are given. Every other command loads one bundled file.
if (process.argv[2] === "serve") {
  process.env.CHAD_SESSION = "daemon"
  await import("../dist/daemon.js")
} else {
  await import("../dist/cli.bundle.js")
}
