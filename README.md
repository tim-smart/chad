# chad

A personal assistant daemon that lives in Discord, built on effect/chat and clanka. It is a lighter alternative to Hermes: one process, one data volume, plugins written in TypeScript that chad can write and apply to itself.

chad has one owner. It ships as one Docker image with one data volume, and it changes itself by editing the plugins, skills, MCP config and persona on that volume.

## Running it

`docs/running.md` says how to run the image, with Docker or on Kubernetes, and how to back it up and restore it. After the first start, `chad setup` inside the container connects Discord, names the owner and can log chad in to Codex.

`docs/deploying.md` is the short path to a server of your own: one cloud server with chad, asphodel, a Chromium you can open in your own browser and Tailscale, set up by one script. [This link](https://cloud.digitalocean.com/droplets/new?image=ubuntu-24-04-x64&size=s-2vcpu-4gb&region=nyc3) opens DigitalOcean's create page with the guide's image and size chosen. The guide has the script to paste there.

## Docs

- `docs/running.md`: running, backing up and restoring the image.
- `docs/deploying.md`: chad, asphodel, Chromium and Tailscale on one cloud server.
- `docs/owners.md`: who chad answers.
- `docs/live-checks.md`: the checks done by hand against a real Discord, Codex login and deployment.
- `docs/codex-capture.md`: how the recorded Codex frames the tests replay were made, and how to make them again.
- `skills/`: the skills chad ships with, which the model reads.
- `AGENTS.md`: the contract for whoever changes chad.

The `prototypes` branch holds throwaway prototypes from before the build. It is never merged.
