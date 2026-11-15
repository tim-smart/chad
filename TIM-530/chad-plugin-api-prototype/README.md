# chad plugin API prototype

PROTOTYPE for "Plugin API: what a plugin exports and what it can do" (TIM-530). Throwaway. It exists to be reacted to.

The API is types only. There is no implementation of chad, so no plugin here runs.

A plugin file's default export is a Layer. Each registration function returns a Layer, and `Plugin.make` is `Layer.mergeAll` plus a check that only chad's services are still needed.

- `chad/Plugin.ts`, `chad/Session.ts`, `chad/Turns.ts` are the API a plugin imports from `"chad"`.
- `plugins/dice.ts` is the smallest plugin, one tool.
- `plugins/weather.ts` contributes a tool and a prompt chunk, runs a background fiber and uses Effect's `HttpClient`.
- `plugins/asphodel.ts` is a skeleton of asphodel's Hermes plugin on this API. The daemon client is a stub.
- `chad/_plugincheck.ts` is what the CLI's check command would generate: every default export must be a `Plugin.Plugin`.
- `chad/_hostcheck.ts` shows the host side fits clanka: two plugins' toolkits merged into `loopTools`, with `CurrentSession` provided per session.
- `chad/_lifetimecheck.ts` runs against real effect with a stand-in registry. It shows two contributions sharing one instance of the plugin's own service until unload, and the lifetime trap of the earlier Effect shape.

```
npm install --legacy-peer-deps
npm run check
node chad/_lifetimecheck.ts
```

It installs effect from the pkg.pr.new snapshot of the `effect-chat` branch at `0b51fb1` and clanka 0.27.0.
