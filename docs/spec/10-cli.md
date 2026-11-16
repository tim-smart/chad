# The chad CLI

This part covers the `chad` executable. That means the daemon command `chad serve`, every client command with its synopsis, flags, behaviour and exit codes, how a client reaches the running daemon, what a client does when no daemon runs, and how chad tells the agent's commands from the owner's. It also lists the chat commands and says how the CLI is packaged. The deeper meaning of each command lives in the part that owns it, mainly 08-apply-and-swap.md, 09-repo-and-recovery.md, 12-skills-and-mcp.md, 15-credentials.md, 05-model-and-login.md and 02-storage.md, and each command below points there. The paths named here are relative to the data volume, which is `/data` in the image and is laid out in 01-image-and-volume.md and 02-storage.md.

Three terms recur. The daemon is the long-running chad process that holds the chat connections, the sessions and the loaded plugins. The repo is the git repository on the volume that holds the files chad can change about itself (plugins, skills, `mcp.json`, `chad.json` and `persona.md`). The agent edits its checkout at `repo/work/`, and an apply is the command that checks that checkout and makes the daemon load it.

## One program, two roles

chad ships one executable. Run as `chad serve` it is the daemon. Run with any other command it is a short-lived client that either asks the daemon to do the work or, when no daemon runs, does the small file writes itself. The agent and the owner use the same commands. The agent runs them from its shell inside the container, and the owner runs them from a terminal.

- **CLI-1** There is one `chad` executable. `chad serve` is the daemon and the container's command, and every other command is a client.
- **CLI-2** The agent uses the CLI to change chad. The owner uses it for the same changes and for first setup.
- **CLI-3** A change to what chad loads takes effect only through a CLI command or the chat form of one. There is no file watcher.
- **CLI-4** The CLI does not write a plugin's source. The agent writes the source as files, and the CLI scaffolds a starting file, checks the files and applies them.
- **CLI-5** Plugins add no CLI commands in v1.
- **CLI-6** `chad serve` starts on an empty volume. It creates the directories and the repo with a first commit, runs with no chat connection, and writes the log event `boot.setup-needed`, which says that setup is needed (see 16-failures-logs-status.md). What the first commit holds is in 09-repo-and-recovery.md.
- **CLI-7** The owner runs the CLI inside the running container with `docker exec -it chad chad <command>` or `kubectl exec -it deploy/chad -- chad <command>`, or in a one-off `docker run` against the volume before the first start.

## The socket and effect RPC

A client talks to the daemon over a unix socket on the volume, using effect's RPC module (`effect/rpc`). A command that prints progress, such as an apply, is a streamed call, so its lines reach the terminal as the daemon produces them. In the prototype a line arrived 1 to 3 ms after it was sent.

- **CLI-8** The CLI reaches the daemon over a unix socket at `run/chad.sock` on the volume, speaking effect RPC with streamed calls. chad opens no HTTP port.
- **CLI-9** The environment variable `CHAD_SOCKET` moves the socket to another path. Both the daemon and the CLI read it. It exists for a data path so deep that the socket path passes the platform's limit (CLI-11).
- **CLI-204** The CLI finds the volume the way the daemon does, from the environment variable `CHAD_DATA`, whose default is `/data`, and the default socket path follows it. `CHAD_DATA` moves the daemon's files, the socket and the two links under `repo/` and nothing else, and it is not a supported way to move the volume in the image (see 01-image-and-volume.md).
- **CLI-10** `run/` is a directory of mode 0700, and the daemon sets that mode on every start. The daemon sets the socket to mode 0600 after `listen` and does not change the process umask.
- **CLI-11** `chad serve` checks the socket path before it listens. The limit it checks against is the one of the platform chad runs on, which is 107 bytes on Linux and 103 bytes on macOS. A longer path ends the start with a message that gives the path's length and names `CHAD_SOCKET` as the fix. A filesystem that cannot hold a socket ends it with a message that names the filesystem as unsupported.
- **CLI-213** A `listen` that fails with `EADDRINUSE` or `EACCES` is not a filesystem that cannot hold a socket. It ends the start with the line `chad serve: cannot create the socket <path> (<error code>).` and nothing after it. Every other `listen` error gets the unsupported-filesystem message of 01-image-and-volume.md, with the type of the mount that holds the socket's directory. That message is tested by a unit test of the function that maps the error, because no unprivileged test can mount such a filesystem.
- **CLI-12** When a connect fails with `EINVAL`, the CLI prints the same path-length message as `chad serve`.
- **CLI-13** The daemon removes a socket file left by a killed daemon after it has taken the lock, and never before. A daemon that was refused the lock touches no socket file, so it cannot delete a live one.
- **CLI-14** (a) The daemon listens straight after it has taken the lock and checked `state/version` (the boot order is in 02-storage.md). That is before it checks the shard count, before it opens, copies or migrates the database and before it loads plugins, MCP servers and chat connections. `chad status` therefore answers during boot and names the boot phase, `chad health` passes during boot, and (b) an apply sent during boot waits in the queue behind the boot.
- **CLI-15** The CLI does not retry a connection. When the lock is held and the socket is missing, refuses the connection, or accepts it and gives no answer inside 2 seconds, the CLI says the daemon is "starting or frozen", exits 4 and touches no files.
- **CLI-16** The RPC server interrupts a client's running calls when that client disconnects. A CLI that is killed, by Ctrl-C or by `kill -9`, therefore cancels its call. In the prototype the handler was interrupted within about 15 ms.
- **CLI-17** The daemon writes the log event `rpc.cancelled`, at debug level, each time it interrupts a call because the call's client went away. The server cannot tell a Ctrl-C from a `kill -9` or a dropped connection, so each of them writes the line (see 16-failures-logs-status.md).
- **CLI-19** The RPC client's ping stays at its default of 5 seconds. When the daemon stops answering during a call, or is stopped during one, the CLI exits 4 with a message to run `chad status` and `chad logs`.
- **CLI-20** (a) The daemon logs no RPC request body, no RPC response body and no chat interaction payload. (b) No RPC call returns a stored secret value (see 15-credentials.md). (c) Withdrawn.
- **CLI-205** (a) When a CLI command or (b) a chat command (a) that changes something finishes in the daemon, the daemon writes the log event `command.ran`. The line carries the command, the caller and the outcome, and never a secret's value. The caller is the owner, a session id or the daemon, as `CHAD_SESSION` gives it (see 15-credentials.md and 16-failures-logs-status.md). (c) Withdrawn.
- **CLI-238** `/new` is a chat command that changes something. It writes `command.ran` with the command `/new`, the owner as the caller and the new session's id. `/stop` and `/status` write no `command.ran`.

The wiring the prototypes ran is below. The serialization (newline-delimited JSON) and the header names are the prototypes' choices.

```ts
export const DATA = process.env.CHAD_DATA ?? "/data"
export const SOCKET = process.env.CHAD_SOCKET ?? path.join(DATA, "run", "chad.sock")

// Daemon side.
const server = RpcServer.layer(ChadRpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolSocketServer),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(NodeSocketServer.layer({ path: SOCKET }))
)

// Client side.
const clientLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(NodeSocket.layerNet({ path: SOCKET })),
  Layer.provide(RpcSerialization.layerNdjson)
)

// A plain call and a streamed call. The streamed call's payload is the prototype's stand-in.
Rpc.make("Ping", { success: Schema.String })
Rpc.make("Apply", {
  payload: { label: Schema.String, loadMs: Schema.Number, swapDelayMs: Schema.Number },
  success: Schema.String,
  error: Refused,
  stream: true
})
```

## The version header

A CLI from one image and a daemon from another must not act on each other, because the calls and the files they write may differ between versions.

- **CLI-21** The CLI sends its chad version as a header on every request. The daemon checks it on every call except the calls behind `chad status` and `chad health`. Versions are compared exactly.
- **CLI-22** On a mismatch the command is refused and the CLI says to use `docker exec`, so that the CLI from the daemon's own image is the one that runs. `chad status` and `chad health` still work.
- **CLI-23** (a) `state/version` records the chad version that last wrote the volume. `chad serve` writes it after its migrations. (b) With no daemon running, a CLI that is older than the volume refuses to write. What an older `chad serve` does on a newer volume is in 02-storage.md.
- **CLI-155** A command refused for a version mismatch exits 1.
- **CLI-214** The line for a command refused for a version mismatch is `chad <command>: refused: this CLI is chad <cli> and the daemon is chad <daemon>. Run the command with the daemon's own CLI, for example: docker exec -it chad chad <command>`. It goes to stderr.

```ts
// Client. Sent with every request through RpcClient.withHeaders(headers()).
const headers = (): Record<string, string> => {
  const h: Record<string, string> = { "chad-version": VERSION } // adjusted: TIM-550 item 5, the prototype's test override is removed
  if (process.env.CHAD_SESSION) h["chad-session"] = process.env.CHAD_SESSION
  return h
}

// Daemon. Run at the start of every call except Ping and Status.
const guard = (tag: string, headers: Record<string, string | undefined>) =>
  Effect.suspend(() => {
    const v = headers["chad-version"]
    if (v !== VERSION) {
      return Effect.fail(refused("version", `version mismatch: cli ${v ?? "(none)"}, daemon ${VERSION}; only status and health are allowed`))
    }
    return Effect.void // adjusted: TIM-550 item 2, the daemon no longer refuses a call because it carries a session id
  })
```

## The daemon lock

The lock answers one question for both sides, which is whether a daemon is running on this volume. It is a SQLite write transaction held open on an otherwise empty database file, taken through Node's built-in `node:sqlite`. The operating system drops it when the holder dies, however it dies.

- **CLI-24** The daemon holds a SQLite lock on `state/daemon.lock` for its whole life. After the holder is killed with `kill -9` the lock is free at once.
- **CLI-25** A second `chad serve` on the same volume fails to take the lock and exits 1 before it touches anything else, the socket file included.
- **CLI-26** The lock file is opened with `journal_mode=MEMORY`, so no journal file is ever written next to it. The daemon takes the lock with a 3 second busy timeout, so a CLI that holds the lock for a moment does not make a starting daemon exit. The CLI's test uses no timeout.
- **CLI-27** The daemon keeps the lock's handle referenced for the life of the process and closes it only at exit. Without the reference a garbage collection closed the handle and a second daemon ran on the same volume. The test for this is in 17-testing.md.
- **CLI-28** The CLI tests the same lock by trying to begin a write transaction and rolling it back. A free lock means no daemon. The test takes under 4 ms, still reads "held" when the holder is stopped with SIGSTOP, and creates nothing when the lock file does not exist.
- **CLI-29** The lock holds across two containers that share one volume. This ran on a named volume on ext4 and on tmpfs. The filesystems chad supports are in 01-image-and-volume.md.

```ts
import { DatabaseSync } from "node:sqlite"

const lockPath = path.join(DATA, "state", "daemon.lock") // adjusted: TIM-542 item 3, the prototypes used other directories

// chad serve, before anything else.
const lock = new DatabaseSync(lockPath, { timeout: 3000 }) // adjusted: TIM-550 item 8, 3 second busy timeout
try {
  lock.exec("PRAGMA journal_mode=MEMORY; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;") // adjusted: TIM-550 item 8, journal_mode=MEMORY
} catch {
  // Another chad serve holds the lock. Say so, exit 1, touch nothing else.
}
process.on("exit", () => { try { lock.close() } catch {} }) // this reference is what keeps the lock

// The CLI's test. It never creates the lock file.
const lockState = (): "free" | "held" => {
  if (!fs.existsSync(lockPath)) return "free"
  const db = new DatabaseSync(lockPath, { timeout: 0 })
  try {
    db.exec("PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE; ROLLBACK;") // adjusted: TIM-550 item 8, journal_mode=MEMORY
    return "free"
  } catch {
    return "held"
  } finally {
    db.close()
  }
}
```

## What the CLI does with no daemon

First setup has to work before any daemon has run, and a repair has to work when the daemon will not start. So the commands that only touch files outside the repo work with no daemon, and the commands that load code do not. The two commands that scaffold a file into `work/` are the exception, and they write that file themselves whether or not a daemon runs.

