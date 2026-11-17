// A stand-in for the npm registry. It serves the packages under test/fixtures/packages/ over HTTP on 127.0.0.1, so
// no test reaches the public registry, and it can hold a tarball's download for a scenario that cuts an install.
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { onTestFinished } from "vitest"
import { path } from "./repo.ts"

const fixtures = path("test/fixtures/packages")

interface Packed {
  readonly manifest: Record<string, unknown> & {
    readonly name: string
    readonly version: string
  }
  readonly tarball: Buffer
}

/** Every fixture packed once per test file, by `npm pack` in one call. */
let packing: Array<Packed> | undefined
const packed = () => {
  if (packing !== undefined) return packing
  const directories = readdirSync(fixtures, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(fixtures, entry.name))
  const out = mkdtempSync(join(tmpdir(), "chad-registry-"))
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", out, ...directories],
    {
      stdio: "ignore",
      env: { ...process.env, npm_config_cache: join(out, "cache") },
    },
  )
  packing = directories.map((directory) => {
    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    )
    return {
      manifest,
      tarball: readFileSync(
        join(out, `${manifest.name}-${manifest.version}.tgz`),
      ),
    }
  })
  return packing
}

export interface Registry {
  readonly url: string
  /**
   * Holds the next download of a package's tarball until `release`. `held` resolves once the request has arrived. A
   * later download is served at once.
   */
  readonly hold: (name: string) => {
    readonly held: Promise<void>
    readonly release: () => void
  }
  /**
   * Writes `work/package-lock.json` for the `package.json` there, as the agent does with
   * `npm install --package-lock-only`, against this registry and with a cache of its own.
   */
  readonly lock: (work: string) => Promise<void>
  /** Stops answering, as a registry that cannot be reached. */
  readonly close: () => Promise<void>
}

export const start = async (): Promise<Registry> => {
  const packages = packed()
  const holds = new Map<
    string,
    { arrived: () => void; released: Promise<void> }
  >()
  const held = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    const [, name, dash, file] = decodeURIComponent(request.url ?? "").split(
      "/",
    )
    const versions = packages.filter(({ manifest }) => manifest.name === name)
    if (versions.length === 0) {
      response.writeHead(404).end("{}")
      return
    }
    if (dash === "-" && file !== undefined) {
      const found = versions.find(
        ({ manifest }) => `${manifest.name}-${manifest.version}.tgz` === file,
      )
      if (found === undefined) {
        response.writeHead(404).end()
        return
      }
      const send = () =>
        response
          .writeHead(200, { "content-type": "application/octet-stream" })
          .end(found.tarball)
      const hold = holds.get(name!)
      if (hold === undefined) return send()
      holds.delete(name!)
      held.add(response)
      hold.arrived()
      void hold.released.then(() => {
        held.delete(response)
        if (!response.destroyed) send()
      })
      return
    }
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const integrity = (tarball: Buffer) =>
      `sha512-${createHash("sha512").update(tarball).digest("base64")}`
    const latest = versions.at(-1)!.manifest.version
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        name,
        "dist-tags": { latest },
        versions: Object.fromEntries(
          versions.map(({ manifest, tarball }) => [
            manifest.version,
            {
              ...manifest,
              dist: {
                tarball: `${url}/${name}/-/${name}-${manifest.version}.tgz`,
                integrity: integrity(tarball),
                shasum: createHash("sha1").update(tarball).digest("hex"),
              },
            },
          ]),
        ),
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let closed: Promise<void> | undefined
  const close = () =>
    (closed ??= new Promise<void>((resolve) => {
      for (const response of held) response.destroy()
      server.close(() => resolve())
      server.closeAllConnections()
    }))
  onTestFinished(close)
  const cache = mkdtempSync(join(tmpdir(), "chad-registry-cache-"))
  return {
    url,
    hold: (name) => {
      let arrived!: () => void
      let release!: () => void
      const heard = new Promise<void>((resolve) => (arrived = resolve))
      holds.set(name, {
        arrived,
        released: new Promise<void>((resolve) => (release = resolve)),
      })
      return { held: heard, release }
    },
    // Asynchronous, because the registry answers from this same process.
    lock: async (work) => {
      await promisify(execFile)(
        "npm",
        [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          `--registry=${url}`,
          `--cache=${cache}`,
        ],
        { cwd: work },
      )
    },
    close,
  }
}
