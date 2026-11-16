# chad

A personal assistant daemon that lives in Discord, built on effect/chat and clanka. It is a lighter alternative to Hermes: one process, one data volume, plugins written in TypeScript that chad can write and apply to itself.

chad has one owner. It ships as one Docker image with one data volume, and it changes itself by editing the plugins, skills, MCP config and persona on that volume.

## Running it

`docs/running.md` says how to run the image, with Docker or on Kubernetes, and how to back it up and restore it. After the first start, `chad setup` inside the container connects Discord, names the owner and can log chad in to Codex.

## Docs

- `docs/running.md`: running, backing up and restoring the image.
- `docs/owners.md`: who chad answers.
- `docs/live-checks.md`: the checks done by hand against a real Discord, Codex login and deployment.
- `docs/codex-capture.md`: how the recorded Codex frames the tests replay were made, and how to make them again.
- `skills/`: the skills chad ships with, which the model reads.
- `AGENTS.md`: the contract for whoever changes chad.

The `prototypes` branch holds throwaway prototypes from before the build. It is never merged.
