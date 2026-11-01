# Held disposable candidates (PR01b)

**One-way hold. Never attach production data, credentials or consumers.** This
mode prepares a new disposable single-agent candidate; it cannot activate,
adopt an existing installation, clear a hold, replace history, or certify a
running version. Successful static inspection is not authorization to launch.
Deleting metadata is not a supported workaround: the candidate launcher has
no reachable launch tail. Activation and qualified ingest are deferred to PR08;
managed launchers/units to PR06, exact closure/connector qualification to PR10.
Private provider writes are available through the opt-in
[file-only secret save contract](secret-files.md).
The opt-in [deployment/recovery declaration](deployment-manifest.md) extends
this envelope without adding a history writer or changing preparation.

## Commands and platform

```sh
cook install recipe.json --hold --out /new/private/candidate \
  --agent-id 01234567-89ab-cdef-0123-456789abcdef \
  --lineage-id abcdef01-2345-6789-abcd-ef0123456789 \
  --no-prompts --yes --seed-required --env-file /private/input.env --json
cook hold /new/private/candidate --json
cook seed check /new/private/candidate --json
cook seed complete /new/private/candidate --json
cook verify /new/private/candidate --schema connectome.findings/v1
cook hold /new/private/candidate --clear --json # always exit 4, unchanged
```

Choose identities explicitly; examples above are not production identities.
Agent ID is the stable logical identity, lineage the intended history lineage.
Neither is derived from recipe names, directories, timestamps, digests or the
cook package version, nor proves the runtime store's identity. A new synthetic
history needs its own lineage UUID. No implicit generation or adoption occurs.

`install --hold` emits command **`prepare`**, not `install`. It requires explicit
`--out`, `--agent-id`, `--lineage-id`, `--no-prompts`, and `--yes`. Optional flags:
`--seed-required` (default false), `--env-file`, `--ch-repo`, `--ch-ref`,
`--pin-refs`, `--strict` (already enforced), `--allow-incomplete-templates`.
Unknown options fail, and all new operations terminate with stdin at EOF.
`--allow-incomplete-templates` cannot downgrade verification errors.
`--schema ID` implies JSON; unsupported IDs produce exit 2 / `E_SCHEMA` in the
current findings format before command effects. `--json` defaults to v1.

Candidate mutations require **Linux and util-linux at `/usr/bin/flock`**.
The explicit local filesystem admission list is ext2/3/4, XFS, Btrfs, and tmpfs.
Network, FUSE, unknown/overlay-backed filesystems, macOS and Windows refuse with
`E_IO`, before even scratch creation. Local semantics are required; tmpfs is
volatile across reboot and is suitable only for disposable fixtures. Missing
helper or unsupported runtime locking also refuses preparation before creating
R, hold, clones or builds. No lock fallback or helper-path override exists.
Legacy commands retain their existing platform support and interactive behavior.

R must be absent or an empty, real, UID-owned 0700 directory. Its existing
parent must exist. Data is exactly `R/data`; external/overridden `DATA_DIR`,
symlink roots/data and fleet declarations are refused. No recursive chmod/chown
of existing trees occurs. The private directories R, `.cook` and `data` are
0700; records, operation lock and new candidate lock v1 are 0600, launcher 0700.

Secrets come from explicit private files, never new prompts, argv values or
ambient secret variables. `--env-file` is UID-owned 0600 with no links; simple
`NAME=value` or cook's single-quoted `export NAME='value'` subset is accepted.
Shell expansion, commands and unsupported syntax are `E_ENV_FORMAT`, never
executed. File-only resolution includes provider prerequisites and sidecar
secrets. Missing credentials during verification are warnings; unsafe file
metadata is an error. No provider retrieval or credential test is performed.
Git acquisition in the new mode disables interactive prompts and ambient
Git/SSH authentication hooks/config injection; legacy acquisition is unchanged.
Build commands remain trusted, **not sandboxed**. Static tool environment retains
PR01a's allowlist and explicitly declared host requirement answers.

Snapshot input must be nonsecret declarations/references. Known inline credential
fields are rejected, but arbitrary recipe text cannot reliably be secret-scanned.
Private storage is not a public-export gate. Never publish private files or their
seed/result digests. JSON and human findings omit values, private provenance
hashes, raw subprocess errors and paths outside R.

