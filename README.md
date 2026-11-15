# Prototype archives

These are the throwaway prototypes that ran many of the rules in the spec while chad was designed. This branch is never merged. Every daemon in them was a stand-in, and nothing that stood in for chad carries over into the build. `docs/spec/17-testing.md` says what does carry over and how each scenario here maps to a test.

Each directory is named after the ticket whose prototype it holds.

| Directory | Prototype | Build stage that uses it |
| --- | --- | --- |
| `TIM-530/` | Plugin API: what a plugin exports and what it can do | 3 |
| `TIM-531/` | Applying a plugin change to a live session | 3 |
| `TIM-538/` | Runtime and plugin loading mechanism | 3 |
| `TIM-539/` | The asphodel plugin written against the plugin API | 3 and 5 |
| `TIM-541/` | Docker image and data volume layout | 1 and 5 |
| `TIM-543/` | The Session entity run on SingleRunner and SQLite | 1 and 2 |
| `TIM-544/` | Codex login run for real | 2 |
| `TIM-549/` | The bundled skill that teaches chad to change itself | 5 |
| `TIM-550/` | The chad CLI's socket, lock and session marker run for real | 1 |
| `TIM-552/` | The plugin swap run with live sessions | 3 |
| `TIM-553/` | The chad image built and run | 1 and 5 |
| `TIM-554/` | Credential tools run on real clanka and a browser sidecar | 4 |
| `TIM-555/` | The MCP layer rebuild run with calls in flight | 4 |

The effect snapshot tarballs that the image prototype vendored (`TIM-553/image/chad/vendor/*.tgz`, 12 MB) are left out. That snapshot is older than the floor the spec pins.
