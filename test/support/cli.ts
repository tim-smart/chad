// Runs the built `chad` as a person at a shell does: the real bin, as a child process, with no `CHAD_SESSION`.
import { type ChildProcess, spawn } from "node:child_process"
import { path } from "./repo.ts"

export interface Ran {
  readonly stdout: string
  readonly stderr: string
  /** The exit code, or null when a signal ended the command. */
  readonly code: number | null
}

export interface Running {
  readonly child: ChildProcess
  readonly done: Promise<Ran>
  /** Resolves once the output so far holds the text. It rejects when the command ends without it. */
  readonly printed: (text: string) => Promise<void>
  /** Everything the command has written so far, both streams together. */
  readonly output: () => string
}

/** The environment of the owner's shell, which never carries the marker of a process that called `runDaemon`. */
export const owner = (
  env: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv => {
  const { CHAD_SESSION: _, ...rest } = process.env
  return { ...rest, ...env }
}

/**
 * Starts `chad` with the arguments, in the given environment over the owner's. `input` is what it reads on stdin, and
 * `false` leaves stdin open for the scenario to write to and end.
 */
export const start = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>> = {},
  input?: string | false,
): Running => {
  const child = spawn(process.execPath, [path("bin/chad.js"), ...args], {
    env: owner(env),
    stdio: ["pipe", "pipe", "pipe"],
  })
  // Stdin is a pipe that ends at once, or after the input, and never a terminal.
  if (input !== false) child.stdin.end(input)
  let stdout = ""
  let stderr = ""
  const waiting = new Set<() => void>()
  const heard = () => waiting.forEach((check) => check())
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
    heard()
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
    heard()
  })
  const done = new Promise<Ran>((resolve) =>
    child.on("close", (code) => resolve({ stdout, stderr, code })),
  )
  return {
    child,
    done,
    output: () => stdout + stderr,
    printed: (text) =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (!(stdout + stderr).includes(text)) return
          waiting.delete(check)
          resolve()
        }
        waiting.add(check)
        check()
        void done.then(() =>
          reject(
            new Error(
              `chad ${args.join(" ")} ended without ${text}: ${stdout}${stderr}`,
            ),
          ),
        )
      }),
  }
}

/** Runs `chad` to its end. */
export const chad = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>> = {},
  input?: string,
): Promise<Ran> => start(args, env, input).done