- **CLI-30** (a) The CLI writes files itself only when the lock is free. (b) The exceptions are `chad plugin new` and `chad skill new`, which write into `work/` whatever the lock's state (CLI-156).
- **CLI-31** The commands that work with no daemon are (b) `setup`, (a) the `connection` and `owner` commands, (c) `login`, `logout`, `model`, (b) `secret`, `timezone`, (d) `safe`, (e) `backup`, `restore`, (f) `db`, (g) `plugin new`, `skill new`, and the read-only (a) `status`, (h) `log` and `logs`.
- **CLI-32** `apply`, `check`, `revert`, `plugin reload`, `plugin purge` and `mcp restart` need the daemon. Without it they exit 4 and create nothing on the volume.
- **CLI-33** With no daemon, a command that writes holds the lock while it writes its files, so a daemon cannot start between the test and the write and miss the change. It does not hold the lock while it waits on a person. How long `backup` and `restore` hold it is in CLI-133 and CLI-135.
- **CLI-34** `chad login` with no daemon takes the lock at the moment it stores the token. If a daemon started in the meantime, the command fails with "a daemon started during the login, run chad login again" and exits 1.
- **CLI-35** (a) None of the no-daemon writes needs the database. (b) `chad safe`, `chad model` and `chad timezone` write the small files `state/safe-mode`, `state/model` and `state/timezone` by temp file and rename. (a) The connection commands write `secrets/connections.json`, (b) the secret commands write `secrets/secrets.json` and `chad login` writes `secrets/auth/` (see 02-storage.md).
- **CLI-36** With the daemon running, the same commands ask the daemon to make the change, because a running daemon does not see what another process wrote. A token written or removed by a second process was not seen by a running daemon.
- **CLI-156** `chad plugin new` and `chad skill new` write their file into `work/` in the CLI's own process, whether or not a daemon runs. They take no place in the queue.
- **CLI-157** Both commands exit 4 when `repo/work` does not exist yet, because only `chad serve` creates the repo.
- **CLI-158** `chad plugin purge` needs the daemon and exits 4 without it, because it writes the database, which no write made with no daemon touches, and it has to see what is applied.

## The single queue

Several things change what chad has loaded, and two of them running at once could swap plugins against each other. The daemon therefore runs them one at a time.

- **CLI-37** (a) The daemon has one queue for everything that changes what is loaded. (b) That is `apply`, `check`, `revert`, `plugin reload`, `plugin purge`, `mcp restart`, a secret change, (a) a connection, owner (b) or timezone change, `safe on|off`, and a backup while it copies. (a) Two of them never run at once.
- **CLI-40** A CLI whose command is waiting in the queue prints what it waits on. When the command ahead of it ends or is killed, the waiting one starts. In the prototype it started 14 ms after the first was killed.
- **CLI-41** `chad status`, `chad health`, `chad db query` and `chad db check` never wait in the queue.
- **CLI-159** `chad model`, `chad login` and `chad logout` take no place in the queue, because none of them changes what is loaded.
- **CLI-160** Nothing holds a place in the queue while chad waits on a person or on a remote server.

## Deadlines and a cancelled command

- **CLI-42** (a) The CLI has no deadline of its own once the daemon has answered. The daemon owns the deadlines, and each is a rule of the part named here. They are (b) 30 seconds for one plugin's Layer to build (07-plugin-loading.md) and (c) 15 minutes for a model login (05-model-and-login.md). (d) Withdrawn.
- **CLI-43** A killed CLI cancels its call. An apply cancelled before its commit changes nothing. From its commit on, an apply finishes even when the client has gone. Cancelling the call does not end a model login that the daemon runs (CLI-110).
- **CLI-44** From its commit on, an apply moves `live`, swaps the plugins and writes its log line, the event `apply.done`, inside a region the client cannot interrupt. The reply to the CLI is the only step outside that region. The line an apply run from a session posts in that session's thread (see 16-failures-logs-status.md) is forked into the daemon's scope and is not waited for, so a chat post that hangs cannot block the queue. The region gives way to a graceful stop of the daemon (see 08-apply-and-swap.md).
- **CLI-152** The durations this part names are held in the `Timings` service, and the shipped `chad` has no flag, setting or environment variable that changes one (see 17-testing.md).

## Output and exit codes

- **CLI-45** Output is plain text that a model can read. Colour and spinners appear only when the output is a terminal.
- **CLI-46** (a) `chad status`, (b) `chad log`, (c) `chad logs`, (d) `chad secret list` and (e) `chad db query` take `--json`.
- **CLI-47** Errors go to stderr. An apply or check prints the first 20 errors and a count of the rest. File paths in errors are rewritten from the snapshot that was checked to paths under `work/`, which is where the agent edits.
- **CLI-48** A refusal of an owner command names the command and says to ask the owner to run it.
- **CLI-153** The CLI's error messages are templates in the one `Messages` module, which also holds what chad posts in chat and what the model reads as tool results (see 17-testing.md).
- **CLI-49** (a) A usage error exits 2. effect's CLI module exits 1 for a usage error unless chad maps it. (b) The exception is `chad secret run`, whose own usage errors exit 125 (CLI-103).
- **CLI-50** Every boolean flag is declared with a default, because effect's CLI module treats a bare boolean flag as required.
- **CLI-51** (a) The client commands use the exit codes in the table below and no others. (b) The one exception is `chad secret run`, which passes its child's exit code through, so any code can come out of it.
- **CLI-161** A client command that is ended by a signal exits 130. Ctrl-C gives that code, and so does SIGTERM, because effect's default teardown exits 130 for both. The exception is `chad db query` and `chad db check` while their statement runs. `node:sqlite` holds the CLI's one thread until SQLite returns, so no handler runs and the signal ends the process by its default action, which a shell reports as 130 for Ctrl-C and 143 for SIGTERM. `chad serve` keeps its own codes of 0 and 1.
- **CLI-162** Of the flags that effect's CLI module adds by itself, chad keeps `--help` and `--version` and removes `--completions`, `--wizard` and `--log-level`. `--log-level` would be a second switch next to `CHAD_LOG_LEVEL`, and a wizard would prompt an agent that has no terminal.
- **CLI-216** A usage error prints the usage of the command it was made on and then the error, as effect's CLI module words them, and exits 2. An unknown command is a usage error. `chad` with no command prints the usage and exits 0, as `chad --help` does, and `chad --version` prints `chad v<version>`.

| Code | Meaning | Examples |
| --- | --- | --- |
| 0 | Done. | An apply with nothing changed. `chad status` when the daemon answered. `chad health` when the lock is held and the ping was answered. |
| 1 | The command ran and failed. | A failed check or apply. A reload where one plugin failed to rebuild. `chad login` that lost a race with a starting daemon. A command refused for a version mismatch. `chad safe off` while `CHAD_SAFE_MODE=1` is set. |
| 2 | Bad usage. | An unknown command, a missing argument, a missing answer when there is no terminal. `chad backup -` with stdout on a terminal. A zone that `chad timezone` does not accept. |
| 3 | Refused as an owner command, because `CHAD_SESSION` is set. | `chad model` run by the agent. |
| 4 | The daemon is needed and is missing or silent. | No daemon for `chad apply`. A daemon that is starting or frozen. A daemon that goes away during a call. `chad health` with the lock free. `chad status` when the daemon did not answer. |
| 125 | `chad secret run` was used wrongly or was given a secret name that does not exist. | The message is on stderr and the child is not started. |
| 126 | `chad secret run` found its command and could not execute it. | The command is a file that is not executable. |
| 127 | `chad secret run` did not find its command. | The message is on stderr. |
| 130 | Interrupted by a signal. | Ctrl-C. SIGTERM. For the exception during a `chad db` statement, see CLI-161. |

`chad serve` has its own exit codes, which are 0 for a stop it finished, 1 for a stop cut by its own deadline, 1 when it was refused the lock and 1 when it found a newer `state/version`. They are in 01-image-and-volume.md, 02-storage.md and 16-failures-logs-status.md.

The lines below are the wordings the prototype printed. Only the phrase "starting or frozen" is fixed by a decision. The prototype's owner command was a stand-in named `reload`, and `model` is shown in its place.

```
chad apply: no daemon (lock <volume>/state/daemon.lock is free)
chad apply: daemon is starting or frozen (lock held, no answer on <socket> in 2s)
chad model: refused: 'model' is an owner command and this shell belongs to agent session <session id>
waiting on: <the command ahead> (at step <step>)
chad serve: the socket path <path> is <n> bytes and a unix socket path holds <limit>. Set CHAD_SOCKET to a shorter path, for example /tmp/chad.sock.
```

## CHAD_SESSION and owner commands

chad marks every process that a session starts with an environment variable, `CHAD_SESSION`. A session is one conversation with the agent (see 03-sessions-and-turns.md). The CLI reads the marker to tell a command typed by the owner from a command run by the agent, and refuses a short list of commands to the agent. These are the commands that could cut the owner off from chad or hand out everything on the volume.

- **CLI-52** chad gives clanka a process spawner that adds `CHAD_SESSION=<session id>` to every process a session starts. That covers `bash`, background `bash`, `run`, `rg` and `gh`, the commands of a sub-agent, which carry the parent session's id, and background jobs.
- **CLI-53** The spawner adds the variable with `extendEnv: true`, so the child keeps the rest of its environment. Each session has its own executor, because clanka reads the spawner once when an executor is built.
- **CLI-54** The same spawner sets `TZ` to the stored owner timezone on a session's processes (see 01-image-and-volume.md).
- **CLI-55** `chad serve` sets `CHAD_SESSION=daemon` in its own environment when it starts. The function `runDaemon`, which `chad serve` calls, is what sets it (see 17-testing.md). Children that clanka starts outside the spawner, which is how it starts stdio MCP servers, then carry a marker too, and a session's spawner overrides it with the session id. A process that has called `runDaemon` carries the marker itself, so a test that runs the daemon in its own process starts the CLI without the variable when it acts as the owner (see 17-testing.md). The variable is never set as an image `ENV`, because every `docker exec` shell would then be refused.
- **CLI-56** An unset `CHAD_SESSION` means a terminal. For the owner-command refusal the CLI treats any value, `daemon` included, as the agent.
- **CLI-57** The owner commands are (b) `setup`, (a) the `connection` and `owner` commands, (c) `login`, `logout`, `model`, (d) `restore`, and `backup` to stdout. (a) The CLI refuses them with exit 3 when `CHAD_SESSION` is set. (d) `backup` to stdout is on the list because the tar would land in the model's context and in the stored history.
- **CLI-58** (a) Every other command is open to the agent, (b) including `secret`, `timezone`, `safe`, `plugin purge`, `db`, `logs` and `backup <path>`.
- **CLI-59** Only the CLI refuses. The daemon does not refuse a call because it carries a session id. The CLI still sends the session id with every request, because the apply record and the line of CLI-150 use it.
- **CLI-60** `CHAD_SESSION` has two more uses. An apply records it as the session that ran the apply. A command that posts the line of CLI-150 uses it to find the thread.
- **CLI-150** A command run from a session that changes what is loaded or deletes stored data posts one subtext line in that session's thread when it succeeds. The commands are `apply`, `revert`, `safe on|off`, `plugin purge`, `secret rm` and `timezone`. The same command from the owner's shell posts nothing, a command that fails and changes nothing posts nothing, and an apply with nothing changed posts nothing. A command that stored its change and exits 1 because some plugins kept their previous version does post the line, and the line names those plugins (see 08-apply-and-swap.md). `/safe on|off` typed in chat posts no such line, because its own output is already in the thread. The wording is in 16-failures-logs-status.md.
- **CLI-61** The refusal is not a security boundary. The agent can read a secret file if it goes looking, and it can get round a refusal by unsetting the variable or by writing the file itself. In the prototype `env -u CHAD_SESSION chad <owner command>` from a session's shell was accepted. v1 does not stop either. The refusals stop an agent that is confused or was told something by a web page. A real boundary would need the agent's scripts to run outside the daemon's process.
- **CLI-62** When the agent should hold back from an open command is a rule in the bundled `self-edit` skill and not a check in the CLI. The skill tells the agent that an unattended turn does not apply, revert, purge or change safe mode, and when it may run `chad safe off` (see 14-self-edit-skill.md).

```ts
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"

export const addSession = (id: string) => { // adjusted: TIM-550 item 4, only the extendEnv form is kept
  const go = (cmd: ChildProcess.Command): ChildProcess.Command => {
    if (cmd._tag === "PipedCommand") {
      return ChildProcess.pipeTo(go(cmd.left), go(cmd.right), cmd.options)
    }
    const hadEnv = cmd.options.env !== undefined
    return ChildProcess.make(cmd.command, cmd.args as any, {
      ...cmd.options,
      env: { ...cmd.options.env, CHAD_SESSION: id },
      extendEnv: hadEnv ? cmd.options.extendEnv : true
    })
  }
  return go
}

// One per session, provided to that session's executor.
export const layerSessionSpawner = (id: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const inner = yield* ChildProcessSpawner.ChildProcessSpawner
      const add = addSession(id)
      return ChildProcessSpawner.make((cmd) => inner.spawn(add(cmd)))
    })
  )
```

