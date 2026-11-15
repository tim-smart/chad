# The asphodel plugin on chad's plugin API

PROTOTYPE for "The asphodel plugin written against the plugin API" (TIM-539). Throwaway. It exists to be reacted to. It is not the port of the plugin, which is follow-up work in the asphodel repo.

The question it answers: can every part of asphodel's Hermes plugin (`plugin/` in tim-smart/asphodel at `f8ccdea`) be expressed against the plugin API agreed in TIM-530, and what does the API have to change where it cannot?

- `plugins/asphodel.ts` is the plugin. Comments that start "Hermes:" name the part of the Python plugin each block replaces.
- `chad/Plugin.ts`, `chad/Session.ts` and `chad/Turns.ts` are the API from TIM-530. Lines marked PROPOSED are changes this ticket asks for. None is agreed.
- `chad/_host.ts` is a stand-in for chad. It runs a plugin's hooks and tools in the order the map's tickets describe. It is not a design for chad.
- `scenarios/fake-daemon.ts` plays the asphodel daemon in memory. Its response shapes were read from the daemon's source.
- `scenarios/run.ts` drives twelve scenarios and checks what the daemon and the model see. `scenario-output.txt` is one run of it.

```
npm install --legacy-peer-deps
npm run check
npm run scenarios
```

It installs effect from the pkg.pr.new snapshot of the `effect-chat` branch at `0b51fb1` and needs a Node that runs TypeScript files directly (22.18 or later).

## What this does and does not show

It shows that the plugin compiles against the API and that its own logic behaves as intended when the hooks are called the way the tickets say chad will call them.

It does not show that chad calls them that way. chad does not exist, the host here is about 200 lines written for this ticket, and the daemon is a fake. The circuit breaker and the spool's age cap run on a test clock.
