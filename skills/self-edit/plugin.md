Before you write a plugin, read `/data/repo/node_modules/effect/AGENTS.md`. It is how Effect is written in the version chad ships. Its examples are under `/data/repo/node_modules/effect/ai-docs/src/`, and the ones a plugin needs are these:

- `/data/repo/node_modules/effect/ai-docs/src/01_effect/03_services/`
- `/data/repo/node_modules/effect/ai-docs/src/01_effect/05_resources/`
- `/data/repo/node_modules/effect/ai-docs/src/50_http-client/10_basics.ts`
- `/data/repo/node_modules/effect/ai-docs/src/71_ai/20_tools.ts`

Trust these files and the `.d.ts` files over what you remember about Effect.

Three things in the examples do not apply to a plugin:

- chad provides `HttpClient`, so do not provide your own.
- chad runs the plugin, so there is no `runMain` or `Layer.launch`.
- You can import only chad's direct dependencies, Node's built-in modules and the npm packages `work/package.json` names.

Read in this order:

1. `/data/repo/node_modules/effect/AGENTS.md`, for how to write Effect.
2. `/data/repo/node_modules/chad/dist/Plugin.d.ts`, `/data/repo/node_modules/chad/dist/Session.d.ts` and `/data/repo/node_modules/chad/dist/Turns.d.ts`, for the plugin API. Their doc comments say what each call does.
3. One bundled plugin as a worked example: `/data/repo/examples/cron/` or `/data/repo/examples/send-file.ts`. These are the plugins chad ships, at the version that is running.

Plugins compile against the effect and chad packages under `/data/repo/node_modules`. Their `package.json` files give the versions, and so does `chad status`. This is Effect 4. Names you remember from Effect 3, such as imports from `@effect/platform` where this version has `effect/http`, are the most common cause of type errors.

A plugin is one TypeScript file, `plugins/<name>.ts`, or a directory with `plugins/<name>/index.ts` and the local files it imports. Its name is the file or directory name. Its default export is a Layer made with `Plugin.make`.

## The shape

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

// The plugin's own service. Built once per load and shared by everything below.
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

const Chunk = Plugin.prompt(() =>
  Effect.succeed("The owner keeps notes. Search them with notesSearch."),
)

