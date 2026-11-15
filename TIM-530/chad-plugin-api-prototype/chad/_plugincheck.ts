// PROTOTYPE for TIM-530. Throwaway. What the CLI's check command would
// generate: each plugin's default export must be a `Plugin.Plugin`, so a
// Layer that still needs a service chad does not supply fails here.
import type { Plugin } from "chad"
import asphodel from "../plugins/asphodel.ts"
import dice from "../plugins/dice.ts"
import weather from "../plugins/weather.ts"

export const plugins: ReadonlyArray<Plugin.Plugin> = [dice, weather, asphodel]
