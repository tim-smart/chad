// Records every module Node resolves in this test process, so a scenario can count the copies of a package that
// the running daemon holds. It is a setup file, so it is in place before the test file imports anything.
import { registerHooks } from "node:module"

const resolved = new Set<string>()

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    resolved.add(result.url)
    return result
  },
})

declare global {
  var chadResolved: ReadonlySet<string>
}
globalThis.chadResolved = resolved
