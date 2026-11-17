// A repo whose `applied` branch already holds a tree, as an earlier apply left it, for a test that boots on it.
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const identity = {
  GIT_AUTHOR_NAME: "chad",
  GIT_AUTHOR_EMAIL: "chad@localhost",
  GIT_COMMITTER_NAME: "chad",
  GIT_COMMITTER_EMAIL: "chad@localhost",
  GIT_CONFIG_NOSYSTEM: "1",
}

/** Runs git in a directory and gives its trimmed output. */
export const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...identity },
    encoding: "utf8",
  }).trim()

/** Writes files under a root. */
export const write = (root: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
}

/** Commits files to `applied` and `main` in `repo/work`, making the repo when there is none, and gives the commit. */
export const applied = (repo: string, files: Record<string, string>) => {
  const work = join(repo, "work")
  mkdirSync(work, { recursive: true })
  git(work, ["init", "-q", "-b", "main"])
  // Match Repo.create: later applies run outside this helper's identity environment.
  git(work, ["config", "user.name", identity.GIT_AUTHOR_NAME])
  git(work, ["config", "user.email", identity.GIT_AUTHOR_EMAIL])
  write(work, files)
  git(work, ["add", "-A"])
  git(work, ["commit", "-q", "--allow-empty", "-m", "Applied by the test"])
  git(work, ["branch", "-f", "applied", "HEAD"])
  return git(work, ["rev-parse", "HEAD"])
}