## Command reference

The table lists every command in v1. "No daemon" says what the command does when the lock is free. "Agent" says whether the agent may run it, which means whether it runs with `CHAD_SESSION` set. "Queue" says whether the command takes a place in the daemon's queue when a daemon is running. The rules for each group follow the table.

| Command | No daemon | Agent | Queue | Owning part |
| --- | --- | --- | --- | --- |
| `chad serve` | is the daemon | not applicable | not applicable | 01-image-and-volume.md |
| `chad setup [--discord-token-file <path>] [--owner <id>] [--timezone <zone>] [--skip-login]` | works | owner only | as the commands it runs | this part |
| `chad status [--json]` | prints from files, exits 4 | yes | no | 16-failures-logs-status.md |
| `chad health` | exits 4 | yes | no | 01-image-and-volume.md |
| `chad check` | exits 4 | yes | yes | 07-plugin-loading.md, 09-repo-and-recovery.md |
| `chad apply -m <why>` | exits 4 | yes | yes | 07-plugin-loading.md, 08-apply-and-swap.md, 09-repo-and-recovery.md |
| `chad revert [<commit>]` | exits 4 | yes | yes | 09-repo-and-recovery.md |
| `chad log [--limit <n>] [--json]` | works | yes | no | 09-repo-and-recovery.md |
| `chad logs [--turn <id>] [--session <id>] [--plugin <name>] [--event <prefix>] [--level <level>] [--since <time>] [-f\|--follow] [--json]` | works | yes | no | 16-failures-logs-status.md |
| `chad safe [on\|off]` | works | yes | yes, for `on` and `off` | 09-repo-and-recovery.md |
| `chad plugin new <name> [--dir]` | works, and exits 4 when `repo/work` is missing | yes | no | 14-self-edit-skill.md |
| `chad plugin reload <name>` | exits 4 | yes | yes | 08-apply-and-swap.md |
| `chad plugin purge <name>` | exits 4 | yes | yes | this part, 11-settings.md |
| `chad skill new <name>` | works, and exits 4 when `repo/work` is missing | yes | no | 12-skills-and-mcp.md |
| `chad mcp restart` | exits 4 | yes | yes | 12-skills-and-mcp.md |
| `chad secret set <NAME> [--note <text>]` | works | yes | yes | 15-credentials.md |
| `chad secret list [--json]` | works | yes | no | 15-credentials.md |
| `chad secret rm <NAME>` | works | yes | yes | 15-credentials.md |
| `chad secret run --env VAR=NAME [--stdin NAME] -- <command>` | works | yes | no | 15-credentials.md |
| `chad model [<spec>]` | works | owner only | no | 05-model-and-login.md |
| `chad login` | works | owner only | no | 05-model-and-login.md |
| `chad logout` | works | owner only | no | 05-model-and-login.md |
| `chad timezone [<zone>]` | works | yes | yes | this part |
| `chad connection add discord [--name <n>] [--token-file <path>]` | works | owner only | yes | this part |
| `chad connection add local [--name <n>]` | works | owner only | yes | this part, 17-testing.md |
| `chad connection list` | works | owner only | no | this part |
| `chad connection check [<name>]` | works | owner only | no | this part |
| `chad connection token <name> [--token-file <path>]` | works | owner only | yes | this part |
| `chad connection remove <name> [--force]` | works | owner only | yes | this part |
| `chad owner add <connection> <id>` | works | owner only | yes | this part |
| `chad owner remove <connection> <id> [--force]` | works | owner only | yes | this part |
| `chad db query "<sql>" [--limit <n>] [--json]` | works | yes | no | 02-storage.md |
| `chad db check` | works | yes | no | 02-storage.md |
| `chad backup <path> [--no-home] [--sessions]` | works | yes | yes, until the tar is written | 02-storage.md |
| `chad backup - [--no-home] [--sessions]` (the tar on stdout) | works | owner only | yes, until the tar is written | 02-storage.md |
| `chad restore <tar>` | only with no daemon | owner only | not applicable | 02-storage.md |

### Apply, check, revert and log

An apply is the only way an edit in `repo/work/` reaches the running daemon. The order of an apply's steps is in 07-plugin-loading.md, and what a session sees afterwards is in 08-apply-and-swap.md. The repo, what an apply checks and commits, and safe mode are in 09-repo-and-recovery.md. The rules here are what the commands take, print and return.

- **CLI-63** `chad apply` requires `-m <why>`. The apply records the message and the session that ran it, taken from `CHAD_SESSION`.
- **CLI-64** An apply with nothing changed exits 0 and makes no commit.
- **CLI-65** An apply covers the whole of `work/`, so it takes another session's draft with it. Its output lists every changed file. v1 has no apply limited to paths.
- **CLI-66** A failed apply changes nothing, prints the errors and exits 1. There is no flag that skips a check. The one exception is an apply that fails from its commit on, as when the volume fills. It exits 1, and its message says that the commit was made and that it loads at the next start (see 09-repo-and-recovery.md).
- **CLI-67** An apply fails on a type error, a default export that is not a `Plugin.Plugin`, a plugin with top-level await, an import of a package the image does not ship, a plugin Layer that fails to build or takes more than 30 seconds, a tool name clash, a malformed `mcp.json`, a stdio entry in `mcp.json` with a relative `cwd`, a `chad.json` that breaks the rules in 11-settings.md, a repo plugin that has a bundled plugin's name, a plugin that exists both as `plugins/<name>.ts` and as `plugins/<name>/index.ts`, a `${NAME}` in a plugin's settings that resolves nowhere, a tool whose description starts with "Replace me", a plugin whose file or directory name breaks the name rule of CLI-85, a file named `AGENTS.md` or a directory named `.agents` or `.kiro` anywhere in the exported tree or on disk in `repo/work/`, and a malformed skill. The look on disk means that an `AGENTS.md`, `.agents` or `.kiro` which `.gitignore` keeps out of the export fails the apply as well. The message for `AGENTS.md`, `.agents` and `.kiro` names `skills/` and `persona.md` as the places for what they would hold. That refusal, with the two directories its look on disk leaves out, and the one for a plugin's name are in 07-plugin-loading.md. A malformed skill is one with no front matter, a missing or empty `name` or `description`, a name that differs from its directory, or a name that two skills in the repo share (see 12-skills-and-mcp.md). An MCP server that fails to connect does not fail an apply, and neither does a `${NAME}` in `mcp.json` that resolves nowhere, which leaves that one server unavailable (see 12-skills-and-mcp.md).
- **CLI-68** chad rewrites the errors of its own check steps so that they say the fix. A top-level await error names the line. A missing module error lists what can be imported. A tool name clash names who holds the name. The "Replace me" error says to describe the tool or delete it, and a skill name mismatch says to set `name: <dir>`.
- **CLI-69** When a type error is in a file under `plugins/`, a failed `chad check` or `chad apply` ends with one line that names the path of effect's `AGENTS.md`. The line is printed once.
- **CLI-70** A successful apply prints the commit and what changed per plugin, skill and MCP server. It names the plugins it rebuilt, says that a deleted plugin's data and timers are kept, says when a repo skill hides a bundled one, and prints each MCP server's status and tool count when `mcp.json` changed. It ends by saying that sessions pick the change up on their next message and that this turn keeps the tools it has.
- **CLI-71** The apply output also says how long the apply waited for work in flight, names any call it interrupted, and names the sessions with a running turn that the change affects, counting their sub-agents and background tasks. Per plugin it lists the settings keys the plugin read while loading, marks a key that took its default as "(default)", and warns about keys in `chad.json` that were not read. It shows key names and where each value came from and never a value. The warning never fails an apply. When a plugin is turned back on, the output says how many overdue held timers will fire.
- **CLI-72** An apply in safe mode runs every check, commits and moves `live`, and loads nothing from the repo. Its output says the change loads when safe mode goes off. One thing takes effect at once, which is a flipped `enabled` flag of a bundled plugin in `chad.json`.
- **CLI-73** `chad check` does everything an apply does up to the commit and throws the result away. The two differ on one finding only, which is a tool whose description starts with "Replace me" (CLI-163).
- **CLI-74** For `mcp.json`, `chad check` calls clanka's `McpConfig.load` on the snapshot's file, checks that every `${NAME}` resolves, and prints which servers an apply would add, remove or change. A `${NAME}` that resolves nowhere is printed as a warning that names the server and the name, and the check still exits 0, because the apply goes ahead and lists that server as unavailable (see 12-skills-and-mcp.md). The check connects nothing, and its output says so.
- **CLI-75** `chad check` reports a tool whose description starts with "Replace me", fails on a malformed skill as an apply does, and prints the same settings listing as an apply.
- **CLI-163** `chad check` exits 0 when its only finding is a tool whose description starts with "Replace me".
- **CLI-164** The line `chad check` prints for that finding says that `chad apply` will refuse it.
- **CLI-76** `chad revert` goes back to the applied commit before the current one, and `chad revert <commit>` to an earlier one. A revert covers the whole repo, runs the same checks and load as an apply, and is recorded as a new commit, so reverting a revert works. A target that no longer loads fails like any apply and changes nothing.
- **CLI-77** A revert resets `work/` after saving what was there to a git ref, and names that ref in its output.
- **CLI-78** A revert in safe mode follows the apply rule. It checks, commits, moves `live` and loads nothing until safe mode goes off, and it still resets `work/` after saving what was there.
- **CLI-79** An apply never commits, and a revert never changes, the chat connections, the owner ids or the secrets. They live outside the repo.
- **CLI-80** `chad log` lists the applied commits. It reads the repo, so it works with no daemon, and it takes `--json`.
- **CLI-165** `chad log` prints one line per applied commit, newest first, with the short commit id, the time, the session that ran the apply or "terminal", and the first line of the `-m` message.
- **CLI-166** With `--json`, `chad log` prints an array with one object per commit. Each object holds the same fields in full, with the full commit id.
- **CLI-167** `chad log` prints the newest 20 commits unless `--limit <n>` is given, as `chad db query` limits its rows.
- **CLI-168** `chad log` reads every field from the commit itself and from no other store, so it prints the same with no daemon and after a restore. Where an apply writes those fields is in 09-repo-and-recovery.md.

### Safe mode

- **CLI-81** `chad safe on|off` turns safe mode on or off. The toggle is stored in `state/safe-mode`, so it survives a restart. The environment variable `CHAD_SAFE_MODE=1` forces safe mode on whatever the stored value is. What safe mode loads is in 09-repo-and-recovery.md.
- **CLI-82** `chad safe off` loads `live` the way a boot does. It skips what fails to load, names it, and never refuses, except while `CHAD_SAFE_MODE=1` is set (CLI-169). `chad safe on` unloads what came from the repo. Each is one swap through the queue, and each session sees the result on its next turn.
- **CLI-83** There is no command that reloads everything, because `chad safe on` followed by `chad safe off` does that.
- **CLI-169** While `CHAD_SAFE_MODE=1` is set, `chad safe off` changes nothing, the stored toggle included. It prints a line that names the variable and exits 1, so the agent is not told that safe mode went off. `/safe off` gives the same line. The rule is in 09-repo-and-recovery.md.
- **CLI-170** `chad safe` with no argument prints whether safe mode is on and what turned it on, and changes nothing (see 09-repo-and-recovery.md).

### Plugins and skills

