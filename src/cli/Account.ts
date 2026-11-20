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

/** The model, the login it needs and that login's state with no daemon to ask, which no login can be pending in. */
export const loginFromFiles: Effect.Effect<
  {
    readonly spec: string
    readonly login: ModelText.LoginKind | undefined
    readonly state: ModelState["login"]
  },
  never,
  Environment | FileSystem.FileSystem
> = Effect.gen(function* () {
  const environment = yield* Environment
  const { spec, login } = yield* model
  if (login === undefined) return { spec, login, state: "not-needed" } as const
  const stored = yield* TokenStore.stored(environment.data, login)
  return { spec, login, state: stored ? "logged-in" : "logged-out" } as const
})

/** The model and the login state with no daemon to ask. */
export const fromFiles: Effect.Effect<
  ModelState,
  never,
  Environment | FileSystem.FileSystem
> = Effect.map(loginFromFiles, ({ spec, state }) => ({ spec, login: state }))
