// Replaces the vendored effect tarballs as a set. A real upgrade runs it, by hand.
//
//   node scripts/vendor.ts <commit>            the snapshot of one commit of the effect pull request
//   node scripts/vendor.ts --newest            the snapshot of the pull request's newest commit
//   node scripts/vendor.ts --newest --clanka newest   and the newest clanka from npm
//
// The download is no install. The tarballs are written under vendor/, and the install that follows reads them from
// there. A newer snapshot stays only when the harness slice's scenario of a message in and a scripted answer out
// passes on it. When it does not, the old set is put back and the script exits 1.
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

export interface Manifest {
  readonly repository: string
  readonly pullRequest: number
  readonly branch: string
  readonly commit: string
  readonly commitDate: string
}

/** The file a package's tarball has under vendor/. */
export const file = (name: string) =>
  name.replace(/^@/, "").replace("/", "-") + ".tgz"

/** Where pkg.pr.new publishes a package of a snapshot. */
export const url = (repository: string, name: string, commit: string) =>
  `https://pkg.pr.new/${repository}/${name}@${commit}`

/** The vendored packages, which are the names of the workspace's catalog. */
export const packages = (root: string): ReadonlyArray<string> =>
  Object.keys(
    parse(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).catalog,
  )

/** What the script does outside the checkout's files. A test passes its own. */
export interface Steps {
  readonly download: (url: string) => Promise<Uint8Array>
  /** Installs from the tarballs under vendor/, and says whether the install passed. */
  readonly install: () => boolean
  /** Runs the scenario of a message in and a scripted answer out, and says whether it passed. */
  readonly scenario: () => boolean
}

/** The files a replacement changes, which are put back as they were when the new set is refused. */
const changed = (root: string, names: ReadonlyArray<string>) => [
  ...names.map((name) => join(root, "vendor", file(name))),
  join(root, "vendor/manifest.json"),
  join(root, "pnpm-lock.yaml"),
]

/**
 * Replaces the set. Every tarball is downloaded before one is written, so a failed download leaves the old set in
 * place. It gives `false`, with the old set back in place, when the install or the scenario fails on the new one.
 */
export const replace = async (
  root: string,
  target: Pick<Manifest, "commit" | "commitDate">,
  steps: Steps,
): Promise<boolean> => {
  const manifest: Manifest = JSON.parse(
    readFileSync(join(root, "vendor/manifest.json"), "utf8"),
  )
  const names = packages(root)
  const tarballs = await Promise.all(
    names.map((name) =>
      steps.download(url(manifest.repository, name, target.commit)),
    ),
  )
  const before = changed(root, names).map(
    (path) => [path, readFileSync(path)] as const,
  )
  names.forEach((name, index) =>
    writeFileSync(join(root, "vendor", file(name)), tarballs[index]!),
  )
  writeFileSync(
    join(root, "vendor/manifest.json"),
    JSON.stringify({ ...manifest, ...target }, null, 2) + "\n",
  )
  if (steps.install() && steps.scenario()) return true
  for (const [path, content] of before) writeFileSync(path, content)
  steps.install()
  return false
}

/** Names a clanka version in the two files that name one, package.json and the pnpm settings. */
export const clanka = (root: string, version: string) => {
  const manifest = join(root, "package.json")
  const pkg = JSON.parse(readFileSync(manifest, "utf8"))
  pkg.dependencies.clanka = version
  writeFileSync(manifest, JSON.stringify(pkg, null, 2) + "\n")
  const workspace = join(root, "pnpm-workspace.yaml")
  writeFileSync(
    workspace,
    readFileSync(workspace, "utf8").replace(
      /clanka@[^\s"']+/,
      `clanka@${version}`,
    ),
  )
}

const github = async (path: string) => {
  const token = process.env["GITHUB_TOKEN"]
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
  if (!response.ok)
    throw new Error(`GitHub answered ${response.status} for ${path}`)
  return response.json()
}

/** What a command line asks for: the commit to vendor, or the newest one, and the clanka version to pin, if any. */
export interface Request {
  /** The named commit. Without one the script takes the newest commit of the pull request. */
  readonly commit: string | undefined
  /** The value of `--clanka`, which is a version or `newest`. */
  readonly clanka: string | undefined
}

/** Reads the arguments. It gives `undefined` for a command line that names no commit and does not say `--newest`. */
export const request = (argv: ReadonlyArray<string>): Request | undefined => {
  const flag = argv.indexOf("--clanka")
  const value = flag === -1 ? -1 : flag + 1
  const commit = argv.find(
    (argument, index) => !argument.startsWith("--") && index !== value,
  )
  if (commit === undefined && !argv.includes("--newest")) return undefined
  return { commit, clanka: value === -1 ? undefined : argv[value] }
}

const main = async (argv: ReadonlyArray<string>) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const manifest: Manifest = JSON.parse(
    readFileSync(join(root, "vendor/manifest.json"), "utf8"),
  )
  const asked = request(argv)
  if (asked === undefined) {
    console.error(
      "usage: node scripts/vendor.ts <commit> | --newest [--clanka <version> | newest]",
    )
    return 1
  }
  const { commit: named, clanka: wanted } = asked
  const pnpm = (...args: ReadonlyArray<string>) =>
    spawnSync("pnpm", args, { cwd: root, stdio: "inherit" }).status === 0

  if (wanted !== undefined) {
    const version =
      wanted === "newest"
        ? (
            await (
              await fetch("https://registry.npmjs.org/clanka/latest")
            ).json()
          ).version
        : wanted
    console.log(`clanka ${version}`)
    clanka(root, version)
  }

  const commit =
    named ??
    (await github(`repos/${manifest.repository}/pulls/${manifest.pullRequest}`))
      .head.sha
  const steps: Steps = {
    download: async (from) => {
      const response = await fetch(from)
      if (!response.ok) throw new Error(`${from} answered ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    },
    install: () => pnpm("install", "--no-frozen-lockfile"),
    scenario: () =>
      pnpm(
        "vitest",
        "run",
        "--project",
        "daemon",
        "test/daemon/turn.test.ts",
        "-t",
        "TST-164",
      ),
  }
  if (commit === manifest.commit) {
    console.log(`the vendored snapshot is already ${commit}`)
    // A changed clanka version still needs its install and the scenario.
    return wanted === undefined || (steps.install() && steps.scenario()) ? 0 : 1
  }
  const detail = await github(`repos/${manifest.repository}/commits/${commit}`)
  console.log(`effect snapshot ${manifest.commit} -> ${commit}`)
  const replaced = await replace(
    root,
    { commit: detail.sha, commitDate: detail.commit.committer.date },
    steps,
  )
  if (!replaced) {
    console.error(
      `the snapshot ${commit} did not pass, so the pinned one is back in place`,
    )
  }
  return replaced ? 0 : 1
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2))
}
