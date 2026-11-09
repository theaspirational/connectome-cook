# Main CLI equivalence snapshots

Captured offline from `916cad09afb392a0981f208aaac5d123543af33f` in
`.cache/c-up916` using the real `bin/cook install` CLI and
`src/test-support/host-env-equivalence.ts` (Git and build executables are doubles;
no remote or package-manager access). All tokens are synthetic.

The fixtures contain the exact `.env` bytes and permission mode, lowered recipe
bytes, and lock bytes. Only scratch-root paths become `<ROOT>` and
the `createdAt` line is omitted from the lock. Requirement values are intentionally preserved,
including a requirement whose name is also an `authSecret`, matching main.

To regenerate, archive that commit to `.cache/c-up916`, symlink its
`node_modules` to this checkout's installed dependencies, then run:

```sh
bun -e 'import { cases, materialize } from "./src/test-support/host-env-equivalence.ts";
for (const name of cases) await Bun.write(`test/fixtures/host-env-main/${name}.json`,
  JSON.stringify(materialize(`${process.cwd()}/.cache/c-up916/bin/cook`, name), null, 2) + "\n");'
```

Run the capture and tests inside the dispatch's memory-limited user scope.
