# syntax=docker/dockerfile:1
ARG NODE=docker.io/library/node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
ARG UV=ghcr.io/astral-sh/uv:0.13.8

FROM ${UV} AS uv

FROM ${NODE} AS build
RUN npm install -g --no-audit --no-fund pnpm@12.9.0
WORKDIR /opt/chad
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile
# effect's AGENTS.md and ai-docs/ come with the vendored snapshot. When a snapshot lacks either, this takes effect's
# source at the commit vendor/manifest.json names and runs the step of effect's build that puts both into each
# package before a publish. It never reads another published version, and it fails when either is still missing.
COPY <<'EOF' /opt/effect-docs.sh
set -eu
package=/opt/chad/node_modules/effect
present() {
  test -s "$package/AGENTS.md" && test -n "$(find "$package/ai-docs" -type f 2>/dev/null | head -n 1)"
}
if ! present; then
  manifest=/opt/chad/vendor/manifest.json
  repository=$(node -p 'require(process.argv[1]).repository' "$manifest")
  commit=$(node -p 'require(process.argv[1]).commit' "$manifest")
  work=$(mktemp -d)
  node --input-type=module -e '
    const [url, file] = process.argv.slice(1)
    const response = await fetch(url)
    if (!response.ok) throw new Error(url + " answered " + response.status)
    await (await import("node:fs/promises")).writeFile(file, response.body)
  ' "https://codeload.github.com/$repository/tar.gz/$commit" "$work/effect.tgz"
  mkdir "$work/effect"
  tar -xzf "$work/effect.tgz" -C "$work/effect" --strip-components=1
  # The step imports glob and nothing else that is not part of Node. It resolves from the directory above the source.
  glob=$(node -p 'require(process.argv[1]).devDependencies.glob' "$work/effect/package.json")
  npm install --prefix "$work" --no-audit --no-fund --no-save "glob@$glob"
  (cd "$work/effect" && node scripts/copy-ai-docs.mjs)
  rm -rf "$package/AGENTS.md" "$package/ai-docs"
  cp "$work/effect/packages/effect/AGENTS.md" "$package/AGENTS.md"
  cp -R "$work/effect/packages/effect/ai-docs" "$package/ai-docs"
  rm -rf "$work"
fi
present
EOF
RUN sh /opt/effect-docs.sh
COPY tsconfig.json tsconfig.build.json ./
COPY bin ./bin
COPY src ./src
COPY scripts/examples.ts ./scripts/examples.ts
# The build's last step writes the examples to plugins/ and makes the self-link node_modules/chad -> .., which is what
# makes `import { Plugin } from "chad"` resolve from /data/repo/node_modules.
RUN pnpm run build && chmod +x bin/chad.js
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
COPY --from=build /opt/chad/bin /opt/chad/bin
COPY --from=build /opt/chad/plugins /opt/chad/plugins
# The bundled skills, which nothing builds.
COPY skills /opt/chad/skills
RUN ln -s /opt/chad/bin/chad.js /usr/local/bin/chad && install -d -o node -g node /data
# A login shell resets PATH from /etc/profile. This puts the volume's bin directories back, last, and only once.
RUN printf '%s\n' 'for d in /data/home/.npm-global/bin /data/home/.local/bin /data/repo/live/node_modules/.bin; do case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac; done; export PATH' > /etc/profile.d/chad.sh
# The volume's bin directories come last, so nothing installed there shadows the image's tools. The last one holds the
# commands of the packages work/package.json names. `live` is repointed by each apply and revert, so it follows them.
ENV CHAD_DATA=/data \
    HOME=/data/home \
    XDG_CACHE_HOME=/data/cache \
    NPM_CONFIG_CACHE=/data/cache/npm \
    NPM_CONFIG_PREFIX=/data/home/.npm-global \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/data/home/.npm-global/bin:/data/home/.local/bin:/data/repo/live/node_modules/.bin
USER node
WORKDIR /data
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s --start-interval=2s CMD ["chad", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/chad"]
CMD ["serve"]