- **CLI-84** `chad plugin new <name>` writes `plugins/<name>.ts` into `work/`, or `plugins/<name>/index.ts` with `--dir`. `chad skill new <name>` writes `skills/<name>/SKILL.md` into `work/`. Neither does anything else, so the new file is a draft until an apply.
- **CLI-85** A plugin or skill name is made of lower-case letters, digits and hyphens. Both commands refuse a name that is taken or that a bundled plugin or skill uses. The rule on a plugin's name holds for every plugin in the repo and not only for one that `chad plugin new` wrote (see 07-plugin-loading.md).
- **CLI-86** The file `chad plugin new` writes is a working plugin that passes `chad check` as written. It has one tool named `<camelName>Hello`, one setting with a default, a comment block that lists the plugin's settings, a comment that lists the other kinds of contribution, and a header that names the `self-edit` skill and effect's `AGENTS.md`. `--dir` writes the same file as `index.ts`. The tool's description starts with "Replace me", which is what an apply refuses. The file itself is in 14-self-edit-skill.md.
- **CLI-87** The output of `chad plugin new` prints the path of effect's `AGENTS.md` and names `/data/repo/examples/`, where the bundled plugins' source can be read.
- **CLI-249** `chad plugin new` exits 2 on a name that breaks the name rule, and exits 1 on a bundled plugin's name or a taken one. A name is taken when `work/plugins/` holds `<name>.ts` or an entry named `<name>`. Each refusal writes nothing and prints one line on stderr.
- **CLI-88** An apply reloads a plugin when its code or its settings changed. `chad plugin reload <name>` rebuilds one plugin whose code did not change. It builds the new instance first. If the build fails, the plugin keeps its old version and the command exits 1 and names the plugin and the error.
- **CLI-89** Deleting a plugin's file and applying unloads the plugin and keeps its data and timers, held like those of a plugin that is off. `chad plugin purge <name>` drops the plugin's key-value table and its timers.
- **CLI-90** `chad plugin purge` refuses a plugin that is still in the applied repo. That includes a repo plugin that is turned off with `"enabled": false`. A bundled plugin is never in the applied repo and has its own rule (CLI-173).
- **CLI-171** `chad plugin reload <name>` also builds a plugin that a boot skipped and loads it when the build succeeds (see 09-repo-and-recovery.md).
- **CLI-172** `chad plugin reload <name>` refuses a plugin that is off. It exits 1 and says the plugin is off in `chad.json` (see 11-settings.md).
- **CLI-173** `chad plugin purge <name>` refuses a bundled plugin that is on and allows one that is turned off with `"enabled": false`. A bundled plugin cannot be deleted, so off is the nearest it comes to deleted, and a loaded plugin never loses its data and timers underneath it. A purge prints what it deleted, with the jobs and the timers counted. The rule is in 11-settings.md, and the cron plugin's jobs are in 13-timers-and-cron.md.
- **CLI-247** `chad plugin purge <name>` prints "Purged <name>: its key-value table and its <n> keys are deleted.", with "key" for one, when it drops the table. A plugin still in the applied repo gets "<name> is still in the applied repo, so its data stays. Delete its file in work/, run chad apply, then purge it." and a bundled plugin that is on gets "<name> is a bundled plugin and it is on, so its data stays. Turn it off with "enabled": false in work/chad.json, run chad apply, then purge it.", each on stderr with exit 1.
- **CLI-248** `chad plugin purge <name>` of a plugin that has no key-value table prints "Nothing is stored for <name>.", exits 0 and posts no line in a session.

### MCP servers

MCP (Model Context Protocol) servers are external tool servers listed in `mcp.json` at the repo root. Their loading and what a running turn sees during a restart are in 12-skills-and-mcp.md.

- **CLI-91** The one MCP command is `chad mcp restart`. A server is added, changed or removed by editing `mcp.json` and applying. There is no `chad mcp add`.
- **CLI-92** `chad mcp restart` rebuilds the MCP layer, which restarts every server and not one. Nothing restarts a dropped server by itself.

### Secrets

A secret is a named value in `secrets/secrets.json`, mode 0600, outside the repo. Settings and `mcp.json` refer to one as `${NAME}`. The whole design is in 15-credentials.md.

- **CLI-95** Secrets are stored in `secrets/secrets.json`, mode 0600.
- **CLI-96** Settings that are not secrets live in `chad.json` in the repo, edited in `work/` and applied like `mcp.json`. A setting that is a secret names it as `${NAME}` (see 11-settings.md).
- **CLI-97** (a) There is no `chad secret get`. chad's commands never print a stored value. chad masks nothing in its output. `chad secret run -- printenv` does print a value, (b) and the `credentials` skill names that route so the agent avoids it. (a) The check that no command prints a stored value is in 17-testing.md.
- **CLI-98** `chad secret set <NAME>` takes the value from stdin or from a hidden prompt and never as an argument.
- **CLI-99** A secret's name matches `[A-Z_][A-Z0-9_]*` and is 64 characters at most. `chad secret set` also refuses the name `CHAD_DOLLAR`, which is reserved (see 11-settings.md).
- **CLI-100** `--note <text>` stores a note. `set` on an existing name replaces the value and says so. It keeps the note unless `--note` is given, and `--note ""` clears it.
- **CLI-101** `chad secret list` prints each secret's name, note and date, and takes `--json`. `chad secret rm <NAME>` deletes a secret.
- **CLI-102** (a) With the daemon running, `set` and `rm` reload the plugins whose settings name that secret (b) and rebuild the MCP layer if `mcp.json` names it, (a) and print what they reloaded. A plugin that fails to load with the new value keeps its old version, the command exits 1 and names the plugin and the error, and the secret stays stored.
- **CLI-103** `chad secret run --env VAR=NAME [--stdin NAME] -- <command>` runs the command with the named secrets in its environment, or one secret on its stdin. The CLI reads `secrets/secrets.json` itself, with or without a daemon. A name that does not exist exits 125 with the message on stderr, and so does a usage error of `run` itself. A command that is not found exits 127, and one that is found and cannot be executed exits 126. Otherwise the child's own exit code passes through (see 15-credentials.md).

### Model and login

- **CLI-106** `chad model <spec>` stores a model override in `state/model`. The spec is in clanka's format, `<provider>/<model>[/<effort>]`. The override wins over the `CHAD_MODEL` environment variable. When a session that is already open picks the override up is in 05-model-and-login.md.
- **CLI-107** Before storing, `chad model <spec>` makes one small request on the new model and keeps the old one if that fails. If the provider needs a login and none exists, the login runs first.
- **CLI-108** `chad model` with no argument shows the current model and whether chad is logged in.
- **CLI-109** `chad login` prints the verify URL and the code in the terminal, and `chad logout` clears the token. With the daemon running the CLI asks the daemon to run the login or the logout. With no daemon the CLI runs the flow itself and writes the same token store, `secrets/auth/`.
- **CLI-110** The 15 minute login timeout is the daemon's. Killing the CLI does not cancel a login that the daemon runs. It removes that waiter only, and the login runs until it completes or its 15 minutes end (see 05-model-and-login.md).
- **CLI-111** `chad logout` does not stop a running turn, and the CLI says so.
- **CLI-112** First setup does not have to include the model login. A missing login is asked for on the first owner message (see 05-model-and-login.md).
- **CLI-178** With no daemon, the CLI makes the trial request of CLI-107 itself, the way `chad login` runs its flow itself (see 05-model-and-login.md).
- **CLI-179** `chad model` with no argument is refused to the agent, as `chad model <spec>` is. `chad status` already shows the agent the model.
- **CLI-180** With no daemon, `chad login` ends after the same 15 minutes, which the CLI takes from `Timings` (see 05-model-and-login.md).
- **CLI-181** `chad model` and `/model` take flags that set and clear the model overrides for sub-agents and for the summarizer. The flags and their rules are in 05-model-and-login.md.

### Timezone

- **CLI-113** `chad timezone <zone>` stores the owner's timezone in `state/timezone`. The `TZ` environment variable is the default, and UTC applies when neither is set. The agent may run the command.
- **CLI-114** With the daemon running, a timezone change reloads every plugin in one swap, the way an owner change does. A plugin that fails to rebuild keeps its old version, the change stays stored, and the command exits 1 and names the plugin and the error. Plugins read the timezone as `DateTime.CurrentTimeZone` (see 06-plugin-api.md).
- **CLI-115** A timezone change reaches the nightly prune of old sessions at the next restart (see 02-storage.md).
- **CLI-182** `chad timezone <zone>` accepts a named zone that Node's `Intl` accepts and exits 2 for anything else. It refuses an offset such as `+05:00`, which `Intl` takes on Node 26.8.2, because an offset is not an IANA name and is wrong as the `TZ` that session processes get.
- **CLI-183** `chad timezone <zone>` stores the name that `Intl` resolves the given zone to.
- **CLI-184** `chad timezone` with no argument prints the zone in force and whether it came from `state/timezone`, from `TZ` or from the UTC fallback.
- **CLI-185** A `TZ` value that is not a valid zone falls through to UTC, and the no-argument form says so.
- **CLI-239** `chad timezone <zone>` prints "Timezone set to <zone>." with the name it stored. A zone it refuses gets "chad timezone: "<zone>" is not a named timezone. Give an IANA name such as Europe/Berlin." on stderr. With the daemon running, each plugin that kept its previous version adds one line "<plugin>: <error>" on stderr.
- **CLI-240** `chad timezone` with no argument prints one line: "<zone>, set with chad timezone.", "<zone>, from TZ. Nothing is set with chad timezone." or "UTC, the fallback. Nothing is set with chad timezone and TZ is not set.", where the last says "TZ=<value> is not a valid zone" in place of "TZ is not set" for a `TZ` that names no zone.
- **CLI-241** A `state/timezone` that cannot be read, or that holds no zone `chad timezone` would take, counts as nothing stored, so the daemon still boots and the CLI answers with the zone from `TZ` or UTC.

### Connections and owners

A connection is one chat platform's token together with the ids of the owners allowed to talk to chad on it. Connections are stored in `secrets/connections.json`, outside the repo. v1 ships one chat platform, Discord (see 04-discord.md), and one connection kind for development and tests, `local` (see 17-testing.md).

