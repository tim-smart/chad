import { Effect, Layer, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
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
  /** A whole text, such as an error's, with every value the redactor masks replaced. */
  readonly scrub: (text: string) => string
}

/**
 * A child's error made again from its parts, each text scrubbed. effect's Node spawner puts the whole command line in
 * the error, and the Node error under it, which a spawn error's `spawnargs` holds the arguments of. The cause is
 * replaced by a plain error with the scrubbed message, so no raw copy is left under the new one for clanka to keep
 * with the task.
 */
const cleaned = (
  error: PlatformError.PlatformError,
  scrub: (text: string) => string,
): PlatformError.PlatformError => {
  const reason = error.reason
  const text = (value: string | undefined) =>
    value === undefined ? undefined : scrub(value)
  const cause =
    reason.cause === undefined
      ? undefined
      : new Error(
          scrub(
            reason.cause instanceof Error
              ? reason.cause.message
              : String(reason.cause),
          ),
        )
  return reason._tag === "BadArgument"
    ? PlatformError.badArgument({
        module: reason.module,
        method: reason.method,
        description: text(reason.description),
        cause,
      })
    : PlatformError.systemError({
        _tag: reason._tag,
        module: reason.module,
        method: reason.method,
        description: text(reason.description),
        syscall: reason.syscall,
        pathOrDescriptor:
          typeof reason.pathOrDescriptor === "string"
            ? scrub(reason.pathOrDescriptor)
            : reason.pathOrDescriptor,
        cause,
      })
}

/**
 * A stream of a child's output, passed through a redactor made as the child is spawned, so that it masks what the
 * session held then even after the session forgets it.
 */
const redacted = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  one: Redactor | undefined,
): Stream.Stream<Uint8Array, E> =>
  one === undefined
    ? stream
    : stream.pipe(
        Stream.decodeText,
        Stream.map(one.push),
        Stream.concat(Stream.sync(one.end)),
        Stream.filter((text) => text !== ""),
        Stream.encodeText,
      )

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
      // A child's redactors are made as it is spawned, so they mask what the session held then. Its errors go through
      // one of their own: the spawn's, the exit code's, a kill's and those of its streams, a signal's exit included.
      return ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          const errors = redactor()
          if (errors === undefined) return inner.spawn(add(command))
          const clean = (error: PlatformError.PlatformError) =>
            cleaned(error, errors.scrub)
          const stream = (
            output: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
            one: Redactor | undefined,
          ) => redacted(Stream.mapError(output, clean), one)
          return Effect.map(
            Effect.mapError(inner.spawn(add(command)), clean),
            (handle) =>
              ChildProcessSpawner.makeHandle({
                pid: handle.pid,
                exitCode: Effect.mapError(handle.exitCode, clean),
                isRunning: Effect.mapError(handle.isRunning, clean),
                kill: (options) => Effect.mapError(handle.kill(options), clean),
                stdin: Sink.mapError(handle.stdin, clean),
                stdout: stream(handle.stdout, redactor()),
                stderr: stream(handle.stderr, redactor()),
                all: stream(handle.all, redactor()),
                getInputFd: (fd) => Sink.mapError(handle.getInputFd(fd), clean),
                getOutputFd: (fd) => stream(handle.getOutputFd(fd), redactor()),
                unref: handle.unref,
              }),
          )
        }),
      )
    }),
  )
