// PROTOTYPE for TIM-539. Throwaway. What the CLI's check command would
// generate: the default export must be a `Plugin.Plugin`.
import type { Plugin } from "chad"
import asphodel from "../plugins/asphodel.ts"

export const plugins: ReadonlyArray<Plugin.Plugin> = [asphodel]