- **CLI-116** The commands are `chad connection add discord [--name <n>] [--token-file <path>]`, `chad connection add local [--name <n>]`, `connection list`, `connection check [<name>]`, `connection token <name> [--token-file <path>]`, `connection remove <name>`, and `chad owner add|remove <connection> <id>`. A connection's name defaults to its platform. The store can hold more than one connection.
- **CLI-117** A token is never a command argument, and no environment variable supplies a Discord token in v1.
- **CLI-118** A token is checked against the platform before it is saved, and the old token is kept if the check fails. With no daemon the CLI makes the check itself. With the daemon running the daemon makes it (CLI-120), before the change takes its place in the queue, so that the queue is not held while chad waits on the platform (CLI-160).
- **CLI-119** Removing the last owner id of a connection, or the last connection, needs `--force`.
- **CLI-120** (a) With the daemon running, a connection or owner change applies at once with no restart. The daemon checks the token and swaps that connection's gateway. (b) An owner change reloads the plugins, which read the owner ids as `PluginContext.owners`. When an owner was removed and a plugin fails to rebuild, that plugin is unloaded, so it cannot keep answering the removed person.
- **CLI-151** `chad connection add local` adds a connection of the kind `local`, which is the adapter for development and tests. The adapter in the daemon is a client of a platform that listens on the unix socket `run/local.sock` on the volume. That path is fixed and no option moves it. The platform is not in the image, and chad ships no interactive client for it (see 17-testing.md).
- **CLI-154** The list of owners is by id and nothing else. `chad owner add` has no flag for bots and says nothing special when the id belongs to a bot (see 04-discord.md).
- **CLI-186** `chad connection add discord` without `--token-file` and `chad connection token <name>` read the token the way `chad secret set` reads a value, from stdin when stdin is not a terminal and from a hidden prompt otherwise.
- **CLI-187** `chad connection token <name>` also takes `--token-file <path>`.
- **CLI-188** `chad connection add local` takes no token, and the check of CLI-118 does not apply to it.
- **CLI-189** An owner of a local connection is added with `chad owner add <connection> <id>`, where the id is the author id the platform sends. A local connection goes through the same owner check as a Discord one.
- **CLI-190** With the daemon running, `chad connection remove <name>` also deletes that connection's rows of Discord shard state (see 02-storage.md).
- **CLI-206** With no daemon, `chad connection remove <name>` leaves that connection's rows of Discord shard state where they are, so the command needs no database (CLI-35).
- **CLI-207** At boot the daemon deletes the rows of Discord shard state that belong to a connection that is no longer in `secrets/connections.json`.
- **CLI-208** `chad connection add discord` prints an invite URL for the bot once the token has passed the check of CLI-118. The URL is Discord's OAuth2 authorize URL for the bot's application, with the scopes `bot` and `applications.commands` and the permissions from the one list in 04-discord.md. The owner opens it to add the bot to a server.
- **CLI-209** With the URL, `chad connection add discord` names each privileged intent in that list, because an invite URL cannot grant a privileged intent. A missing one is what the log event `chat.refused` reports (see 16-failures-logs-status.md).
- **CLI-217** The refusal of an owner command (CLI-48) is one line on stderr, `chad <command>: refused: '<command>' is an owner command and this shell belongs to agent session <session>. Ask the owner to run it.`, where `<command>` is the command without its arguments, such as `connection add`, and `<session>` is the value of `CHAD_SESSION`. The CLI refuses before it tests the lock, reads a file or reads a token.
- **CLI-218** When the daemon goes away during a call of a `connection` or `owner` command, the CLI prints `chad <command>: the daemon went away during the call` on stderr and exits 4.
- **CLI-219** A `connection` or `owner` command that writes with no daemon and finds no directory at the data path writes nothing, prints `chad <command>: <data> does not exist. Mount the data volume there or set CHAD_DATA.` on stderr and exits 1. It never creates the data directory.
- **CLI-220** The refusal of CLI-23 is the line `chad <command>: refused: this CLI is chad <cli> and the volume was written by chad <volume>. Use a chad of that version or a newer one.` on stderr, with exit 1. The two versions are compared by semver precedence. A volume with no `state/version` has been written by no daemon and takes the write. A `state/version` that holds no version is refused the same way, with what the file holds as `<volume>`. Only a write is refused, so `chad connection list` and `chad connection check` still read.
- **CLI-221** A `connection` or `owner` command that writes with no daemon takes the lock after it has read its token and after the check of CLI-118, and holds it for the write alone. When a daemon has taken the lock by then, the command writes nothing, prints `chad <command>: a daemon started during the command, run chad <command> again` on stderr and exits 1.
- **CLI-222** A file that a `connection` or `owner` command needs and cannot read, which is the file `--token-file` names, `state/version` or `secrets/connections.json`, ends the command with `chad <command>: cannot read <path> (<error code>)` on stderr and exit 1. A `secrets/connections.json` that is not the JSON object of 02-storage.md ends it with `chad <command>: <path> is not a connections file` on stderr and exit 1. Neither changes anything. A `secrets/connections.json` that is missing is no connection and no error.
- **CLI-223** A token is trimmed of the white space around it, so a file or a pipe may end in a newline. When nothing is left, the command prints `chad <command>: no token was given` on stderr and exits 2. The hidden prompt of CLI-186 reads `Discord bot token`, and a prompt that is ended with Ctrl-C exits 130.
- **CLI-224** A `connection` or `owner` command that is refused changes nothing, prints one line on stderr and exits 1, and the line is the same whether the CLI or the daemon refused. The lines are `chad <command>: '<name>' is not a connection name. A name is made of lower-case letters, digits and hyphens.`, `chad <command>: there is already a connection named <name>`, `chad <command>: there is already a local connection, <name>, and run/local.sock serves one`, `chad <command>: there is no connection named <name>`, `chad <command>: <name> is a local connection and has no token`, `chad <command>: <name> is the last connection. Pass --force to remove it.`, `chad <command>: <id> is the last owner of <name>. Pass --force to remove it.`, `chad <command>: Discord refused the token (<status>). Nothing was changed.` and `chad <command>: the token could not be checked (<detail>). Nothing was changed.`.
- **CLI-225** A `connection` or `owner` command that made its change prints one line on stdout and exits 0. The lines are `connection <name> added (<kind>)`, `connection <name> has a new token`, `connection <name> removed`, `owner <id> added to <connection>` and `owner <id> removed from <connection>`. After its first line `chad connection add discord` prints `invite: <url>` and `intents: turn on <names> for the bot in the Discord developer portal, because an invite URL cannot grant a privileged intent`. The URL is `https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot+applications.commands&permissions=<permissions>`, and the names are the ones Discord's developer portal gives the switches, joined by a comma and a space, which for chad's list is `Message Content Intent`. A connection that was just added has no owner.
- **CLI-226** `chad connection list` prints one line on stdout for each stored connection, in the order they were added, as `<name> (<kind>) owners: <ids>`. The ids are joined by a comma and a space, and a connection with no owner reads `owners: none`. With no stored connection it prints `no connections`. It never prints a token. With the daemon running it asks the daemon, and with no daemon it reads the file.
- **CLI-227** A line of `chad connection check` is `<name> (<kind>): ok`, `<name> (<kind>): failed: Discord refused the token (<status>)`, `<name> (<kind>): failed: the token could not be checked (<detail>)` or `<name> (<kind>): failed: nothing accepts a connection on <socket>: <error code>`.
- **CLI-228** `chad connection check [<name>]` checks every stored connection, or the one that is named, and changes nothing. For a Discord connection it checks the stored token the way CLI-118 does (CLI-234). For a `local` connection it tries whether `run/local.sock` accepts a connection. With the daemon running the daemon makes the checks, and with no daemon the CLI does. It prints one line on stdout for each connection (CLI-227) and never a token, or `no connections` when none is stored. It exits 0 when every check passed and 1 when one failed or when no connection has the name.
- **CLI-229** A `connection` or `owner` command that reaches the daemon while it boots waits until the stored connections have loaded and is made then, as an apply waits behind the boot (CLI-14).
- **CLI-230** When no daemon answered, `chad status` prints one `connection: <name> (<kind>)` line for each connection in `secrets/connections.json`, after its `version:` line.
- **CLI-231** A connection's name follows the name rule of CLI-85, which is lower-case letters, digits and hyphens, and no two connections share a name. `chad connection add` refuses any other name (CLI-224).
- **CLI-232** The store holds at most one connection of the kind `local`, because `run/local.sock` is one path (CLI-151). `chad connection add local` refuses a second one (CLI-224).
- **CLI-233** `chad owner add` with an id that is on the connection's list already, and `chad owner remove` with an id that is not on it, change nothing and exit 0. They print `owner <id> is already an owner of <connection>` and `owner <id> is not an owner of <connection>` on stdout.
- **CLI-234** The check of CLI-118 is one request, `GET /applications/@me` on Discord's REST API with the token. An answer of 200 that names the application passes, and the application's id is the `client_id` of the invite URL. An answer of 401 is a token Discord refuses, and `<status>` in the line of CLI-224 is 401. With any other answer, or with none, the token could not be checked, and `<detail>` is the status of the answer or the request's own error. Both leave everything as it was.
- **CLI-235** The `command.ran` line of a `connection` or `owner` command carries `command`, which is one of `connection add`, `connection token`, `connection remove`, `owner add` and `owner remove`, `caller`, `outcome` and `connection`, which is the connection's name. `caller` is `owner` when the request carried no session id, and otherwise the session id as the request carried it, which is `daemon` for a command the daemon's own process ran. `outcome` is `changed`, `unchanged` for a change that found nothing to change (CLI-233) or `refused`, and a refused line also carries the `reason`. `chad connection list` and `chad connection check` change nothing and write no line.
- **CLI-236** With the daemon running, `chad connection add` connects the new connection at once, `chad connection remove` closes that connection's gateway, or its socket to the local platform, at once, and `chad connection token` closes that connection's gateway and opens another with the new token, which starts from the shard state stored under the connection's name. No other connection is touched by any of the three.

A remove followed by an add under the same name, with no daemon running in between, keeps the old bot's resume state. No rule covers that case. Discord answers the stale state with an invalid session and dfx identifies again, and the scenario that shows it is listed in 17-testing.md.

### Setup

- **CLI-121** `chad setup` is a wizard over the other commands and is safe to run again. It asks for the Discord bot token and checks it. It asks for the owner's Discord user id and the timezone. It offers the model login, which can be skipped.
- **CLI-122** Setup turns Discord's message content intent on for the bot when Discord allows it, and says where to click when it does not. This runs against a real bot only in the hand checks (see 17-testing.md).
- **CLI-123** Every question has a flag. The flags are `--discord-token-file`, `--owner`, `--timezone` and `--skip-login`. With no terminal, a missing answer fails and names its flag, so setup can run without a terminal when every flag is given.
- **CLI-124** Setup is an owner command. It works with the daemon running and in a one-off container before the first start.
- **CLI-191** On a run after the first, each question of `chad setup` shows the stored value and keeps it on an empty answer.
- **CLI-192** The token question never prints the token. It says that one is stored and names the bot.
- **CLI-193** `--owner` is given once. Further owners are added with `chad owner add`.
- **CLI-194** A run after the first only adds or replaces, and only after the check of CLI-118, so it cannot remove an owner or a token by accident.
- **CLI-195** With no terminal, `chad setup` exits 0 when every answer is already stored.
- **CLI-210** `chad setup` prints no invite URL of its own. The owner sees the URL and the privileged intents in the output of `chad connection add discord` (CLI-208), which setup runs for the token.
- **CLI-242** With no terminal, `chad setup` checks its answers before it changes anything and exits 2 with one line, "chad setup: there is no terminal to ask on, so give <flags>", that names every missing flag: `--discord-token-file` when no Discord connection is stored, `--owner` when that connection has no owner, and `--skip-login` when the model needs the Codex login and no login is stored. The timezone is never missing, because a zone is always in force, so with no `--timezone` setup leaves it as it is.
- **CLI-243** `chad setup` works on the first stored connection of kind `discord`, and adds one named `discord` when there is none. A token it is given for a stored connection replaces that connection's token as `chad connection token` does, and an owner it is given is added as `chad owner add` does.
- **CLI-244** Setup turns the message content intent on by setting the `GATEWAY_MESSAGE_CONTENT_LIMITED` flag of the bot's application with `PATCH /applications/@me`, which Discord allows for an app in fewer than 100 servers. It prints "Message Content Intent turned on for the bot.", or "Message Content Intent is on for the bot." when the flag was set already. When Discord refuses, it prints the bot's page in the developer portal, `https://discord.com/developers/applications/<application>/bot`, as the place to click.
- **CLI-245** A run of `chad setup` prints the invite URL only when it adds the connection, as `chad connection add discord` does. A run that keeps the stored token or replaces it prints none (CLI-G25).
- **CLI-246** Setup's other lines are "A Discord bot token is stored for connection <name>, the bot <bot>." for a stored token, without the bot when the check fails, "The token is the bot <bot>'s." after a new token, "The owners of <name> stay <ids>." for kept owners, the line of CLI-240 for a kept timezone, and "The Codex login is skipped. Run chad login when you want it." for `--skip-login` or a declined offer.

### Status and health

- **CLI-125** `chad status` shows (a) whether the daemon is up, (b) whether safe mode is on, (c) the applied commit, (d) whether `work/` holds a draft, (e) each plugin and why a skipped one was skipped, (f) each MCP server, (g) the model and the login state, and (h) each connection. (i) It exits 0 when the daemon answered and 4 when it did not, and (j) it prints what it can read from files either way.
- **CLI-126** `chad status` also shows the boot phase while the daemon is booting, chad's version and effect's, the error when the database cannot be opened or migrated, and the filesystem warning. It lists a plugin that is turned off as "off" with its count of held timers, and marks a plugin that kept its old version as "running with the previous <secret|timezone|owners|instance>: <error>". It lists the settings keys each loaded plugin read, at load and at call time since the load, with where each value came from and never a value. It marks a repo skill that hides a bundled one. The full contents are in 16-failures-logs-status.md.
- **CLI-127** `chad health` tests the lock and then sends one ping. It exits 0 only when the lock is held and the daemon answers the ping inside 2 seconds. A daemon that has lost its lock fails the check even when it still answers. The command prints one line and checks nothing else.
- **CLI-128** A failed `chad health` exits 4. That includes the case where the lock is free and the daemon still answers.
- **CLI-212** A `chad health` that passes prints the one line `chad health: ok` on stdout. One that fails prints one line on stderr, which is the no-daemon line when the lock is free and the "starting or frozen" line when the lock is held and no answer came (see "Output and exit codes").
- **CLI-215** `chad status` prints one fact to a line, as `<name>: <value>`, on stdout. The first line is `daemon:`, and it reads `up (<phase>)` when the daemon answered, `not running (lock <path> is free)` when the lock is free, and `starting or frozen (lock held, no answer on <socket> in 2s)` when the lock is held and no answer came. The second line is `version:`. When the daemon answered it reads `chad <version>, effect <version>`, with the daemon's own two versions. Otherwise it reads `chad <version>, volume written by chad <version>`, with the CLI's version and what `state/version` holds, or `chad <version>, volume not written yet` when that file is missing. When the daemon answered, one `filesystem:` line follows for each filesystem warning and then one `connection: <name> (<kind>)` line for each connection. What a later slice adds to `chad status` gets lines of the same form.
- **CLI-237** With `--json`, `chad status` prints the same facts as one JSON object on one line, and exits as it does without the flag. The object's `daemon` is `up`, `none` or `silent`. With `up` it also holds `version`, `effect`, `phase`, `filesystem`, which is an array of the warnings, and `connections`, which is an array of objects with a `name` and a `kind`. With `none` it holds `lock`, `version`, `volume` and `connections`, and with `silent` it holds `socket`, `seconds`, `version`, `volume` and `connections`. `volume` is what `state/version` holds, and `null` when that file is missing, and `connections` is then what `secrets/connections.json` holds, in the same form.
- **CLI-129** Against a daemon stopped with SIGSTOP, `chad health` exited 4 after 2.44 seconds. It starts in 117 ms in the image. Its use as the liveness probe is in 01-image-and-volume.md.
- **CLI-148** `chad status` and `/status` carry a "Problems" block, which comes first, and a "Recent" block. `chad status` also shows each plugin's count of warnings and errors since it loaded, with the latest line. What the blocks hold is in 16-failures-logs-status.md.
- **CLI-211** The "Problems" block needs no database for the conditions that the running daemon can answer from memory or from files, and an unusable database is one of those. A condition that only its stored row remembers, such as a failed prune or a notice that could not be delivered, is shown from that row, so it is missing while the database cannot be used. Which condition is of which kind is in 16-failures-logs-status.md.

