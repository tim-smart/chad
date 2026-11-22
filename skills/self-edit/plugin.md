Before writing a plugin, read `/data/repo/node_modules/effect/AGENTS.md`. It documents how Effect is written in the version chad ships. Its examples live under `/data/repo/node_modules/effect/ai-docs/src/`, and the ones most relevant to plugins are:

- `/data/repo/node_modules/effect/ai-docs/src/01_effect/03_services/`
- `/data/repo/node_modules/effect/ai-docs/src/01_effect/05_resources/`
- `/data/repo/node_modules/effect/ai-docs/src/50_http-client/10_basics.ts`
- `/data/repo/node_modules/effect/ai-docs/src/71_ai/20_tools.ts`

Trust those files and the `.d.ts` files over your memory of Effect.

Three parts of the Effect examples don't apply to chad plugins:

- chad already provides `HttpClient`, so don't provide your own.
- chad runs the plugin lifecycle, so don't use `runMain` or `Layer.launch`.
- You can only import chad's direct dependencies, Node's built-in modules, and npm packages listed in `work/package.json`.

Read in this order:

1. `/data/repo/node_modules/effect/AGENTS.md` for Effect patterns.
2. `/data/repo/node_modules/chad/dist/Plugin.d.ts`, `/data/repo/node_modules/chad/dist/Session.d.ts`, and `/data/repo/node_modules/chad/dist/Turns.d.ts` for the plugin API (their doc comments explain each function).
3. A bundled plugin as a worked example: `/data/repo/examples/cron/`, `/data/repo/examples/send-file.ts`, or `/data/repo/examples/send-message.ts`. For calling an HTTP service with `Schema` decoding and graceful handling when the service is down, see `/data/repo/examples/asphodel/`.

Plugins compile against the `effect` and `chad` packages in `/data/repo/node_modules`. Check their `package.json` files or `chad status` for exact versions. This is Effect 4, so Effect 3 names (like importing from `@effect/platform` instead of `effect/http`) are the most common source of type errors.

A plugin is either a single file (`plugins/<name>.ts`) or a directory with `plugins/<name>/index.ts` and local modules it imports. Its name comes from the filename or directory name, and its default export is a `Layer` created with `Plugin.make`.

## Minimal example

```ts
// plugins/notes.ts
//
// Settings (under plugins.notes.settings in chad.json):
//   url   string   the notes service's search URL, required
import { Plugin } from "chad"
import { Config, Context, Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { HttpClient } from "effect/http"

class NotesError extends Schema.TaggedError<NotesError>()("NotesError", {
  message: Schema.String,
}) {}

// Plugin service, built once per load and shared across contributions.
class Api extends Context.Service<
  Api,
  {
    search(query: string): Effect.Effect<string, NotesError>
  }
>()("plugins/notes/Api") {
  static readonly layer = Layer.effect(
    Api,
    Effect.gen(function* () {
      const url = yield* Config.String("url")
      const client = yield* HttpClient.HttpClient

      const search = Effect.fn("Api.search")(
        function* (query: string) {
          const response = yield* client.get(url, { urlParams: { q: query } })
          return yield* response.text
        },
        Effect.mapError((cause) => new NotesError({ message: String(cause) })),
      )

      return Api.of({ search })
    }),
  )
}

const Notes = Toolkit.make(
  Tool.make("notesSearch", {
    description:
      "Search the owner's notes. Call it before answering a question about something they wrote down.",
    parameters: Schema.Struct({ query: Schema.String }),
    success: Schema.String,
    failure: NotesError,
  }),
)

const NotesTools = Plugin.toolkit(Notes).pipe(
  Layer.provide(
    Notes.toLayer(
      Effect.gen(function* () {
        const api = yield* Api
        return Notes.of({ notesSearch: ({ query }) => api.search(query) })
      }),
    ),
  ),
  Layer.provide(Api.layer),
)

export default Plugin.make(NotesTools)
```

- Each contribution helper returns a `Layer`. Provide its dependencies with `Layer.provide`, then pass all contribution layers to `Plugin.make`.
- chad automatically supplies `PluginContext`, `Turns`, `Chat`, `HttpClient`, `FileSystem`, `Path`, and `DateTime.CurrentTimeZone`. You must provide anything else before passing the layer to `Plugin.make`, or TypeScript will fail and name the missing service.
- Multiple contributions that provide the same `Layer` share a single instance of it.

## Loader constraints

