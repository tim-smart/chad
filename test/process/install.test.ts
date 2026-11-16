import { spawn } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { connect, type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { path, read, yaml } from "../support/repo.ts"

describe("a clean install of the checkout, with a proxy that cannot reach pkg.pr.new as the only way out", () => {
  const directory = mkdtempSync(join(tmpdir(), "chad-install-"))
  const hosts = new Set<string>()
  let status: number | null
  let output = ""

  beforeAll(async () => {
    for (const file of [
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "vendor",
    ]) {
      cpSync(path(file), join(directory, file), { recursive: true })
    }
    const proxy = createServer((_, response) => response.writeHead(502).end())
    proxy.on("connect", (request, socket, head) => {
      const [host = "", port] = (request.url ?? "").split(":")
      hosts.add(host)
      if (host === "pkg.pr.new") return socket.destroy()
      const upstream = connect(Number(port), host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on("error", () => socket.destroy())
      socket.on("error", () => upstream.destroy())
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    const install = spawn(
      "pnpm",
      ["install", "--frozen-lockfile", "--store-dir", join(directory, "store")],
      {
        cwd: directory,
        env: {
          ...process.env,
          HTTPS_PROXY: url,
          HTTP_PROXY: url,
          https_proxy: url,
          http_proxy: url,
          NO_PROXY: "",
          no_proxy: "",
        },
      },
    )
    install.stdout.on("data", (chunk) => (output += chunk))
    install.stderr.on("data", (chunk) => (output += chunk))
    status = await new Promise((resolve) => install.on("close", resolve))
    proxy.closeAllConnections()
    proxy.close()
  }, 300_000)

  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  it("passes from the lockfile, which names no pkg.pr.new URL, with each such edge redirected to its tarball", () => {
    expect({ status, output }).toMatchObject({ status: 0 })
    // The packages came through the proxy, so the install had no other way to pkg.pr.new.
    expect([...hosts]).toEqual(["registry.npmjs.org"])
    expect(read("pnpm-lock.yaml")).not.toContain("pkg.pr.new")
    expect(yaml("pnpm-workspace.yaml").overrides).toEqual({
      effect: "catalog:",
      "@effect/platform-node-shared": "catalog:",
    })
  })

  it("node_modules holds one copy of effect", () => {
    const copies = readdirSync(join(directory, "node_modules/.pnpm")).filter(
      (name) => name.startsWith("effect@"),
    )
    expect(copies).toEqual(["effect@file+vendor+effect.tgz"])
  })
})