export default Plugin.make(NotesTools, Chunk)
```

- Every contribution function returns a Layer. Give it what it needs with `Layer.provide`, then hand every Layer to `Plugin.make`.
- chad supplies `PluginContext`, `Turns`, `Chat`, `HttpClient`, `FileSystem`, `Path` and `DateTime.CurrentTimeZone`. Anything else is yours to provide before `Plugin.make`, which fails to compile and names what is missing.
- Two contributions that provide the same Layer share one instance of it.

## What the loader asks

- No top-level await.
- `import.meta` is empty, so a plugin cannot find files next to itself.
- A plugin can import chad's direct dependencies, Node's built-in modules and the npm packages `work/package.json` names, and nothing else. chad's dependencies are the `dependencies` in chad's `package.json` under `/data/repo/node_modules/`. From chad itself the importable modules are `chad`, `chad/Plugin`, `chad/Session` and `chad/Turns`. Only `chad`, `effect` and Node's built-in modules are promised to stay importable. The other dependencies resolve today and can be gone in a later version.
- A fiber that runs for the plugin's whole life is started with `Plugin.background(effect)`. A fiber forked while the Layer builds runs next to the previous version's for a moment after an apply.

## npm packages

- Every plugin shares one manifest, `work/package.json`, and its lockfile, `work/package-lock.json`. There is no manifest for each plugin. The manifest has `"type": "module"`, or the check fails.
- To add a package, run `npm install --package-lock-only --ignore-scripts <name>` in `work/`. It writes both files and installs nothing. To remove one, run `npm uninstall --package-lock-only <name>`. Then `chad check` and `chad apply` as for any change. Both files are committed with the code, so a revert takes a package back with the plugin that needs it.
- chad installs exactly what the lockfile says, with install scripts off, and bundles each package into the plugin that imports it. A `node_modules` you make under `work/` is never loaded and never committed. Never run `npm install` without `--package-lock-only` there.
- An apply whose lockfile changed downloads the packages, so it needs the network and can take a minute. One whose lockfile did not change installs nothing.
- `chad`, `effect` and chad's other direct dependencies always come from chad, whatever the lockfile says, so a package that uses effect gets the same effect your plugin does. A package that needs a version of one of them that chad's does not satisfy fails the check, which names the package. Pick another version of it or drop it.
- The check lists the packages an apply adds, removes and changes. A failed install fails the check with npm's error, and the plugins that are loaded stay as they are.
- These do not work: a native addon (a `.node` file), a package that needs its install script, a package that reads files next to itself, because the bundle is one file in memory and `import.meta` is empty, and a package with top-level await.

## Tools

- Tool names are shared with every other plugin and with your built-in tools. A taken name fails the load, and the error names who holds it.
- The description is all the model knows about the tool. Say what it does and when to call it. `chad check` reports a description that still starts with "Replace me", and `chad apply` refuses it.
- A tool learns its session and turn by listing `Session.CurrentSession` in its `dependencies`.
- A tool cannot tell you from one of your sub-agents.
- After an apply that changes the plugin's code or its settings, a turn that is still running cannot call its tools until the turn ends.
- A tool call still running 30 seconds into a swap is interrupted and may have partly run. Keep tools with side effects short or safe to repeat.

## Prompt chunks

- `Plugin.prompt(render)` is rendered before every turn, inside 2 seconds. An empty string means no chunk. A render that fails leaves the session with the text it last saw.
- If a chunk has to stay the same for a whole session, keep the text in the store and return what you kept.
- A chunk that changes during a session reaches it as an update message.

## Hooks

- `Plugin.beforeTurn` runs on the reply path, inside 5 seconds. A string it returns is added to the turn as context.
- `turn.prompt` is what chad sends the model. The owner's words are `turn.origin.message.text`, and only when `turn.origin._tag === "Message"`.
- `turn.resumed` is true for a turn picked up after a restart. `beforeTurn` runs again for it.
- `Plugin.afterTurn` runs after the answer is posted, inside 30 seconds, one at a time per plugin. A turn that ends as chad is killed never reaches it.
- `Plugin.onSession` gets `Reset` and `Compacted`, inside 10 seconds. More events may be added, so match with a default.
- A hook that fails or runs past its budget is logged and skipped, and the turn carries on. After three failures in a row of the same hook, chad tells the owner once.
- Nothing held in memory is sure to last from a tool call or `beforeTurn` to `afterTurn`, because an apply can swap the plugin in between. What must last goes in the store.

## State

- `PluginContext.store` is a `KeyValueStore` only this plugin can see, kept in the database.
- It has no expiry. Prune your own keys.
- Queued hooks run on the new version after a reload, so the new version reads keys the old one wrote. Decode stored values with a schema that accepts the old shape.
- `chad db query` reads the database from outside.

## Settings

- `Config.String("url")` reads `plugins.<name>.settings.url` from `chad.json` and nothing else. There is no fallback to the environment.
- A secret is `Config.Redacted("token")`, written as `"${NAME}"` in `chad.json`.
- Give a setting a default where one makes sense, so the plugin loads with an empty `chad.json`.
- List the settings in the comment block at the top of the file. `chad check` prints the keys the plugin read and warns about keys in the file it did not read.
- A change to a setting reloads the plugin, so a running turn loses the plugin's tools until its next turn.

## Starting turns

- `Turns.start({ thread, prompt, label })` runs a turn in that thread's session and posts the answer there.
- The prompt has to say what started the turn and that nobody is there to answer questions, whether the turn comes from `Turns.start`, `Turns.queue` or `Turns.schedule`. The agent reads that line to know it must not apply changes unasked.
- A tool starts a turn with `Turns.queue(options)`, which returns once the request is saved and does not wait for the outcome. `Turns.start` called from a tool for the thread of its own turn fails at once, and the error names `Turns.queue`.
- A background fiber that waits on `Turns.start` loses the outcome at a reload. Read the outcome in `afterTurn` or from the store.
- `Turns.schedule`, `cancel` and `scheduled` are timers that survive a restart.
- A plugin-started turn whose answer is exactly `[SILENT]` posts nothing.
- To post without the agent, use `Chat`.

## The owner

- `PluginContext.owners` holds the owner ids as `<platform>:<id>`.