- No top-level `await`.
- `import.meta` is empty, so plugins can't read files relative to their own path.
- Plugins can only import chad's direct dependencies (see `dependencies` in chad's `package.json` under `/data/repo/node_modules/`), Node built-ins, and packages in `work/package.json`. From chad itself, import from `chad`, `chad/Plugin`, `chad/Session`, or `chad/Turns`. Only `chad`, `effect`, and Node built-ins are guaranteed to remain importable across upgrades; chad's other dependencies may change in future versions.
- Use `Plugin.background(effect)` for fibers that should live as long as the plugin. Forking directly during `Layer` construction can leave the old and new fibers running briefly side by side during an apply.

## npm packages

- All plugins share a single `work/package.json` and `work/package-lock.json` (there are no per-plugin manifests). `package.json` must have `"type": "module"` or `chad check` fails.
- Add a package with `npm install --package-lock-only --ignore-scripts <name>` in `work/`, and remove one with `npm uninstall --package-lock-only <name>`. Then run `chad check` and `chad apply`. Both files are committed with your code, so reverting a plugin also reverts its dependencies.
- chad installs strictly from the lockfile with install scripts disabled and bundles imported packages into each plugin. Any `node_modules` created inside `work/` is ignored and never committed, so never run `npm install` without `--package-lock-only` there.
- Packages without TypeScript types fail type-checking with `TS7016`. Install their types with `npm install --package-lock-only --ignore-scripts --save-dev @types/<name>`, or add a `declare module` file under `plugins/`.
- Applying a changed lockfile downloads packages over the network and can take a minute. If the lockfile didn't change, nothing is installed.
- `chad`, `effect`, and chad's other direct dependencies always resolve to chad's own copies regardless of the lockfile, so packages using Effect share the same Effect instance as your plugin. If a package requires an incompatible version of one of those dependencies, or specifies it via a URL or path, `chad check` fails and names the package. npm aliases using any of those names on either side also fail (for example `fx` -> `npm:effect@...` or `semver` -> `npm:another-package@...`), except self-aliases like `effect` -> `npm:effect@^4.0.0`, which are range-checked normally. Pick a compatible version or drop the package.
- `chad check` lists packages that an apply will add, remove, or change. If installation fails, the check fails with npm's error and currently loaded plugins stay untouched.
- A package can also provide CLI tools instead of imports. Its binaries are added to `PATH` on apply and removed on revert (provided it doesn't require install scripts). See "Command line tools" in `SKILL.md`.
- Unsupported packages: native addons (`.node` files), packages that rely on install scripts, packages that read sibling files from disk (plugins are bundled in memory with an empty `import.meta`), and packages using top-level `await`.

## Tools

- Tool names share a global namespace across all plugins and built-in tools. Name collisions fail plugin load and report who already owns the name.
- A tool's `description` is all the model sees, so explain what it does and when to call it. `chad check` warns on descriptions still starting with `"Replace me"`, and `chad apply` refuses them.
- To access the current session and turn inside a tool, add `Session.CurrentSession` to its `dependencies`.
- Tools can't distinguish whether they were called by you or by a sub-agent.
- After an apply that changes a plugin's code or settings, any currently running turn can't call that plugin's tools until the turn ends.
- Any tool call still running 30 seconds into a swap is interrupted and may have partly run. Keep side-effecting tools short or idempotent.

## Prompt chunks

- Prompt chunks are sent on every turn of every session, so reserve them for dynamic state every turn needs. Put tool usage instructions in tool descriptions and longer reference docs in a skill.
- `Plugin.prompt(render)` runs before every turn with a 2-second timeout. Returning an empty string omits the chunk. If rendering fails, the session keeps the previous text.
- If a chunk needs to stay stable for an entire session, cache it in the plugin store and return the stored value (see `/data/repo/examples/asphodel/`).
- If a chunk changes mid-session, chad delivers it as an update message.

## Hooks

- `Plugin.beforeTurn` runs on the reply path with a 5-second timeout. If it returns a string, that string is injected into the turn as context.
- `turn.prompt` is what chad sends to the model. The owner's raw message text is `turn.origin.message.text`, available only when `turn.origin._tag === "Message"`.
- `turn.resumed` is `true` when resuming a turn after a restart; `beforeTurn` runs again for resumed turns.
- `Plugin.afterTurn` runs after the reply is posted with a 30-second timeout, serialized one at a time per plugin. Turns interrupted by chad being killed never reach `afterTurn`.
- `Plugin.onSession` receives `Reset` and `Compacted` events with a 10-second timeout. Handle unknown events with a default branch in case more events are added later.
- Hooks that fail or exceed their timeout are logged and skipped without blocking the turn. After three consecutive failures of the same hook, chad notifies the owner once.
- In-memory state isn't guaranteed to survive between a tool call or `beforeTurn` and `afterTurn`, because an apply can swap the plugin in between. Keep anything durable in the store.

## State

- `PluginContext.store` is a database-backed `KeyValueStore` private to this plugin.
- Keys don't expire automatically, so prune old keys yourself.
- Queued hooks run against the new plugin version after a reload, so the new code may read keys written by the old version. Decode stored values with a schema that remains compatible with older shapes.
- You can inspect the database from the CLI with `chad db query`.

## Settings

- `Config.String("url")` reads `plugins.<name>.settings.url` from `chad.json` and never falls back to environment variables.
- Read secrets with `Config.Redacted("token")` and reference them as `"${NAME}"` in `chad.json`.
- Give settings sensible defaults when possible so the plugin loads cleanly with an empty `chad.json`.
- Document all settings in the header comment at the top of the plugin file. `chad check` prints the keys the plugin read and warns about unused keys in `chad.json`.
- Changing a setting reloads the plugin, so active turns lose its tools until their next turn.

## Starting turns

- `Turns.start({ thread, prompt, label })` runs a turn in that thread's session and posts the reply there.
- Whether using `Turns.start`, `Turns.queue`, or `Turns.schedule`, the prompt must state what triggered the turn and that nobody is around to answer questions. That tells the agent not to apply changes unasked.
- Inside a tool, use `Turns.queue(options)`, which returns as soon as the request is saved without waiting for completion. Calling `Turns.start` from a tool targeting its own turn's thread fails immediately and tells you to use `Turns.queue`.
- A background fiber waiting on `Turns.start` loses the result if the plugin reloads. Read outcomes in `afterTurn` or from the store instead.
- `Turns.schedule`, `cancel`, and `scheduled` manage timers that survive restarts.
- If a plugin-started turn replies with exactly `[SILENT]`, nothing is posted.
- To post a message without invoking the agent, use `Chat`.

## Buttons

```ts
import { Plugin, Turns } from "chad"
import { Effect, Schema } from "effect"
import { ChatInteraction } from "effect/chat"

const Approve = ChatInteraction.button("deploy-approve", {
  label: "Approve",
  value: Schema.String, // a store key, not the full state
})
const Group = ChatInteraction.group(Approve)

const Buttons = Plugin.interactions(
  Group,
  Effect.gen(function* () {
    const turns = yield* Turns.Turns
    // `Group.of` types the handlers; returning a plain object from `Effect.gen` leaves `click` as implicit `any`.
    return Group.of({
      "deploy-approve": (click) =>
        turns
          .queue({
            thread: click.thread,
            label: "deploy approved",
            prompt: `The owner approved deploy ${click.value} with a button. Nobody is here to answer questions. Roll it out.`,
          })
          .pipe(Effect.ignore, Effect.as(ChatInteraction.ack)),
    })
  }),
)

// Posted via Chat from a tool or background fiber:
// chat.post(thread, { markdown: "Deploy 42 is ready.", actions: [Approve.of("42")] })
```

- `Plugin.interactions(group, handlers)` registers handlers for buttons, selects, and modals (`ChatInteraction.modal`), accepting the same arguments as `group.toLayer`. Slash commands don't compile.
- Post buttons yourself using `Chat` via the message's `actions` field.
- Handlers only run for clicks from an owner of the connection. Clicks from anyone else are acknowledged without invoking the handler.
- Interaction IDs share a global namespace with chad's built-in buttons and all other plugins. Collisions fail plugin load and name the existing owner.
- Buttons outlive the plugin version that posted them and survive restarts. Clicks route by ID to whichever version is loaded when clicked, so treat IDs and value schemas as persistent formats. If a value fails to decode, the click is acknowledged and the handler isn't called.
- Store only a lookup key in `value` and keep the actual state in the store. Discord limits the combined ID and encoded value to roughly 100 characters.
- Clicking a button whose plugin isn't loaded, is disabled, or is excluded by safe mode does nothing. Clicks arriving during boot, reload, or apply wait for the new version and run against it. Clear finished buttons with `chat.edit(thread, messageId, { markdown, actions: [] })`.
- Respond within 3 seconds. For slow work, queue a turn or fork into the plugin's scope and acknowledge immediately. A late click keeps running, but any modal it tries to open is dropped and a late modal submit is interrupted.
- Failing handlers are logged as errors under the plugin's name and the click is acknowledged.

## Owners

- `PluginContext.owners` holds the owner IDs formatted as `<platform>:<id>`.

## Reviewing a plugin

Every change to plugin code must be reviewed by a sub-agent before you apply it (changes to `chad.json` settings alone don't need one). A fresh reader without your context catches mistakes you overlook.

- Run the review after `chad check` passes, so the sub-agent sees Prettier-formatted code and doesn't waste time on type errors.
- Wait for the review report before applying, in the same turn. A foreground sub-agent is simplest; if you start one in the background, await it before applying (the next turn can't start while it's running anyway).
- The sub-agent only reads and reports. It must not edit files or run commands that change chad (`chad apply`, `chad revert`, `chad plugin purge`).

Because the sub-agent starts with no context, give it everything it needs using this prompt template:

```text
Review the chad plugin <name> for Effect best practices and chad's plugin rules.
Do not edit any file. Do not run chad apply, chad revert, or any command that changes chad.

The plugin: <every file of the plugin under /data/repo/work/plugins/>
What it does: <one or two sentences>
What changed: <the whole plugin if new, or what this change touched>

Read these in full first:
- /data/repo/node_modules/effect/AGENTS.md (rules for Effect code; examples are under /data/repo/node_modules/effect/ai-docs/src/)
- /opt/chad/skills/self-edit/plugin.md (rules for chad plugins)
- /data/repo/node_modules/chad/dist/Plugin.d.ts (the plugin API)
Trust these files and the .d.ts files under /data/repo/node_modules over your memory of Effect.

The checklist below shows where to look, not extra rules. Every finding must cite one of the three files above or describe a concrete bug. Only report violations of those sources or real runtime bugs, not patterns the code doesn't need. Check at least:
1. Reusable generator functions use Effect.fn("name") (matching the bound name) or Effect.fnUntraced instead of wrapping Effect.gen. Plain functions returning an Effect without a generator (like Effect.sync(...)) are fine. Don't call .pipe on Effect.fn; pass extra steps as trailing arguments.
2. Custom errors are Schema.TaggedError classes raised with return yield*. Nothing throws, drops errors without reason, or turns recoverable failures into defects. Every tool failure is in its failure schema.
3. External data (HTTP responses, files, stored values, model output) is decoded with Schema instead of hand-parsed or cast with as. Runtime type checks use Predicate, not ad-hoc helpers.
4. Shared behavior uses Context.Service with a static layer built via Layer.effect and returned with .of. Dependencies are provided with Layer.provide, and no service is constructed twice.
5. Resources are properly released (Effect.acquireRelease or a scope for opened resources; Plugin.background for plugin-lived fibers). No unscoped forks during Layer construction.
6. Effect modules are used instead of plain JS equivalents: HttpClient over fetch, FileSystem over node:fs, DateTime and Clock over Date, Effect.sleep and Schedule over setTimeout, and no async/Promise where Effect fits.
7. Effect 4 APIs only. Any Effect 3 import (such as @effect/platform) is a finding, verified against the .d.ts files.
8. Settings use Config, secrets use Config.Redacted, defaults are provided where sensible, and the top-of-file comment lists every setting.
9. plugin.md rules: tool descriptions explain what the tool does and when to call it; side-effecting tools are short or idempotent; durable state lives in the store with backward-compatible decoding and key pruning; hooks stay within time budgets; prompt chunks hold dynamic per-turn state rather than static tool docs; plugin-started turn prompts state what started them and that nobody is around to answer questions.
Report any other bugs you find as well.

Format each finding on its own as:
- where: file:line
- rule: what it breaks plus the file and section stating the rule (not this checklist), or "bug" with what goes wrong
- fix: a concrete change that resolves it without follow-up questions
Skip formatting issues (Prettier owns formatting). If there are no issues, say "no findings".
```

Handling the review report:

- Verify each finding against the code and its cited source. A finding is valid if it breaks a rule in `/data/repo/node_modules/effect/AGENTS.md`, in this file (outside the review prompt), or in the `.d.ts` files, or if it's a real bug. The prompt's checklist is just a guide, not a rule source.
- Fix every valid finding, including small ones. Don't defer them.
- Drop a finding only if it's wrong (misreads the code, cites only the checklist or an invented rule, or asks for something this file forbids like `runMain` or a custom `HttpClient`). Keep a one-line explanation of why you dropped it for your reply.
- Re-run `chad check`. If a fix went beyond the lines a finding pointed to (such as adding new code or shifting responsibilities), run a fresh sub-agent review with the same prompt.
- If a valid finding can't be resolved, leave the plugin as a draft and tell the owner what's still open and why.
- Apply only once all valid findings are fixed. In your reply, note that the review ran, what you fixed, and what you dropped (with reasons).
- In unattended turns (nobody around to answer questions), run the review the same way, and follow the unattended-turn rule in `SKILL.md` for whether to apply.