Legacy `install` without `--out` must read the parent recipe to obtain the
name used by `~/.connectome/installs/<slug>`. It reads that parent once, without
secret resolution or prompts, then checks the destination before walking any
children, reading credentials, prompting, pinning or building. Remote parent
recipes use the same unauthenticated fetch as the legacy loader (no credential
prompt); the loaded parent is reused, not fetched again. Explicit `--out` roots
are checked before any recipe read. `install` and `build` help requests print
usage without inspecting the output root, even when it is held.

## Persisted contracts

The original seven v1 contracts are validated by `src/candidate/schema.ts`. All fields
listed below are required, objects are closed (unknown fields reject), schema
IDs are exact, and duplicate JSON keys/nonfinite numbers reject. Recipe objects
use the existing recipe validator, including their extension payload format.
All maps have unique keys. Schema migration must be explicit; never silently
reinterpret durable v1 records.
The deployment envelope also accepts the explicit optional `manifest` binding;
see [its complete shape and observation deferral](deployment-manifest.md).

Common types:

- `UUID`: lowercase canonical `8-4-4-4-12` hexadecimal UUID.
- `Digest`: `sha256:` followed by 64 lowercase hexadecimal digits.
- `Text`: nonempty string. `Time`: valid UTC `YYYY-MM-DDTHH:mm:ss.sssZ`.
- `Agent`: closed `{id: UUID, lineage: UUID}`.
- `Outcome`: `complete | partial | uncertain`.

| Schema ID | Complete required field set (in addition to exact `schema`) |
|---|---|
| `connectome.deployment/v1` | `agent: Agent`; `desired: {declaration: ".cook/declaration.json", configDigest: Digest}`; `materialized: {lock: "connectome.lock", lockVersion: 1, lockDigest: Digest}`; `installed: null`; `running: null`; `lifecycle: "held-candidate"` |
| `connectome.declaration/v1` | `agent: Agent`; `entry: Text` naming a recipe key; `recipes`: nonempty basename-to-recipe map (no separators, dot/dot-dot); `host: {url: Text, ref: Text}` with credential-free URL; `seedRequired: boolean`; `dataDir: "data"` |
| `connectome.hold/v1` | `agent: Agent`; `state: "held"`; `scope: "disposable-candidate"`; `reason: "candidate-preparation" | "seed-pending" | "ingest-incomplete"`; `createdAt: Time` |
| `connectome.ingest-intent/v1` | `operationId: UUID`; `agent: Agent`; `configDigest`, `lockDigest`, `seedDigest`, `toolDigest`: Digest each; `namespace`, `adapterId`: Text each; `dataDir: "data"`; `startedAt: Time` |
| `connectome.ingest-result/v1` | All intent fields except its schema; additionally `storeIdentity`, `qualificationId`: Text each; `finishedAt: Time` not before startedAt; `outcome: Outcome` |
| `connectome.seed-consumed/v1` | `agent: Agent`; `operationId: UUID`; `configDigest`, `lockDigest`, `seedDigest`, `toolDigest`, `ingestResultDigest`: Digest each; `namespace`, `storeIdentity`, `adapterId`, `qualificationId`: Text each; `consumedAt: Time`; `outcome: Outcome` |

Locations: envelope `connectome.deployment.json`, declaration
`.cook/declaration.json`, hold `.cook/hold.json`, intent/result
`.cook/ingest.intent.json` / `.cook/ingest.result.json`, marker
`data/seed.consumed`. The stable `.cook/operation.lock` is not JSON.
**Persisted records never contain `supported`.** The lock remains v1 and uses
its unchanged serialization, including trailing newline; the legacy writer is
unchanged. Old v1 readers can read a new candidate's lock.

`configDigest` hashes canonical frozen snapshot JSON: recursively sort object
keys in UTF-16 code-unit order, preserve arrays, JSON without whitespace or
newline, UTF-8, SHA-256. Save declarations before lowering, rewrite recipe
references to shipped filenames and retain source metadata. Do not serialize
resolved values, env-file/credential bags, `.env` or rendered templates there.
`lockDigest` hashes exact written lock bytes including newline. Neither is an
executable-closure digest. Timestamp changes can alter the lock digest without
changing configuration; changed configuration changes configDigest without
changing agent identity. Declare nonsecret behavioral settings in recipes:
untracked env-file settings are not versioned effective configuration.