### The daemon's log

The daemon writes its log to the files `logs/chad.log*` on the volume. `chad logs` is how the owner and the agent read them. The log's format, what each filter matches and what a printed line looks like are in 16-failures-logs-status.md.

- **CLI-146** `chad logs` prints the daemon's log, one line a person can read per entry, and takes the filters in the synopsis below. With no filter it prints the last 200 entries.
- **CLI-147** `chad logs` runs in the client. It reads the files `logs/chad.log*` itself, with or without a daemon, so it never waits in the queue. It never writes them, because only the daemon writes the log. The agent may run it.
- **CLI-196** `--level <level>` is a minimum, so `chad logs` prints the entries at that level and above. The level names are the ones `CHAD_LOG_LEVEL` takes (see 16-failures-logs-status.md).
- **CLI-197** `--since <time>` takes a duration such as `15m` or `2h`, or an ISO 8601 time.
- **CLI-198** `-f` has the long form `--follow`.
- **CLI-199** `chad logs` exits 0 when nothing matches, exits 2 for a `--level` or `--since` value it does not accept, and never exits 4.
- **CLI-200** Which flags count as filters, how filters combine, what `-f` prints before it follows and how a time with no offset is read are in 16-failures-logs-status.md.

```
chad logs [--turn <id>] [--session <id>] [--plugin <name>] [--event <prefix>] [--level <level>] [--since <time>] [-f|--follow] [--json]
```

### Database, backup and restore

What a backup holds and what a restore rebuilds are in 02-storage.md. The rules here are the commands' flags and how they sit next to a daemon.

- **CLI-130** `chad db query "<sql>"` runs the SQL on its own read-only connection. It prints at most 200 rows unless `--limit` is given, and takes `--json`. It is the way the agent reads the database.
- **CLI-131** `chad db check` runs an integrity check on request. Nothing checks integrity at boot. It runs in the CLI's own process on a read-only connection, as `chad db query` does, and never through the daemon (see 02-storage.md).
- **CLI-132** `chad backup` writes one tar to a path or to stdout. `--no-home` leaves `home/` out, and `sessions/` goes in only with `--sessions`. The tar holds tokens, so it is a secret.
- **CLI-133** `chad backup` copies the database in the CLI's own process on a read-only connection. With a daemon running it first takes a place in the daemon's queue and holds it until the tar is written. With no daemon it holds the lock for the whole copy.
- **CLI-134** From `repo/`, `chad backup` takes `repo/work/` with its `.git` and nothing else, so drafts in `work/` are in the tar. The first boot after a restore rebuilds `versions/`, `live` and the `node_modules` link from the head of the `applied` branch.
- **CLI-135** `chad restore <tar>` works only on an empty volume with no daemon running, and refuses while the daemon's lock is held. What counts as an empty volume is in 02-storage.md. The owner restores from a one-off container with the daemon stopped. It holds the lock for the whole copy. A restore into an image older than the database is refused.
- **CLI-136** chad schedules no backups. The examples that run `chad backup` on a schedule are in 01-image-and-volume.md.
- **CLI-201** The stdout form is `chad backup -`. `chad backup` with no path is a usage error and exits 2.
- **CLI-202** `chad backup -` exits 2 when stdout is a terminal, so a tar that holds tokens never lands on a terminal (see 02-storage.md).

### Commands v1 does not have

- **CLI-137** (a) v1 has no `plugin list`, `plugin enable`, `plugin disable` or `plugin remove`, no `mcp add`, no `config` command, no `chad turns` command, no session commands, no command that reloads everything, no command that starts a turn from outside, no commands for scheduled jobs, and no merge or diff command for skills. (b) A plugin is turned off in `chad.json` (see 11-settings.md), and (c) scheduled jobs are managed through the cron plugin's tools (see 13-timers-and-cron.md). (d) The `turns` table is read with `chad db query`, which works with no daemon, and (e) the bundled `diagnose` skill carries the queries (see 16-failures-logs-status.md).

## Chat commands

A few commands can be typed in chat. They are plain text that chad matches after it strips the mention, and they are not Discord slash commands. They never reach the model.

- **CLI-138** The chat commands are (a) `/new`, `/stop`, (b) `/safe [on|off]`, (c) `/model [<spec>]` and (a) `/status`. (d) Withdrawn. `/new` and `/stop` are in 03-sessions-and-turns.md.
- **CLI-139** `/safe`, `/model` and `/status` run the same daemon calls as `chad safe`, `chad model` and `chad status` and print the same text.
- **CLI-149** `/status` renders with no database and no model. It answers when the database cannot be used and when the model is down, which is when the owner has little else to go on in chat (see 16-failures-logs-status.md).
- **CLI-141** (a) No other CLI command has a chat form. There is no `/revert`, `/login`, `/logout` or `/logs`. (b) The route from a phone after a bad change is `/safe on`, then asking chad to revert or fix it.
- **CLI-203** How chad matches a chat command, what trailing text does and what a command does in a plain channel with no session are in 03-sessions-and-turns.md.

## How the CLI is packaged

A client command pays Node's start-up cost on every run, and `chad health` runs every 30 seconds as a probe. Bundling the client into one file cuts that cost. The daemon is not bundled, because plugins must share the daemon's single copy of effect (see 07-plugin-loading.md).

- **CLI-142** The client commands are bundled by esbuild into one file with effect inside it.
- **CLI-143** The `chad` bin is a few lines of plain JavaScript. With `serve` as the first argument it imports the daemon's entry point, which is not bundled. Otherwise it imports the bundled client. The daemon never runs a bundled copy of effect.
- **CLI-144** chad does not use Node's compile cache.
- **CLI-145** `chad health` started in 429 ms not bundled and in 128 ms as a bundle of 710 kB, against 33 ms for an empty script. In the image it started in 117 ms.

```js
#!/usr/bin/env node
// bin/chad.js, as the image prototype ran it.
if (process.argv[2] === "serve") {
  await import("../dist/daemon.js") // adjusted: TIM-558 item 13, runDaemon sets CHAD_SESSION=daemon and the bin does not
} else {
  await import("../dist/cli.bundle.js")
}
```

```
esbuild src/cli.ts --bundle --platform=node --format=esm --target=node26 --outfile=dist/cli.bundle.js
```

## Gaps

- **CLI-G1** [builder] The list of RPC calls and their payloads. The header names `chad-version` and `chad-session` and the newline-delimited JSON serialization come from the prototypes and were not put to anyone (TIM-542 and TIM-550, "Not settled here").
- **CLI-G12** [builder] The exact wording of most CLI output, which covers the owner refusal, the apply's closing sentence, the line a waiting command prints, the health line, the settings listing and the layout of `chad status` (TIM-542 item 28, TIM-548 "Not settled here"). For these messages the spec has no wording. Recommended: the builder writes each message it words into this part as a new rule that gives its text, the way 19-build-order.md has a builder record a choice the owner can see.
- **CLI-G24** [builder] Whether a command that runs with no daemon leaves a `command.ran` line. CLI-205 has the daemon write the event, and CLI-147 says that only the daemon writes the log, so a change made with no daemon leaves no line as the rules stand (TIM-559 round 2 R4, TIM-557 item 10). It is also not said whether `/new` and `/stop` are chat commands that change something. Recommended: `/new` writes the event and `/stop` does not (see 16-failures-logs-status.md). CLI-238 settles `/new` and `/stop`, and CRED-138 settles `chad secret`.
- **CLI-G25** [builder] Whether `chad connection token`, `chad connection check` and a later run of `chad setup` that keeps the stored token print the invite URL again, and the exact form of the URL's query string. The ruling has `chad connection add discord` print the URL and gives its scopes and the source of its permissions (TIM-559 round 3 A4). CLI-245 settles it for `chad setup`.
- **CLI-G26** [builder] What `chad connection check [<name>]` does. It has a synopsis and a row in the command table, and no rule says what it checks, whether it asks a running daemon, what it prints or what it exits with. Recommended: it checks each stored token the way CLI-118 does and, for a `local` connection, whether `run/local.sock` accepts a connection, prints one line per connection and never a token, and exits 1 when one fails (TIM-542 item 17, TIM-559 cold read).
- **CLI-G27** [builder] Which characters a connection's name may hold. The name prefixes the keys of the Discord shard state (see 02-storage.md), and with free names `discord` is a prefix of `discord2`, so the boot cleanup of CLI-207 could keep or delete the wrong rows. Recommended: the name rule of CLI-85, which is lower-case letters, digits and hyphens. The form of the prefix and its separator is a gap of 02-storage.md (TIM-559 cold read).
- **CLI-G28** [builder] What a refused connection or owner command exits with, and what counts as refused. The cases are the last owner or the last connection removed without `--force` (CLI-119), a connection added under a name that is taken, a connection name that does not exist, an owner id that is already listed, and a second `local` connection, which would share the one `run/local.sock` (CLI-151). Recommended: exit 1 for each refusal, exit 0 and no change for an id that is already listed, and a second `local` connection refused (TIM-559 cold read).
- **CLI-G29** [builder] What a command that writes with no daemon does when a daemon started between its test of the lock and its write. CLI-34 answers for `chad login` only, and `chad connection add discord` also prompts and checks a token over the network before it takes the lock (CLI-33). Recommended: the command fails as `chad login` does, with exit 1 and the same message under its own name (TIM-550 item 9, TIM-559 cold read).
- **CLI-G30** [builder] What "older than the volume" means in CLI-23. No rule says what a chad version looks like, how two versions are ordered, or what the CLI does when `state/version` is missing or cannot be read. The question and its recommendation are a gap of 02-storage.md, which owns that file. Recommended here: a write that the CLI refuses for this reason exits 1 (TIM-542 item 5, TIM-559 cold read).
- **CLI-G31** [builder] Which `listen` errors count as a filesystem that cannot hold a socket in CLI-11, and how that is tested when no unprivileged test can mount such a filesystem. Recommended: every `listen` error other than `EADDRINUSE`, `EACCES` and the length check gets that message, with the mount type that 01-image-and-volume.md reads, and the test is a unit test of the function that maps the error (TIM-550 item 6, TIM-559 cold read).
- **CLI-G32** [builder] Whether a command of a later slice exists before its slice is delivered. The rules that list commands (CLI-31, CLI-32, CLI-46, CLI-57, CLI-58, CLI-137 and CLI-138) name commands of every slice. Recommended: the CLI registers only the commands delivered so far, so a later one is an unknown command and exits 2, and each of those rules is lettered by command with the letters held (see 19-build-order.md). In chat, the matcher takes every command of CLI-138 from the `turns` slice on and answers one that is not delivered yet with a line that says so, so that its text never reaches the model (TIM-559 cold read).
- **CLI-G33** [builder] How a test drives what the client does by itself. With no daemon the CLI makes its own network calls (the token check of CLI-118, the trial request of CLI-178 and the login of CLI-109) and reads its durations from `Timings` (CLI-15, CLI-127, CLI-180), and no rule gives the client an entry that takes a fake `HttpClient` and scaled durations, as `runDaemon` takes them for the daemon. Recommended: one function `runCli(inputs)` that the bin calls with the real values, with its inputs listed in 17-testing.md beside those of `runDaemon` (TIM-558 item 17, TIM-559 cold read).

## Provenance

