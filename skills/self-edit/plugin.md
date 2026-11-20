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
3. One bundled plugin as a worked example: `/data/repo/examples/cron/`, `/data/repo/examples/send-file.ts` or `/data/repo/examples/send-message.ts`. These are the plugins chad ships, at the version that is running. For a plugin that calls an HTTP service, `/data/repo/examples/asphodel/` decodes the service's answers with `Schema` and keeps going when the service is down.

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
- A package that ships no types fails the type-check with TS7016. Add its types too, as `npm install --package-lock-only --ignore-scripts --save-dev @types/<name>`, or write a `declare module` file under `plugins/`.
- An apply whose lockfile changed downloads the packages, so it needs the network and can take a minute. One whose lockfile did not change installs nothing.
- `chad`, `effect` and chad's other direct dependencies always come from chad, whatever the lockfile says, so a package that uses effect gets the same effect your plugin does. A package that needs a version of one of them that chad's does not satisfy fails the check, which names the package, and so does one that asks for one of them by a URL or a path. An npm alias with one of their names on either side fails too, as `fx` for `npm:effect@...` or `semver` for `npm:another-package@...`. An alias of a package to its own name, as `effect` for `npm:effect@^4.0.0`, is checked by its range like any other. Pick another version of it or drop it.
- The check lists the packages an apply adds, removes and changes. A failed install fails the check with npm's error, and the plugins that are loaded stay as they are.
- A package can be a command line tool in place of an import. Its commands are on PATH once the change is applied, and a revert that takes the package out takes them off PATH. A tool that needs its install script does not work. "Command line tools" in `SKILL.md` says more.
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

## Buttons

```ts
import { Plugin, Turns } from "chad"
import { Effect, Schema } from "effect"
import { ChatInteraction } from "effect/chat"

const Approve = ChatInteraction.button("deploy-approve", {
  label: "Approve",
  value: Schema.String, // a key into the store, not the state
})
const Group = ChatInteraction.group(Approve)

const Buttons = Plugin.interactions(
  Group,
  Effect.gen(function* () {
    const turns = yield* Turns.Turns
    // `Group.of` types the handlers. Returned bare from `Effect.gen`, `click` is an implicit `any`.
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

// Posted with Chat, from a tool or a background fiber:
// chat.post(thread, { markdown: "Deploy 42 is ready.", actions: [Approve.of("42")] })
```

- `Plugin.interactions(group, handlers)` registers the handlers of buttons, selects and forms (`ChatInteraction.modal`). It takes what `group.toLayer` takes. Slash commands do not compile.
- The plugin posts its buttons itself, with `Chat`, as a message's `actions`.
- A handler runs only for a click from an owner of the connection. Anyone else's click is answered and the handler is not called.
- Ids are shared with chad's own buttons and every other plugin's. A taken id fails the load, and the error names who holds it.
- A button outlives the version that posted it, and a restart. A click goes by its id to the version loaded when it arrives, so treat an id and its value schema as a stored format. A value that no longer decodes is answered and the handler is not called.
- Keep a key in the value and the state in the store. Discord gives the id and the encoded value about 100 characters together.
- A click on a button whose plugin is not loaded, is off or is held out by safe mode does nothing. A click while chad boots, or while the plugin is being reloaded or applied, waits for the new version and runs on it. Remove buttons that are done with: `chat.edit(thread, messageId, { markdown, actions: [] })`.
- Answer inside 3 seconds. Queue a turn or fork into the plugin's scope for slow work, and answer first. A late click keeps running but a form it opens is dropped, and a late submit is interrupted.
- A handler that fails is logged as an error under the plugin's name and the click is answered.

## The owner

- `PluginContext.owners` holds the owner ids as `<platform>:<id>`.

## Reviewing a plugin

Every change to a plugin's code gets a review by a sub-agent before you apply it. A change to its settings in `chad.json` alone does not. You wrote the code, so a second reader with none of your context finds what you no longer see.

- Start the review once `chad check` passes, so the sub-agent reads the code as Prettier left it and spends nothing on type errors.
- Get the report before you apply, in the same turn. A sub-agent you wait on is the simplest way. One started in the background has to be awaited before the apply too, and the next turn cannot start while it runs.
- The sub-agent reads and reports. It edits no file and runs no command that changes chad: no `chad apply`, `chad revert` or `chad plugin purge`.