`installed: null` and `running: null` mean **not recorded**, never “stopped” or
“currently running this version.” They remain null even after successful
preparation. No PID or successful install creates runtime attestation.

### Seed admission and bounded completion

Fresh means **no data directory entry at all**: files, zero-byte stores, WALs,
journals, dotfiles, empty directories, temporary entries, sockets and unknown
names all refuse. Any marker form (including dangling symlink, malformed JSON
or directory) means consumed. An intent alone also blocks fresh retry, even
when data still looks empty. No database filename or cache allowlist is guessed.
Read-only `seed check` is not authorization; admission repeats under the lock.

There is **no production ingest adapter, import command, executable selector,
operator-success flag or test-adapter switch**. Production completion of a
saved result fails with `E_INGEST_UNQUALIFIED` until PR08 supplies reviewed
admission. Arbitrary JSON or a shell exit 0 cannot attest success. The synthetic
admission API exists solely for isolated tests. Even empty initialization needs
qualified evidence; seedRequired=false cannot adopt existing history.

`adapterId`, `qualificationId`, `toolDigest` and `storeIdentity` are required but
**producer semantics are provisional**. The result and marker formats are
forward-declared for fixtures, not approved production receipt formats. Ratify
with the first real producer or introduce an explicit new schema version.

Admission binds every shared intent/result field, unchanged envelope/declaration/
lock and actual durable store identity. Adapters must guarantee no detached writer
survives a failed ingest. Revalidation must inspect durable history and actual
store identity, **not merely saved JSON**; unknown writer/durability state refuses.
Marker fields are deterministically copied from the admitted result, except its
schema and digest of canonical result bytes; consumedAt is exactly finishedAt.
Partial/uncertain remains partial/uncertain, is a verification error and cannot
be replaced with complete. A crash without a qualified result leaves intent and
hold, not an invented marker.

`seed complete` holds the nonblocking operation lock throughout, reads only fixed
intent/result paths, revalidates at most **30 seconds**, rechecks durable bindings,
then makes one publication attempt. It never ingests or reruns fresh emptiness
(history is expected now). This is PR01b's fixture bound; PR08 must ratify an
appropriate production bound with the first adapter. Timeout/uncertain writer
state is `E_INGEST_INCOMPLETE`; an expired callback cannot publish later. Identical
marker bytes are idempotent success, differing bytes `E_SEED_CONFLICT`. No intent,
result, history or hold bytes are rewritten. No retry/force/cleanup recovery path.

### Locking, crash ordering and publication

Open and retain a validated stable lock descriptor, then run without a shell:
`/usr/bin/flock --exclusive --nonblock --conflict-exit-code 75 3`, mapping only
that descriptor to child fd 3. Helper exit does not release the parent's shared
open-file-description lock. Exit 75 is `E_BUSY`, other failure `E_IO`.

Before candidate creation, a disposable scratch-file preflight must observe
**0/75/0** on independent descriptors A/B: acquire A, contend B, close A, acquire
B. A helper that merely exits zero, or a runtime substituting a pipe for fd 3,
is refused. Node and Bun are tested. Only the flock helper receives the descriptor;
ordinary children must not inherit it (runtime CLOEXEC/explicit descriptor mapping
behavior is tested). Never unlink/replace the lock, steal by PID or force-unlock.
An unexplained persistent E_BUSY requires investigating the writer or recreating
the disposable candidate, not weakening serialization.

Order: durable hold → clone/build/declaration/configuration → durable lock v1 →
envelope (last preparation publication) → intent → durable external ingest →
admitted result → marker. Before envelope publication no successful preparation
is claimed. Atomic `.cook` creation reserves a fresh preparation root; it is not
a fallback for unsupported flock, and crashed reservations are never reclaimed.

Write-once records use exclusive/no-follow randomized sibling temps, mode 0600;
write full bytes; fsync file; no-replace hard link to final; fsync parent; unlink
known temp; fsync parent again. Never plain rename/truncate/exists-then-write,
copy across devices, or overwrite on retry. Visible publication before failed
fsync is still E_IO. Unknown surviving hardlinks refuse; only the current
operation's recorded temp inode can be cleaned. A lingering intent blocks retry
even if a marker is lost. Same-UID/privileged edits can defeat filesystem policy;
this is local serialization, not fencing or an adversarial sandbox.

