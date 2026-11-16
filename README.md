# chad

A personal assistant daemon that lives in Discord, built on effect/chat and clanka. It is a lighter alternative to Hermes: one process, one data volume, plugins written in TypeScript that chad can write and apply to itself.

`docs/running.md` says how to run the image, with Docker or on Kubernetes, and how to back it up and restore it. `docs/live-checks.md` lists the checks done by hand against a real Discord, Codex login and deployment. The rest of `docs/`, apart from `docs/spec/`, is the owner's documentation.

- `docs/spec/` is the spec, 21 parts. `00-overview.md` is the way in, and its part table says what each part holds.
- `docs/spec/20-for-tim.md` is the owner's reading list: the size of the build, the open questions and what changed after it was agreed.
- `docs/spec/19-build-order.md` is the order of the build, five stages on one branch and one pull request.
- `AGENTS.md` is the contract for whoever builds it.
- The `prototypes` branch holds the throwaway prototypes that ran many of the rules. It is never merged.
