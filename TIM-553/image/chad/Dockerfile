# syntax=docker/dockerfile:1
# PROTOTYPE for TIM-553: the image from "Docker image and data volume layout" (TIM-541), around a stand-in daemon.
ARG NODE=docker.io/library/node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
ARG UV=ghcr.io/astral-sh/uv:0.13.8

FROM ${UV} AS uv

FROM ${NODE} AS build
RUN npm install -g --no-audit --no-fund pnpm@12.18.0
WORKDIR /opt/chad
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY bin ./bin
COPY src ./src
COPY plugins ./plugins
# The self-link is what makes `import { Plugin } from "chad"` resolve from /data/repo/node_modules.
RUN pnpm run build && ln -s .. node_modules/chad && pnpm run check:plugins && chmod +x bin/chad.js
# The checks the image's CI makes: one effect, no Claude platform binary, and clanka's Claude module still imports.
RUN test "$(find node_modules -name package.json -path '*/node_modules/effect/package.json' | wc -l)" = 1 \
 && test -z "$(find node_modules/.pnpm -maxdepth 1 -name '@anthropic-ai+claude-agent-sdk-*')" \
 && node --input-type=module -e 'await import("clanka/ClaudeAgent"); console.log("clanka/ClaudeAgent imports")'

FROM ${NODE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq openssh-client procps ripgrep sqlite3 tini unzip xz-utils \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=build /opt/chad/package.json /opt/chad/package.json
COPY --from=build /opt/chad/node_modules /opt/chad/node_modules
COPY --from=build /opt/chad/dist /opt/chad/dist
COPY --from=build /opt/chad/plugins /opt/chad/plugins
COPY --from=build /opt/chad/bin /opt/chad/bin
RUN ln -s /opt/chad/bin/chad.js /usr/local/bin/chad && install -d -o node -g node /data
# A login shell resets PATH from /etc/profile. This puts the volume's bin directories back, last, and only once.
RUN printf '%s\n' 'for d in /data/home/.npm-global/bin /data/home/.local/bin; do case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac; done; export PATH' > /etc/profile.d/chad.sh
# The volume's bin directories come last, so nothing installed there shadows the image's tools.
ENV CHAD_DATA=/data \
    HOME=/data/home \
    XDG_CACHE_HOME=/data/cache \
    NPM_CONFIG_CACHE=/data/cache/npm \
    NPM_CONFIG_PREFIX=/data/home/.npm-global \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/data/home/.npm-global/bin:/data/home/.local/bin
USER node
WORKDIR /data
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s --start-interval=2s CMD ["chad", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/chad"]
CMD ["serve"]
