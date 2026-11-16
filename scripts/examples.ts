// The last step of the build. It writes the bundled plugins' TypeScript source to `plugins/`, the directory that
// `repo/examples` links to, with their imports of chad's own modules turned into the package imports a repo plugin
// writes. A plugin is a file or a directory, and a directory's own files import each other as they are. It also links
// the package to itself as `node_modules/chad`, which is how `chad` resolves from `repo/node_modules` in the image and
// in the tests.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { posix } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const modules: Record<string, string> = {
  "src/Plugin.ts": "chad/Plugin",
  "src/Session.ts": "chad/Session",
  "src/Turns.ts": "chad/Turns",
}

/** Copies one plugin file, `file` relative to `src/plugins`, with its imports of chad rewritten. */
const copy = (file: string, plugin: string) => {
  const source = readFileSync(root + `src/plugins/${file}`, "utf8")
  const rewritten = source.replace(/from "(\.[^"]+)"/g, (whole, path) => {
    const resolved = posix.join("src/plugins", posix.dirname(file), path)
    const module = modules[resolved]
    if (module !== undefined) return `from "${module}"`
    if (plugin !== file && resolved.startsWith(`src/plugins/${plugin}/`)) {
      return whole
    }
    throw new Error(
      `src/plugins/${file} imports ${path}, which a repo plugin cannot`,
    )
  })
  writeFileSync(root + `plugins/${file}`, rewritten)
}

rmSync(root + "plugins", { recursive: true, force: true })
mkdirSync(root + "plugins")
for (const entry of readdirSync(root + "src/plugins", {
  withFileTypes: true,
})) {
  if (entry.isDirectory()) {
    mkdirSync(root + `plugins/${entry.name}`)
    for (const file of readdirSync(root + `src/plugins/${entry.name}`)) {
      copy(`${entry.name}/${file}`, entry.name)
    }
  } else {
    copy(entry.name, entry.name)
  }
}

rmSync(root + "node_modules/chad", { force: true })
symlinkSync("..", root + "node_modules/chad")
