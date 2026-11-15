// The wrap under test: a ChildProcessSpawner that adds CHAD_SESSION to every child.
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"

export type Mode = "extend" | "naive-setEnv"

// "extend": keep the inherited environment (extendEnv: true) unless the command
// already chose its own env. "naive-setEnv": what ChildProcess.setEnv does.
export const addSession = (id: string, mode: Mode) => {
  const go = (cmd: ChildProcess.Command): ChildProcess.Command => {
    if (cmd._tag === "PipedCommand") {
      return ChildProcess.pipeTo(go(cmd.left), go(cmd.right), cmd.options)
    }
    if (mode === "naive-setEnv") return ChildProcess.setEnv(cmd, { CHAD_SESSION: id })
    const hadEnv = cmd.options.env !== undefined
    return ChildProcess.make(cmd.command, cmd.args as any, {
      ...cmd.options,
      env: { ...cmd.options.env, CHAD_SESSION: id },
      extendEnv: hadEnv ? cmd.options.extendEnv : true
    })
  }
  return go
}

export const layerSessionSpawner = (
  id: string,
  options?: { readonly mode?: Mode; readonly log?: (line: string) => void }
) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const inner = yield* ChildProcessSpawner.ChildProcessSpawner
      const add = addSession(id, options?.mode ?? "extend")
      return ChildProcessSpawner.make((cmd) => {
        if (cmd._tag === "StandardCommand") {
          options?.log?.(`spawner[${id}] spawn ${cmd.command} ${JSON.stringify(cmd.args).slice(0, 80)}`)
        }
        return inner.spawn(add(cmd))
      })
    })
  )