## Findings, verification and exits

The seventh schema is **`connectome.findings/v1`**, emitted responses only:

| Required field | Constraint |
|---|---|
| `schema` | `connectome.findings/v1` |
| `supported` | Nonempty distinct schema-ID strings, including this response's schema ID; v1 plus future versions is valid, not a singleton constraint |
| `command` | `prepare | hold | hold-clear | seed-check | seed-complete | verify` |
| `status` | `ok | warning | error`, worst finding severity (info-only means ok) |
| `held` | Boolean, or null when unknown |
| `activationAllowed` | Always false |
| `findings` | Array of closed Finding objects, sorted by check, subject, code |

Each Finding has exactly `code: Text`, `severity: info | warning | error`,
`check: envelope | declaration | materialization | configuration | requirements |
credentials | seed | handshakes | deferred | cli | hold`, `subject: Text` (logical
ID or R-relative path), `message: Text`, `remedy: Text`. Messages/remedies are
safe text, never raw subprocess stderr or private values. JSON is one object
on stdout without progress/ANSI noise; human output renders the same findings.

Verification is offline and read-only: strict schemas/modes/bindings, snapshot
inspection, materialization paths and local Git commits, re-lowered configuration
comparison, in-memory template checks, saved requirement paths, private credential
metadata and non-executing `.env` parsing, seed evidence and every declared MCP/
sidecar handshake. Independent checks aggregate; unavailable dependent inputs are
explicit errors. Missing credentials warn; missing/unqualified proof errors.
Runtime placeholders are unresolved errors, never filled by starting a sidecar.
Deferred unit binding, full closure, effective gates and running observation are
explicit incomplete findings, not inferred from ports/PID/service-active. PR01b
cannot produce an activation/readiness receipt, even when static checks pass.

