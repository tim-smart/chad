import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * The session marker. Every process a session starts carries `CHAD_SESSION=<session id>`, which is how the CLI tells
 * a command the agent runs from one the owner types. It carries `HOME` too, which is `home/` on the volume for every
 * session, and `TZ`, the owner's timezone as it is when the process starts. A session's process also gets
 * `CHAD_TURN_KEY`, the key of the turn that started it, which is what `chad secret run` reads that turn's one-off
 * values with (`Once.ts`). The id names a session and the key proves a process belongs to its running turn.
 */

/** Adds the marker to a command, and to each side of a pipeline. The child keeps the rest of its environment. */
export const addSession = (
  id: string,
  home?: string,
  zone?: () => string,
  key?: () => string,
) => {
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
        ...(key === undefined ? {} : { CHAD_TURN_KEY: key() }),
      },
      extendEnv: true,
    })
  }
  return go
}

/**
 * The spawner of one session, over the daemon's own. clanka reads the spawner once, when an executor is built, so
 * each session's executor is built with its own.
 */
export const layer = (
  id: string,
  home?: string,
  zone?: () => string,
  key?: () => string,
) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const inner = yield* ChildProcessSpawner.ChildProcessSpawner
      const add = addSession(id, home, zone, key)
      return ChildProcessSpawner.make((command) => inner.spawn(add(command)))
    }),
  )
