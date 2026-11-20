import { Effect, type FileSystem } from "effect"
import * as ModelText from "../ModelText.ts"
import type { ModelState } from "../Rpcs.ts"
import * as TokenStore from "../TokenStore.ts"
import { Environment } from "./Environment.ts"

/** The main model as the files and the environment give it, and the login its provider needs. */
export const model = Effect.gen(function* () {
  const environment = yield* Environment
  const spec = yield* ModelText.main(environment.data, environment.model).pipe(
    Effect.orElseSucceed(() => environment.model ?? ModelText.fallback),
  )
  return {
    spec,
    login: ModelText.loginOf(spec, environment.openaiApiKey),
  }
})

/** The model and the login state with no daemon to ask, which no login can be pending in. */
export const fromFiles: Effect.Effect<
  ModelState,
  never,
  Environment | FileSystem.FileSystem
> = Effect.gen(function* () {
  const environment = yield* Environment
  const { spec, login } = yield* model
  if (login === undefined) return { spec, login: "not-needed" } as const
  const stored = yield* TokenStore.stored(environment.data, login)
  return { spec, login: stored ? "logged-in" : "logged-out" } as const
})