Read-only Git uses processAllowlistEnv(), **not gitEnvironment()**, overrides
`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/false`, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`, and runs bounded
`git -c core.fsmonitor= rev-parse HEAD` with closed stdin. No fetch, inherited
SSH_ASKPASS or indexed Git config. `.env` is never sourced by verification.

| Exit | Meaning |
|---|---|
| 0 | Operation succeeded/no verifier errors (warnings possible); never activation |
| 1 | Usage: `E_USAGE` |
| 2 | Validation/capability/verification failure |
| 3 | Filesystem/subprocess failure: `E_IO`; preserve hold/evidence |
| 4 | Policy: `E_HELD`, `E_CLEAR_UNSUPPORTED`, `E_SEED_EXISTS`, `E_HISTORY_EXISTS`, `E_INGEST_PENDING`, `E_INGEST_UNQUALIFIED`, `E_BUSY` |

Exit-2 codes: `E_JSON_UNSUPPORTED`, `E_SCHEMA`, `E_IDENTITY`, `E_DIGEST`, `E_PATH`,
`E_MODE`, `E_SCOPE`, `E_ENV_FORMAT`, `E_CONFIG_DRIFT`, `E_PIN_INCOMPLETE`,
`E_REQUIREMENT_MISSING`, `E_INGEST_MISSING`, `E_INGEST_INCOMPLETE`,
`E_SEED_CONFLICT`, `E_HANDSHAKE_MISSING`, `E_PROOF_INCOMPLETE`.
Warnings: `W_CREDENTIAL_MISSING`, `W_LEGACY_UNMANAGED`.
Info: `I_CHECK_OK`, `I_HELD`, `I_MATERIALIZED`, `I_SEED_ELIGIBLE`,
`I_SEED_COMPLETED`, `I_NOT_APPLICABLE`.

Verifier error findings aggregate to exit 2 (including policy-equivalent findings);
exit 3 takes precedence if no reliable report can be produced. Mutation status
tracks severity, while exit tracks failure class: branch on code, not status
alone. Existing legacy exits/child exit propagation are unchanged except below.

## Compatibility table

| Situation | Behavior |
|---|---|
| Existing v1 install with no candidate controls | Legacy run/reconcile remain; new inspection warns W_LEGACY_UNMANAGED. Verify reports missing metadata/proof; no implicit adoption. |
| macOS/Windows/network or other unadmitted filesystem | Candidate mutations refuse E_IO before writes; legacy commands unaffected. |
| Existing `cook check --json` caller | **Breaking:** exit 2 / E_JSON_UNSUPPORTED, stderr diagnostic, empty stdout, no findings document, before recipe reads/fetches. Previously warned and printed human output, possibly exiting 0. `check --help --json` still prints usage and exits 0. Use `cook check` without --json for recipe validation; verify is installed inspection, not JSON recipe check. |
| Old lock reader/new candidate | Lock v1 still parses. Candidate run.sh refuses even when an older CLI launches it. Direct raw host commands are outside this guarantee. |
| Old launcher/no new metadata | No retroactive production hold guarantee. `hold` refuses legacy targets with E_SCOPE. |
| History/marker but no metadata | Fresh checker refuses independently of envelope validity; verify also reports missing metadata. Never synthesizes success. |
| Torn/unknown metadata or missing hold | No legacy fallback when any control artifact exists. Embedded candidate launcher still refuses. |
| Preparation crash | Hold/reservation remain; no success before envelope. No automatic reconcile into partial candidates. |
| Result durable, marker absent | No re-ingest. Bounded completion revalidates saved evidence under the kernel-released lock; missing qualification refuses and stays held. |
| Ingest failure/invalid proof | Intent blocks fresh retry; no fabricated marker. Qualified partial/uncertain is retained as an error. |
| Concurrent writers/durability failures | E_BUSY/E_IO, no weaker fallback or overwrite. Identical qualified publication can be confirmed; final collisions cannot replace bytes. |
| Candidate moved/copied | Embedded guard follows script root and refuses. Verify detects stale absolute lock/config paths; no automatic rebinding. |
| Changed declaration/config/lock after result | Drift/binding errors; historical marker never rewritten. |
| Service restart/reboot | Guarded script/CLI refuses again before sidecars. Independent sidecar units, ExecStartPre effects and raw host executables are outside the guarantee. |

No units are generated or managed; already running processes are not stopped.
Do not configure independent sidecar autostarts for disposable candidates. The
optional `test/candidate-service.sh` fixture exercises repeated user-service
launch refusal and demonstrates an independent sidecar's unsupported boundary.
Full managed reboot/unit qualification belongs to PR06. No prepare dry-run is
claimed; seed check and verify provide read-only inspection.

## Maintainer decisions requested

1. Accept empty-root/local-data/single-agent opt-in scope, deferring production
   adoption, external DATA_DIR and fleets? Recommended yes; preserve legacy mode.
2. Accept filenames/schema discriminators and null installed/running? Recommended
   yes: one evolving envelope family around unchanged lock v1, explicit migration.
3. Accept operator-supplied UUID identity/lineage instead of recipe inference?
   Recommended yes; the qualified producer must bind actual store identity.
4. Retain the conservative any-entry history predicate? Recommended yes; only a
   later qualified store adapter may narrow it. Missing marker is not emptiness.
5. Who admits qualified adapters/results? Recommend fixed maintainer-reviewed
   adapters, no arbitrary result import, no production success before qualification.
   Accept provisional adapterId/qualificationId/toolDigest/storeIdentity semantics
   for fixture-only result/marker schemas? Ratify with first PR08 producer or bump
   schema before production use. Also explicitly accept the bounded `seed complete`
   command (fixed saved paths, no ingest, no clear), and ratify its production bound.
6. Accept unconditional one-way candidate launchers? Recommended yes; deliberate
   later PR08 activation, never instructions to edit/delete hold files. Independent
   sidecar services remain unsupported.
7. Keep existing interactive legacy commands compatible while all new operations
   are non-interactive/file-only? Recommended yes; move legacy prompts to a separate
   front end in separately scoped work, not by claiming they are already absent.
8. Accept unavailable real proof as errors and missing credentials as warnings
   under hold? Recommended yes; static success must never imply clear/activation.
9. Accept Linux/util-linux `/usr/bin/flock`/admitted-local-filesystem candidate
   mutations, deferring other platforms/filesystems? Recommended yes; explicit
   dependency and fail-closed runtime qualification, without restricting legacy mode.