| Rule | Source | Agreed by | Support | Changed by | Kind | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| CLI-1 | TIM-542 item 1 | Tim | run |  | `rule` | `harness` |
| CLI-2 | Agreed at charting | charting | not run |  | `definition` | - |
| CLI-3 | Agreed at charting, TIM-542 body | charting | not run |  | `rule` | `apply` |
| CLI-4 | Agreed at charting | charting | not run |  | `definition` | - |
| CLI-5 | TIM-530 item 9 | Tim | not run |  | `rule` | `plugin-api` |
| CLI-6 | TIM-542 item 32, TIM-559 round 2 R4 for the event name | Tim; the event name Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-7 | TIM-542 item 32, TIM-541 item 20 | Tim; the documented command lines Architect (Tim has not read) | not run |  | `rule` | `image` |
| CLI-8 | TIM-542 item 2, TIM-550 item 1 | Tim | run |  | `rule` | `cli` |
| CLI-9 | TIM-542 item 2, TIM-553 item 11, TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Tim; the reason and the answer Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | run | TIM-553 | `rule` | `cli` |
| CLI-10 | TIM-550 item 6 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-11 | TIM-550 item 6, TIM-553 item 11, TIM-559 round 2 R5 | Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-12 | TIM-550 item 6 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-13 | TIM-550 items 6 and 8 | Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-14 | TIM-550 item 7, amended by TIM-559 ruling on IMG-G5 and STO-G5, amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-15 | TIM-542 item 3, TIM-550 item 7 | Tim; the no-retry rule Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-16 | TIM-542 item 6, TIM-550 item 1 | Tim | run |  | `fact` | `cli` |
| CLI-17 | TIM-550 item 13, TIM-559 round 2 R4 for the event name, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-19 | TIM-550 item 10, amended by TIM-559 ruling on CLI-G21 | Architect (Tim has not read) | not run |  | `rule` | `kills` |
| CLI-20 | TIM-546 item 21, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-21 | TIM-550 item 5 | Architect (Tim has not read) | run | TIM-550 | `rule` | `cli` |
| CLI-22 | TIM-542 item 5 | Tim | run |  | `rule` | `cli` |
| CLI-23 | TIM-542 item 5, TIM-541 item 14 | Tim; the file `state/version` Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-24 | TIM-542 item 3, TIM-536 item 18 | Tim | run |  | `rule` | `cli` |
| CLI-25 | TIM-542 item 3, TIM-550 item 8, amended by Tim's ruling that safe mode never starts by itself, chat 2026-11-16 | Tim; exit 1 and the order Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-26 | TIM-550 item 8 | Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-27 | TIM-553 item 5 | Architect (Tim has not read) | run |  | `rule` | `kills` |
| CLI-28 | TIM-542 item 3, TIM-550 item 1 | Tim | run |  | `rule` | `cli` |
| CLI-29 | TIM-550 item 1 | Architect (Tim has not read) | run |  | `rule` | `image` |
| CLI-30 | TIM-542 item 3, amended by TIM-559 ruling on CLI-G6 | Tim; the exception for `plugin new` and `skill new` Architect (Tim has not read) | run | TIM-559 | `rule` | `cli` |
| CLI-31 | TIM-542 item 24 and follow-up point 1, TIM-557 item 11, TIM-559 ruling on CLI-G6 | Tim; `timezone`, `backup`, `restore` and `db` confirmed by Architect (Tim has not read); `logs`, `plugin new` and `skill new` Architect (Tim has not read) | not run | TIM-557, TIM-559 | `rule` | `cli` |
| CLI-32 | TIM-542 items 24 and 27, TIM-537 comment "From TIM-542", TIM-559 ruling on CLI-G6, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Tim; `plugin purge` Architect (Tim has not read) | run |  | `rule` | `apply` |
| CLI-33 | TIM-550 item 9, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-34 | TIM-550 item 9 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| CLI-35 | TIM-536 items 1 and 2 | Tim | not run |  | `rule` | `cli` |
| CLI-36 | TIM-535 CLI section, TIM-544 "What ran" | Tim | run |  | `rule` | `cli` |
| CLI-37 | TIM-542 item 4, TIM-547 item 1, TIM-559 ruling on CLI-G6 | Tim; `safe on`, `safe off` and `plugin purge` in the queue Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-40 | TIM-542 item 4, TIM-550 item 1 | Tim | run |  | `rule` | `apply` |
| CLI-41 | TIM-542 items 20 and 21 | Tim | not run |  | `rule` | `apply` |
| CLI-42 | TIM-542 item 6, TIM-559 cold read, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Tim | not run |  | `rule` | `cli` |
| CLI-43 | TIM-542 item 6, TIM-550 item 1, TIM-559 cold read | Tim | run |  | `rule` | `apply` |
| CLI-44 | TIM-550 item 11, amended by TIM-557 item 39, TIM-559 round 2 R4 for the event name | Architect (Tim has not read) | not run | TIM-550 | `rule` | `apply` |
| CLI-45 | TIM-542 item 26 | Tim | not run |  | `rule` | `cli` |
| CLI-46 | TIM-542 items 18 and 26, TIM-557 item 11 | Tim; `chad logs` Architect (Tim has not read) | not run | TIM-557 | `rule` | `cli` |
| CLI-47 | TIM-542 item 26, TIM-534 item 3, TIM-538 item 6 | Tim | run |  | `rule` | `apply` |
| CLI-48 | TIM-542 item 28 | Tim | not run |  | `rule` | `cli` |
| CLI-49 | TIM-550 item 13, amended by TIM-559 ruling on CRED-G11 | Architect (Tim has not read) | run | TIM-559 | `rule` | `cli` |
| CLI-50 | TIM-550 item 13 | Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-51 | TIM-542 item 27, TIM-550 item 10, TIM-553 item 6, TIM-546 item 7, TIM-559 ruling on CLI-G5 and CRED-G11 | Tim for 0 to 4; the added meanings of 4 and the codes 125, 126, 127 and 130 Architect (Tim has not read) | run | TIM-546, TIM-559 | `rule` | `cli` |
| CLI-52 | TIM-542 item 29, TIM-550 items 1 and 4 | Tim | run |  | `rule` | `cli` |
| CLI-53 | TIM-550 item 4 | Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-54 | TIM-541 item 19, TIM-553 item 13 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CLI-55 | TIM-550 item 3, TIM-558 item 13, TIM-559 cold read | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-56 | TIM-542 item 29, TIM-550 item 3 | Tim; the `daemon` value Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-57 | TIM-542 item 30, TIM-534 item 12, TIM-535 CLI section | Tim | run |  | `rule` | `cli` |
| CLI-58 | TIM-542 item 30, TIM-549 round 1 corrections, TIM-557 item 11, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Tim; `logs` Architect (Tim has not read) | not run | TIM-557 | `rule` | `cli` |
| CLI-59 | TIM-550 item 2, TIM-557 item 39, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Architect (Tim has not read) | run; the session line not run | TIM-550 | `rule` | `cli` |
| CLI-60 | TIM-542 item 29, TIM-550 item 3, TIM-546 item 13, TIM-557 item 39, TIM-559 ruling on CLI-G13, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Tim; the `daemon` value, `secret request` and the session line Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| CLI-61 | TIM-542 item 31, TIM-550 item 2 | Tim | run |  | `rule` | `cli` |
| CLI-62 | TIM-549 items 8 and 9 | Architect (Tim has not read) | not run |  | `rule` | `bundled-skills` |
| CLI-63 | TIM-542 item 9, TIM-534 item 9 | Tim | not run |  | `rule` | `apply` |
| CLI-64 | TIM-542 item 9 | Tim | not run |  | `rule` | `apply` |
| CLI-65 | TIM-542 item 9 | Tim | not run |  | `rule` | `apply` |
| CLI-66 | TIM-531 item 5, TIM-534 item 4, TIM-538 item 6, amended by TIM-559 ruling on REC-G20 | Tim; the failure from the commit on Architect (Tim has not read) | run | TIM-559 | `rule` | `apply` |
| CLI-67 | TIM-534 item 4, TIM-538 items 2 and 5, TIM-542 item 6, TIM-548 items 5 and 11, TIM-546 item 8, TIM-549 items 18 and 19, TIM-559 ruling on LOAD-G9, MCP-G12 and MCP-G14, TIM-559 round 3 A1 and A2, TIM-559 round 4 item 7, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Tim; the `chad.json`, TOTP, "Replace me" and skill checks, the two forms of one plugin, the relative `cwd`, the unresolved name in `mcp.json`, the name rule and the refusal of `AGENTS.md`, `.agents` and `.kiro` Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-68 | TIM-549 item 20 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-69 | TIM-549 item 3 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-70 | TIM-542 items 12 and 28, TIM-538 item 3, TIM-537 items 3, 6 and 11, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Tim | not run |  | `rule` | `apply` |
| CLI-71 | TIM-547 item 9, TIM-552 item 6, TIM-548 items 8, 14 and 15 | Architect (Tim has not read); "sub-agents" in the count agreed by Tim | run |  | `rule` | `apply` |
| CLI-72 | TIM-542 item 25, TIM-548 item 9 | Tim; the `enabled` exception Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| CLI-73 | TIM-542 item 8, amended by TIM-559 ruling on CLI-G11 and SELF-G2 | Tim; the one finding that differs Architect (Tim has not read) | not run | TIM-549, TIM-559 | `rule` | `apply` |
| CLI-74 | TIM-542 follow-up point 3, TIM-537 comment "From four tickets", amended by TIM-559 ruling on MCP-G12 | Architect (Tim has not read) | read |  | `rule` | `skills-mcp` |
| CLI-75 | TIM-549 items 18 and 19, TIM-548 item 14 | Architect (Tim has not read) | not run | TIM-549 | `rule` | `skills-mcp` |
| CLI-76 | TIM-534 item 9 | Tim | not run |  | `rule` | `apply` |
| CLI-77 | TIM-534 item 9 | Tim | not run |  | `rule` | `apply` |
| CLI-78 | TIM-542 follow-up point 4, TIM-548 item 9 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-79 | TIM-534 items 9 and 11, TIM-537 item 13, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Tim | not run |  | `rule` | `apply` |
| CLI-80 | TIM-534 item 9, TIM-542 items 24 and 26 | Tim | not run |  | `rule` | `apply` |
| CLI-81 | TIM-534 item 6, TIM-536 item 2 | Tim | not run |  | `rule` | `apply` |
| CLI-82 | TIM-542 item 25, TIM-547 item 1, TIM-534 item 6, TIM-559 round 3 C2 | Tim; the single swap path and the exception while `CHAD_SAFE_MODE=1` is set Architect (Tim has not read) | run | TIM-559 | `rule` | `apply` |
| CLI-83 | TIM-542 item 10 | Tim | not run |  | `rule` | `apply` |
| CLI-84 | TIM-542 item 11 | Tim | not run |  | `rule` | `skills-mcp` |
| CLI-85 | TIM-542 item 11, TIM-559 round 3 A2 | Tim; the name rule for every plugin in the repo Architect (Tim has not read) | not run |  | `rule` | `skills-mcp` |
| CLI-86 | TIM-549 items 17 and 18, TIM-548 item 16 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-87 | TIM-549 item 3 and comment "From Tim: the bundled plugins' source is reached at repo/examples" | Architect (Tim has not read); the `/data/repo/examples/` path Tim | not run |  | `rule` | `apply` |
| CLI-88 | TIM-542 item 10, TIM-547 item 14, TIM-552 body and "What ran" | Tim; the exit code and the kept version Architect (Tim has not read) | run |  | `rule` | `apply` |
| CLI-89 | TIM-542 item 12, TIM-540 comment "Changed by TIM-542" | Tim | not run |  | `rule` | `timers-cron` |
| CLI-90 | TIM-542 item 12, TIM-548 item 7, TIM-559 round 3 C7 | Tim; the off plugin and the pointer to the bundled plugin's rule Architect (Tim has not read) | not run | TIM-548 | `rule` | `settings` |
| CLI-91 | TIM-542 item 13, TIM-537 item 5, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Tim | not run |  | `rule` | `skills-mcp` |
| CLI-92 | TIM-537 item 6, TIM-549 round 1 corrections, TIM-555 rule 1 | Tim | run |  | `rule` | `skills-mcp` |
| CLI-95 | TIM-542 item 14 | Tim | not run |  | `rule` | `settings` |
| CLI-96 | TIM-542 item 15, amended by TIM-548 | Tim; the file name `chad.json` Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-97 | TIM-542 item 14, TIM-546 item 2, TIM-554 items 1 and 2, TIM-558 item 48, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Tim; the check Architect (Tim has not read) | run; the check not run | TIM-546 | `rule` | `settings` |
| CLI-98 | TIM-542 item 14, TIM-550 "What held" | Tim | run |  | `rule` | `settings` |
| CLI-99 | TIM-554 item 6, TIM-548 item 6 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-100 | TIM-546 items 4, 5 and 8, TIM-554 item 9, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-101 | TIM-542 item 14, TIM-546 item 5, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Tim; kind, note and date Architect (Tim has not read) | not run | TIM-546 | `rule` | `settings` |
| CLI-102 | TIM-542 item 14, TIM-547 item 14, TIM-555 rule 1 | Tim; the kept old version and `chad status` mark Architect (Tim has not read) | run |  | `rule` | `settings` |
| CLI-103 | TIM-546 item 7, amended by TIM-559 ruling on CRED-G11 | Architect (Tim has not read) | run |  | `rule` | `settings` |
| CLI-106 | TIM-535 "The model setting", TIM-536 item 2, TIM-559 cold read | Tim | not run |  | `rule` | `models` |
| CLI-107 | TIM-535 "The model setting" | Tim | not run |  | `rule` | `models` |
| CLI-108 | TIM-535 "The model setting", TIM-544 comment "From TIM-542" | Tim | not run |  | `rule` | `models` |
| CLI-109 | TIM-535 CLI section, TIM-544 "What ran" | Tim | run |  | `rule` | `models` |
| CLI-110 | TIM-542 item 6, TIM-544 comment "From TIM-542", amended by TIM-559 ruling on MOD-G12 | Tim; what a killed CLI does to the login Architect (Tim has not read) | not run | TIM-559 | `rule` | `models` |
| CLI-111 | TIM-544 item 6 | Tim | run |  | `rule` | `models` |
| CLI-112 | TIM-535 Login section, TIM-542 body | Tim | not run |  | `rule` | `models` |
| CLI-113 | TIM-542 item 16 | Tim | not run |  | `rule` | `settings` |
| CLI-114 | TIM-542 item 16, TIM-547 items 1 and 14, TIM-552 "What ran" | Tim; the kept old version and exit 1 Architect (Tim has not read) | run |  | `rule` | `settings` |
| CLI-115 | TIM-542 item 16 | Tim | not run |  | `rule` | `backup` |
| CLI-116 | TIM-542 item 17, TIM-534 item 11, TIM-558 item 20, TIM-559 ruling on CLI-G9 and CLI-G19 | Tim; `connection add local` and `--token-file` on `connection token` Architect (Tim has not read) | not run | TIM-558 | `rule` | `cli` |
| CLI-117 | TIM-542 items 33 and 34 | Tim | not run |  | `rule` | `cli` |
| CLI-118 | TIM-534 item 13, TIM-542 item 17, TIM-559 cold read | Tim; the check made before the queue place Jarvis, assembling the spec (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-119 | TIM-534 item 13 | Tim | not run |  | `rule` | `cli` |
| CLI-120 | TIM-542 item 17, TIM-547 item 14 | Tim; unloading a plugin after an owner is removed Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-121 | TIM-542 item 33 | Tim | not run |  | `rule` | `settings` |
| CLI-122 | TIM-542 item 33, TIM-550 item 14, TIM-558 item 36, amended by Tim's ruling that chad has no scheduled job, chat 2026-11-15 | Tim, the hand check in place of the nightly job included | not run |  | `rule` | `settings` |
| CLI-123 | TIM-542 item 33, TIM-541 item 20 | Tim | not run |  | `rule` | `settings` |
| CLI-124 | TIM-542 items 24 and 30, TIM-541 item 20 | Tim | not run |  | `rule` | `settings` |
| CLI-125 | TIM-542 item 19 | Tim | not run |  | `rule` | `cli` |
| CLI-126 | TIM-550 item 7, TIM-548 items 7, 14, 15 and 16, TIM-547 item 14, TIM-549 items 7 and 23, TIM-541 item 17, TIM-536 item 14, TIM-559 ruling on SWAP-G9 | Architect (Tim has not read); the unusable database line Tim | not run |  | `rule` | `timers-cron` |
| CLI-127 | TIM-542 item 20, amended by TIM-553 item 6 | Tim; the lock test before the ping Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-128 | TIM-553 item 6, TIM-550 comment "Changed by TIM-553" | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-129 | TIM-550 item 1, TIM-553 "What ran" | Architect (Tim has not read) | run |  | `definition` | - |
| CLI-130 | TIM-536 item 6, TIM-542 items 18 and 21 | Tim | run |  | `rule` | `cli` |
| CLI-131 | TIM-536 item 6, TIM-559 cold read | Tim | not run |  | `rule` | `cli` |
| CLI-132 | TIM-536 item 7, TIM-541 item 29, TIM-559 ruling on CLI-G10 | Tim; the flag name `--sessions` Architect (Tim has not read) | not run |  | `rule` | `backup` |
| CLI-133 | TIM-542 item 21, TIM-550 item 9 | Tim; the lock with no daemon Architect (Tim has not read) | run |  | `rule` | `backup` |
| CLI-134 | TIM-542 follow-up point 2 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| CLI-135 | TIM-536 item 8, TIM-542 follow-up point 1, TIM-550 item 9, TIM-559 ruling on STO-G23 | Tim; the refusal on a held lock and what counts as empty Architect (Tim has not read) | not run | TIM-559 | `rule` | `backup` |
| CLI-136 | TIM-536 item 9 | Tim | not run |  | `rule` | `backup` |
| CLI-137 | TIM-542 items 15 and 23 as changed by TIM-557 item 11, TIM-540 item 18 as changed, TIM-549 item 23, TIM-557 items 26 and 43 | Tim; no `chad turns` and the `diagnose` skill Architect (Tim has not read) | not run | TIM-557 | `rule` | `cli` |
| CLI-138 | TIM-532 item 6, TIM-542 item 22, TIM-546 item 15, TIM-559 ruling on REC-G11, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Tim; `/secret` and `/safe` with no argument Architect (Tim has not read) | not run | TIM-546 | `rule` | `turns` |
| CLI-139 | TIM-542 item 22 | Tim | not run |  | `rule` | `apply` |
| CLI-141 | TIM-542 item 22, TIM-534 item 9, TIM-535 Login section, TIM-557 item 11 | Tim; no `/logs` Architect (Tim has not read) | not run |  | `rule` | `turns` |
| CLI-142 | TIM-550 item 12 | Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-143 | TIM-550 item 12, TIM-553 "What ran" | Architect (Tim has not read) | run |  | `rule` | `cli` |
| CLI-144 | TIM-550 item 12 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-145 | TIM-550 "Prototype results", TIM-553 "What ran" | Architect (Tim has not read) | run |  | `definition` | - |
| CLI-146 | TIM-557 item 11 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| CLI-147 | TIM-557 items 10 and 11 | Architect (Tim has not read) | not run | TIM-557 | `rule` | `failures` |
| CLI-148 | TIM-557 items 27 and 28 | Architect (Tim has not read) | not run |  | `rule` | `plugin-api` |
| CLI-149 | TIM-557 item 27 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| CLI-150 | TIM-557 item 39, amended by TIM-559 ruling on SWAP-G13 and REC-G18 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-151 | TIM-558 items 20 and 21 | Architect (Tim has not read) | not run | TIM-558 | `rule` | `cli` |
| CLI-152 | TIM-558 item 17 | Architect (Tim has not read) | not run |  | `rule` | `harness` |
| CLI-153 | TIM-558 item 33 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-154 | TIM-558 item 40 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-155 | TIM-559 ruling on CLI-G4 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-156 | TIM-559 ruling on CLI-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| CLI-157 | TIM-559 ruling on CLI-G6 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| CLI-158 | TIM-559 ruling on CLI-G6 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-159 | TIM-559 ruling on CLI-G7 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| CLI-160 | TIM-559 ruling on CLI-G7 and MCP-G6, amended by Tim's ruling that v1 has no OAuth for MCP servers, chat 2026-11-16 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `skills-mcp` |
| CLI-161 | TIM-559 ruling on CLI-G5, amended by Tim's ruling on the last four stopped rules, chat 2026-11-16 | Architect (Tim has not read) | read | TIM-559 | `rule` | `cli` |
| CLI-162 | TIM-559 ruling on CLI-G17 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-163 | TIM-559 ruling on CLI-G11 and SELF-G2 | Architect (Tim has not read) | not run | TIM-549, TIM-559 | `rule` | `apply` |
| CLI-164 | TIM-559 ruling on CLI-G11 and SELF-G2 | Architect (Tim has not read) | not run | TIM-549, TIM-559 | `rule` | `apply` |
| CLI-165 | TIM-559 ruling on CLI-G2 and REC-G1 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-166 | TIM-559 ruling on CLI-G2 and REC-G1 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-167 | TIM-559 ruling on CLI-G2 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-168 | TIM-559 ruling on CLI-G2 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-169 | TIM-559 ruling on CLI-G15, TIM-559 round 3 C2 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| CLI-170 | TIM-559 ruling on REC-G11 | Architect (Tim has not read) | not run |  | `rule` | `apply` |
| CLI-171 | TIM-559 ruling on REC-G19 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `apply` |
| CLI-172 | TIM-559 ruling on SET-G9 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-173 | TIM-559 ruling on CRON-G19, TIM-559 round 3 C7 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `timers-cron` |
| CLI-178 | TIM-559 ruling on CLI-G8 and MOD-G7 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| CLI-179 | TIM-559 ruling on CLI-G8 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| CLI-180 | TIM-559 ruling on MOD-G13 | Architect (Tim has not read) | not run | TIM-559 | `rule` | `models` |
| CLI-181 | TIM-559 ruling on MOD-G2 | Architect (Tim has not read) | not run |  | `rule` | `models` |
| CLI-182 | TIM-559 ruling on CLI-G3 | Architect (Tim has not read) | read |  | `rule` | `settings` |
| CLI-183 | TIM-559 ruling on CLI-G3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-184 | TIM-559 ruling on CLI-G3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-185 | TIM-559 ruling on CLI-G3 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-186 | TIM-559 ruling on CLI-G9 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-187 | TIM-559 ruling on CLI-G9 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-188 | TIM-559 ruling on CLI-G19 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-189 | TIM-559 ruling on CLI-G19 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-190 | TIM-559 ruling on STO-G8 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-191 | TIM-559 ruling on CLI-G16 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-192 | TIM-559 ruling on CLI-G16 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-193 | TIM-559 ruling on CLI-G16 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-194 | TIM-559 ruling on CLI-G16 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-195 | TIM-559 ruling on CLI-G16 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-196 | TIM-559 ruling on CLI-G20 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| CLI-197 | TIM-559 ruling on CLI-G20 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| CLI-198 | TIM-559 ruling on CLI-G20 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| CLI-199 | TIM-559 ruling on FAIL-G10 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| CLI-200 | TIM-559 ruling on FAIL-G10 | Architect (Tim has not read) | not run |  | `definition` | - |
| CLI-201 | TIM-559 ruling on CLI-G10 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| CLI-202 | TIM-559 ruling on STO-G21 | Architect (Tim has not read) | not run |  | `rule` | `backup` |
| CLI-203 | TIM-559 ruling on SES-G3 | Architect (Tim has not read) | not run |  | `definition` | - |
| CLI-204 | TIM-553 question 2, TIM-559 round 2 R5; answered for Tim by Jarvis, chat 2026-11-15 | Architect (Tim has not read); confirmed by Jarvis, delegated by Tim on 2026-11-15 | not run |  | `rule` | `cli` |
| CLI-205 | TIM-559 round 2 R4, TIM-559 round 4 item 3, amended by Tim's ruling that v1 has no secret request, no Enter modal, no TOTP codes and no browser recipes, chat 2026-11-16 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-206 | TIM-559 round 3 L4 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-207 | TIM-559 round 3 L4 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-208 | TIM-559 round 3 A4 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-209 | TIM-559 round 3 A4 | Architect (Tim has not read) | not run |  | `rule` | `cli` |
| CLI-210 | TIM-559 round 3 A4 | Architect (Tim has not read) | not run |  | `rule` | `settings` |
| CLI-211 | TIM-559 round 3 C5 | Architect (Tim has not read) | not run |  | `rule` | `failures` |
| CLI-212 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-213 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-214 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-215 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-216 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-217 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-218 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-219 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-220 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-221 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-222 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-223 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-224 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-225 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-226 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-227 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-228 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-229 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-230 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-231 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-232 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-233 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-234 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-235 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-236 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-237 | Build, stage 1 | Builder (Tim has not read) | run |  | `rule` | `cli` |
| CLI-238 | Build, stage 2 | Builder (Tim has not read) | run |  | `rule` | `turns` |
| CLI-239 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| CLI-240 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| CLI-241 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| CLI-242 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| CLI-243 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| CLI-244 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| CLI-245 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| CLI-246 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| CLI-247 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| CLI-248 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `settings` |
| CLI-249 | Build, stage 4 | Builder (Tim has not read) | run |  | `rule` | `skills-mcp` |

Retired ids. These rules were withdrawn and removed from this part with their Provenance rows, and the git history of this file holds their text. An id on this list is never used again, and a new rule takes a number above every id in the table and on this list.

CLI-18, CLI-38, CLI-39, CLI-93, CLI-94, CLI-104, CLI-105, CLI-140, CLI-174, CLI-175, CLI-176, CLI-177.
