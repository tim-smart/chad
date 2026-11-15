// handles SIGTERM with a 3 second graceful shutdown
import { spawn } from "node:child_process"
console.log("start pid", process.pid)
process.on("SIGTERM", () => {
  console.log(new Date().toISOString(), "got SIGTERM, shutting down in 3s")
  setTimeout(() => { console.log(new Date().toISOString(), "graceful exit"); process.exit(0) }, 3000)
})
if (process.argv[2] === "orphan") {
  // what the agent's bash tool can do: a grandchild that outlives its parent
  spawn("bash", ["-c", "(sleep 1 &) ; exit 0"], { stdio: "ignore" })
}
setInterval(() => {}, 1000)