The sub-agent has none of your context, so its prompt names everything. Fill in this one:

```text
Review the chad plugin <name> for Effect best practices and for the rules chad sets for plugins.
Do not edit any file. Do not run chad apply, chad revert or any command that changes chad.

The plugin: <every file of the plugin under /data/repo/work/plugins/>
What it does: <one or two sentences>
What changed: <the whole plugin if it is new, or what this change touched>

Read these in full first:
- /data/repo/node_modules/effect/AGENTS.md, the rules for Effect code. Its examples are under /data/repo/node_modules/effect/ai-docs/src/.
- /opt/chad/skills/self-edit/plugin.md, the rules for a chad plugin.
- /data/repo/node_modules/chad/dist/Plugin.d.ts, the plugin API.
Trust these files and the .d.ts files under /data/repo/node_modules over what you remember about Effect.

The list below names where to look. It is not a source of rules. A finding has to cite one of the three files above or describe a concrete bug. Report misuse those sources rule out or that breaks at runtime, not a pattern the code does not need. Look at least at:
1. A reusable function written with a generator uses Effect.fn("name"), with the name it is bound to, or Effect.fnUntraced, and does not only wrap and return an Effect.gen. A function that returns an Effect without a generator, such as Effect.sync(...), is fine. Nothing calls .pipe on an Effect.fn; extra behaviour goes in as its later arguments.
2. A custom error is a Schema.TaggedError class, raised with return yield*. Nothing throws, nothing drops an error without a reason, and nothing turns a failure a caller could handle into a defect. Every failure a tool can have is in its failure schema.
3. Code that relies on the shape of data from outside (HTTP answers, files, stored values, model output) decodes it with Schema first, and does not parse it by hand or cast it with as. Runtime type checks use Predicate, not hand-written helpers.
4. Shared behaviour is a Context.Service with a static layer built by Layer.effect and returned with .of. Layers are given what they need with Layer.provide, and nothing builds the same service twice.
5. Resources are released: Effect.acquireRelease or a scope for what is opened, Plugin.background for a fiber that lives as long as the plugin. No unscoped fork while a Layer builds.
6. Effect's modules in place of their plain JavaScript versions: HttpClient, not fetch; FileSystem, not node:fs; DateTime and Clock, not Date; Effect.sleep and Schedule, not setTimeout; no async functions or Promises where an Effect does.
7. Effect 4 names only. An import from @effect/platform or another Effect 3 name is a finding, checked against the .d.ts files.
8. Settings are read with Config, a secret with Config.Redacted. A setting has a default where one makes sense, and the comment at the top of the file lists every setting.
9. The rules of plugin.md: a tool's description says what it does and when to call it; a tool with side effects is short or safe to repeat; what must last goes in the store, decoded with a schema that accepts the old shape, and old keys are pruned; hooks fit their time budgets; a prompt for a turn the plugin starts says what started it and that nobody is there to answer questions.
Report anything else you see that is a bug, too.

Report each finding on its own, as:
- where: file:line
- rule: what it breaks, and the file and section that state the rule (this list is not one), or "bug" with what goes wrong
- fix: the change that resolves it, concrete enough to make without asking
Do not report formatting, which Prettier owns. If you find nothing, say "no findings".
```

What you do with the report:

- Judge each finding against the code and the source it cites. A finding is valid when the code breaks a rule stated in `/data/repo/node_modules/effect/AGENTS.md`, in this file outside the review prompt, or in the `.d.ts` files, or when it is a bug. The list in the prompt is where the reviewer looks, not a rule of its own.
- Fix every valid finding, small ones included. Do not leave one for later.
- Drop a finding only when it is wrong: it misreads the code, cites only the list in the prompt or a rule no source has, or asks for what this file rules out, such as a `runMain` or an `HttpClient` of your own. Keep one line on why for your answer.
- Then `chad check` again. When a fix did more than change the lines a finding named, such as new code or a moved responsibility, a new sub-agent reviews the plugin with the same prompt.
- A valid finding you cannot resolve keeps the plugin a draft. Tell the owner what is open and why.
- Apply only once every valid finding is fixed. In your answer, say that the review ran, what you fixed and what you dropped and why.
- In a turn with nobody there to answer questions the review runs the same way. Whether you then apply follows the rule for such turns in the self-edit skill.
