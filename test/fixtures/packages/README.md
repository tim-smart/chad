The packages the registry stand-in serves (`test/support/registry.ts`), one directory per version. None of them
is published. `effect` here is a fake whose module throws, so a plugin that ran it in place of the host's would fail.
