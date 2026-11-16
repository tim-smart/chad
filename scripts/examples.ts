// The last step of the build. It writes the bundled plugins' TypeScript source to `plugins/`, the directory that
// `repo/examples` links to, with their imports of chad's own modules turned into the package imports a repo plugin
// writes (IMG-45, IMG-51, API-13). It also links the package to itself as `node_modules/chad`, which is how `chad`
// resolves from `repo/node_modules` in the image and in the tests (IMG-49, LOAD-28).
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const modules: Record<string, string> = {
  "../Plugin.ts": "chad/Plugin",
  "../Session.ts": "chad/Session",
  "../Turns.ts": "chad/Turns",
}

rmSync(root + "plugins", { recursive: true, force: true })
mkdirSync(root + "plugins")
for (const file of readdirSync(root + "src/plugins")) {
  const source = readFileSync(root + `src/plugins/${file}`, "utf8")
  const rewritten = source.replace(/from "(\.\.\/[^"]+)"/g, (whole, path) => {
    const module = modules[path]
    if (module === undefined) {
      throw new Error(
        `src/plugins/${file} imports ${path}, which a repo plugin cannot`,
      )
    }
    return `from "${module}"`
  })
  writeFileSync(root + `plugins/${file}`, rewritten)
}

rmSync(root + "node_modules/chad", { force: true })
symlinkSync("..", root + "node_modules/chad")
