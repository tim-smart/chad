import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * The session marker. Every process a session starts carries `CHAD_SESSION=<session id>`, which is how the CLI tells
 * a command the agent runs from one the owner types. It carries `HOME` too, which is `home/` on the volume for every
 * session, and `TZ`, the owner's timezone as it is when the process starts.
 */

/** Adds the marker to a command, and to each side of a pipeline. The child keeps the rest of its environment. */
export const addSession = (id: string, home?: string, zone?: () => string) => {
  const go = (command: ChildProcess.Command): ChildProcess.Command => {
    if (command._tag === "PipedCommand") {
      return ChildProcess.pipeTo(
        go(command.left),
        go(command.right),
        command.options,
      )
    }
    return ChildProcess.make(command.command, command.args, {
      ...command.options,
      env: {
        ...command.options.env,
        CHAD_SESSION: id,
        ...(home === undefined ? {} : { HOME: home }),
        ...(zone === undefined ? {} : { TZ: zone() }),
      },
      extendEnv: true,
    })
  }
  return go
}

/** A redactor of one stream of output: what passes on of each chunk, and what was held back at the end. */
export interface Redactor {
  readonly push: (chunk: string) => string
  readonly end: () => string
}

/** A stream of a child's output, passed through a redactor of its own once the bytes are text. */
const redacted =
  (redactor: () => Redactor | undefined) =>
  <E>(stream: Stream.Stream<Uint8Array, E>): Stream.Stream<Uint8Array, E> =>
    Stream.suspend(() => {
      const one = redactor()
      if (one === undefined) return stream
      return stream.pipe(
        Stream.decodeText,
        Stream.map(one.push),
        Stream.concat(Stream.sync(one.end)),
        Stream.filter((text) => text !== ""),
        Stream.encodeText,
      )
    })

/**
 * The spawner of one session, over the daemon's own. clanka reads the spawner once, when an executor is built, so
 * each session's executor is built with its own. With `redactor`, each output stream of a child goes through a
 * redactor it gives, before clanka buffers the output, keeps it with the task or saves a large one to a temporary file.
 * It gives none while there is nothing to mask.
 */
export const layer = (
  id: string,
  home?: string,
  zone?: () => string,
  redactor?: () => Redactor | undefined,
) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const inner = yield* ChildProcessSpawner.ChildProcessSpawner
      const add = addSession(id, home, zone)
      if (redactor === undefined) {
        return ChildProcessSpawner.make((command) => inner.spawn(add(command)))
      }
      const mask = redacted(redactor)
      return ChildProcessSpawner.make((command) =>
        Effect.map(inner.spawn(add(command)), (handle) =>
          ChildProcessSpawner.makeHandle({
            pid: handle.pid,
            exitCode: handle.exitCode,
            isRunning: handle.isRunning,
            kill: handle.kill,
            stdin: handle.stdin,
            stdout: mask(handle.stdout),
            stderr: mask(handle.stderr),
            all: mask(handle.all),
            getInputFd: handle.getInputFd,
            getOutputFd: handle.getOutputFd,
            unref: handle.unref,
          }),
        ),
      )
    }),
  )
