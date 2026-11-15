import { Effect, type FileSystem } from "effect"
import * as ModelText from "../ModelText.ts"
import type { ModelState } from "../Rpcs.ts"
import * as TokenStore from "../TokenStore.ts"
import { Environment } from "./Environment.ts"

/** The main model as the files and the environment give it, and whether its provider needs the Codex login. */
export const model = Effect.gen(function* () {
  const environment = yield* Environment
  const spec = yield* ModelText.main(environment.data, environment.model).pipe(
    Effect.orElseSucceed(() => environment.model ?? ModelText.fallback),
  )
  return {
    spec,
    needsLogin: ModelText.needsLogin(spec, environment.openaiApiKey),
  }
})

/** The model and the login state with no daemon to ask, which no login can be pending in (CLI-125). */
export const fromFiles: Effect.Effect<
  ModelState,
  never,
  Environment | FileSystem.FileSystem
> = Effect.gen(function* () {
  const environment = yield* Environment
  const { spec, needsLogin } = yield* model
  if (!needsLogin) return { spec, login: "not-needed" } as const
  const stored = yield* TokenStore.codexStored(environment.data)
  return { spec, login: stored ? "logged-in" : "logged-out" } as const
})
