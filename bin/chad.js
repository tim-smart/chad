#!/usr/bin/env node
// The whole launcher. `serve` loads the daemon's bundle, which leaves every package in node_modules, so its effect is
// the one plugins are given. Every other command loads the client's bundle, which carries its packages with it.
if (process.argv[2] === "serve") {
  await import("../dist/daemon.bundle.js")
} else {
  await import("../dist/cli.bundle.js")
}
