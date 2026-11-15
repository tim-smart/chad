# chad loader prototype (TIM-538)

Throwaway. It answers "Runtime and plugin loading mechanism" and nothing here is meant to be kept.

`app/` stands in for the image and `data/` for the volume. `app/host.ts` is a small daemon that
snapshots `data/repo/work/`, type-checks the snapshot, loads every plugin from it, swaps the running
instances, commits and moves `data/repo/live`. `app/packages/chad` is a stub of the plugin API.

    cd app && npm install            # Node 24
    LOADER=bundle node demo.ts       # the walkthrough, twelve cases, state printed after each
    LOADER=esm node demo.ts
    LOADER=bundle node --expose-gc soak.ts 300 30   # 300 applies, the first 30 type-checked
    LOADER=bundle node boot.ts       # a fresh process that loads what live/ points at
    LOADER=bundle bun demo.ts        # the same host on Bun

`LOADER=rolldown` is the bundle loader with rolldown doing the bundling.
`app/import-meta.ts` prints what each bundler does with `import.meta` in CJS output.
`racy-snapshot.sh <empty dir>` shows why the snapshot keeps the mtime of the git index it copies.

`LOADER=bundle` builds each plugin to one CJS file with esbuild and runs it with
`vm.compileFunction`. `LOADER=esm` imports the `.ts` file from the snapshot directory.

The `*.log` files are the runs the ticket comment quotes (Node 24.22.2 and Bun 1.3.13, Linux x64).
The `*-node26.log` files are the same runs on Node 26.8.2, made after the index mtime fix.
