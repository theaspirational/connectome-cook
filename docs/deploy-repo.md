# Deploy repositories

`cook deploy` adapts the connectome-agents layout to the **existing legacy host
installer**, not to a second build engine. Plan/stage/check do not switch or
activate. Separate slice-2 activation commands below install repo-driven units.
Neither path executes hooks, seeds history, retrieves Vault secrets, or migrates
state. A staged candidate is **not held** and is **not activated**. Its launcher
can run if someone explicitly invokes it; staging is not a startup interlock.

## Commands

```sh
cook deploy plan --repo /path/to/deploy-repo --agent example-agent
cook deploy stage --repo /path/to/deploy-repo --agent example-agent --root /scratch/example-agent
cook deploy check --repo /path/to/deploy-repo --agent example-agent --root /scratch/example-agent
```

Plan reads declarations only: no fetching, executing engines, directory creation,
credential-file reads or unit operations. It prints canonical JSON with effective
pins and `base`/`override` provenance, the canonical validated recipe digest,
declared unit/credential routes, existing installer options, and missing inputs.
Missing build inputs do not prevent planning. Stage/check refuse with
`E_DEPLOY_MISSING` and the missing field names before creating the root.
Other failures have fixed value-free diagnostics and nonzero status; child build
stdout/stderr are captured and discarded, not printed or persisted. Build failures
report `E_DEPLOY_BUILD`, without echoing potentially private subprocess output.

## Source layout and closed adapter schema

- `versions.yml`: a nonempty object with the fleet keys `runtime`, `slack`,
  `telegram`, `github_mcpl`, `terminal_sessions` (only needed keys required).
  Values are bounded alphanumeric/dot/underscore/hyphen labels. Record reasons in
  full-line comments, as in connectome-agents at `8f36c77c`.
- `agents/<slug>/agent.yml`: the reference placement/unit/credential declaration:
  `host`, `user`, `hold`, `layout`, `paths`, `release`, `units`, `credentials`,
  `seed_settings: null`, optional `versions`. The latter can override **only keys
  already declared by the fleet**. No seeds are imported. Slugs are lower-case
  alphanumeric plus hyphen/underscore. `hold: true` refuses staging: this legacy
  path cannot honestly deliver an enforced hold.
- `agents/<slug>/recipe.json`: nonsecret recipe validated by the existing recipe
  validator plus the adapter's closed supported fields. The adapter includes the
  supplied reference-agent runtime fields; it does not change legacy recipe validation.
- Optional `agents/<slug>/host.yml`: explicit build inputs below.

YAML here means the reference repo's JSON-flow subset with optional full-line
`#` comments. Not general YAML: block mappings, tags, anchors and inline comments
refuse. Duplicate keys (including escaped aliases), unknown keys, unsafe input
symlinks, malformed declarations and secret-like values refuse before output.
All input files are bounded to 2 MiB. Errors never echo offending keys or values.
The secret guard is heuristic: prefixed tokens, private keys, sensitive literal
assignments and unstructured long token-like strings are rejected. Provenance
review is still required, particularly for values that resemble legitimate pins
or paths. Never put real credentials into these files to test the guard.

Paths, credential names and `${ENV_NAME}` references are declarations, not secret
values. Only the existing G3 `credentialBindings.consumers` map treats its values
as names from `files`, rather than environment values. No credential bytes are
read. Unit configuration is desired intent, not observed live unit state; full
systemd rendering/installation is outside this slice. Internal manifest ordering
is not inferred from arbitrary systemd dependency strings.

### Build input mapping

Example host.yml (replace synthetic identities/pins/paths with reviewed inputs):

```json
{
  "chRepo": "/path/to/reviewed/host-source",
  "chRef": "{runtime}",
  "bunPath": "/opt/engines/bun",
  "nodePath": "/opt/engines/node",
  "hostDependencies": [
    "@animalabs/agent-framework=/path/to/reviewed/framework.tgz#sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ],
  "userUnit": "example.service",
  "agentId": "01234567-89ab-cdef-0123-456789abcdef",
  "lineage": "abcdef01-2345-6789-abcd-ef0123456789"
}
```

`chRepo`, full 40-lowercase-hex `chRef`, both absolute engine paths,
`hostDependencies`, `agentId` and `lineage` are required for stage/check. Identity
UUIDs correspond to the existing held-declaration identity inputs; never infer
or replace an existing agent's identity from its account or slug. An explicitly
empty dependency array means no G5 overrides were requested; absence means the
build policy is missing. A runtime directory label is **not** a source commit.

Options map to existing `--ch-repo`, `--ch-ref`, `--bun-path`, `--node-path`,
repeatable `--host-dependency`, and optional `--user-unit`. Optional `layout` and
`credentialBindings` contain the exact existing G2/G3 objects, passed through
those existing validators/options. Unknown options refuse. G5 still performs
its archive/hash/name/range/trust checks; it does not freeze every dependency.

Explicit `{runtime}`, `{slack}`, `{telegram}`, `{github_mcpl}` and
`{terminal_sessions}` placeholders in recipe/host string values use effective
fleet-plus-agent pins. Concrete historical paths are **not** substring-rewritten.
An override with no recipe/host placeholder binding is listed as missing and
cannot stage: merely changing a label must not pretend to change executable
code. Unit intent retains the reference repo's placeholders and is not executed.

`{build}` in layout/credential paths is expanded to the stable private candidate
root. Default legacy installation is under `{build}/runtime`; all G2 roots must
be distinct, non-overlapping siblings under `{build}`. Stage never provisions
live external state through G2. G3 alone may reference existing external private
credential directories; no file values are read. Mutable state/workspace/credential
roots are excluded from closure hashes. Their recorded owner is the staging uid/gid,
not an attestation about live accounts or external credential ownership.

This bounded adapter refuses opaque module configurations, child recipe fleets,
local extensions, requirements discovery, sidecars and template/credential-file
materialization. Stdio consumers need explicit source acquisition metadata;
implicit sibling copying is not a reproducible deploy input. The underlying
legacy commands remain available with their unchanged contracts. Arbitrary
reviewed source builds are **not sandboxed**: trust their code before staging.
No ambient credentials/authentication hooks are forwarded to the installer.

## Publication and checks

The ID is the SHA-256 of the canonical resolved plan. Staging reserves
`<root>/.builds/<id>` exclusively, installs once under its `runtime/` (or G2
runtime), writes a PR03 manifest and closure census, verifies them, flushes the
build, then atomically renames a temporary symlink to `<root>/runtimes/<id>`.
The symlink target must be exactly `<root>/.builds/<id>`. `current` is never read
or changed. Both parent directories and candidate roots are private 0700;
foreign links, wrong owners/modes and existing foreign runtime entries refuse.

Stable `.builds` paths are necessary because legacy launchers, lowered recipes,
locks and G5 dependency references bake absolute paths. **Never delete or move
`.builds/<id>` while a runtime link or a future current link references it.**
Relocation is unsupported. Published code/config is immutable by convention:
Cook never reconciles/rebuilds it in place. Same-uid users can still alter files;
check detects drift, but is not an adversarial signature or sandbox.

A repeat stage verifies the existing candidate and makes no changes. A failed
build removes only its newly reserved build and never publishes. A crash can
leave an unpublished build or temporary link; `E_DEPLOY_INTERRUPTED` refuses
reuse. Inspect/retain that evidence and explicitly remove the abandoned build
only after proving no builder is active; Cook never resumes it or publishes it
unchecked. There is no automatic garbage collection.

Check verifies exact plan/recipe binding, engine identities and bytes, the PR03
manifest/revision/lock, expected manifest bindings, full host commit, G5 records,
artifact digests, and the closure census (paths, modes, bytes and safe internal
links). It refuses metadata symlinks before reading them. It neither follows
links into external mutable roles nor hashes private role contents. It does not
prove connector readiness, registry provenance, live state compatibility,
provider authorization or that source builds are safe.

## PR03 lifecycle compatibility

The unchanged `connectome.deployment/v1` envelope now has an additive
`staged-candidate` reader at the manifest boundary. Its `desired.declaration` is
`.cook/deploy-plan.json`, whose canonical content is bound by `configDigest`.
`installed` and `running` remain null. Existing held-only `validate`/`readRecord`,
prepare, seed and verify behavior is unchanged and refuses staged records.
`validateStaged` conversely refuses held records. Unknown lifecycles refuse.
`cook deployment export ENVELOPE --lock LOCK` can export either complete manifest;
legacy `--bindings` enrichment remains held-only. A staged record is not evidence
of an enforced hold or service installation.

## Retention and state compatibility

An activation must verify the exact candidate and unit/
credential/state compatibility under stopped writers, retain the old runtime
pointer plus matching configuration/unit revision, then atomically replace
`current`. Use an explicit journal/receipt to distinguish before/after crashes;
never infer successful activation from the link alone. Keep previous targets and
all referenced `.builds` trees until retention and independent recovery gates
allow removal. No hooks are implicitly trusted.

Rollback must select the matching code/config/unit tuple and separately decide
state compatibility. Pointer reversal does not restore history, credentials,
provider refresh state or connector queues. Do not rewind newer state implicitly;
require an independently qualified cold restore and operator loss approval when
needed. Vault and state restoration remain out of scope. Unit installation and pointer
rollback are provided by the separate activation commands below.

### Recipe value validation

The deploy adapter validates every supported recipe value before calling the
legacy validator: closed objects, typed dictionaries/arrays, booleans, strings,
and explicit union branches (including channel subscriptions and module options).
Numeric/enum domains follow connectome-host `925e4f70:src/recipe.ts`, not
field-name heuristics. For example, kv policy alpha is a finite nonnegative
weight (no upper bound); half-lives are positive fractions or integers; request
timeouts are finite nonnegative numbers, including zero. Only fields explicitly
bounded by the host impose integer/range constraints. Number-only host slots
remain type-only, with finite JSON wire values required by the existing decoder.
Budget low/high ratios obey `0 <= low <= high <= 1`; refresh intervals must be
below the selected cache TTL; enabled thinking budgets must be below maxTokens.
Explicit host enums cover built-in strategy types, folding/thinking modes,
cache TTL/prose routing, transports, source install runtimes, mount/watch events
and subscription modes. Omitted strategy type retains the host default.
Cook-only `sourceMeta` provenance has closed value types but no host install enum;
it is not acquired or executed. Models/formatters remain typed selectors, not a
claim of runtime capability. Every numeric domain and enum is enumerated with
host source lines and real-CLI boundary tests in `deploy-recipe-schema.test.ts`.
Unsupported structures or unknown nested fields fail with a sanitized diagnostic;
the permissive legacy recipe validator cannot grant deploy admission.
Private deploy metadata (the envelope, copied lock and `.cook` JSON records) is
created as exactly 0600 using the newly owned file descriptor, independent of
umask, and check requires that exact mode (including absence of special bits).
This does not change the legacy installer's own materialization-file contract.

## Slice 2: explicit activation

The stage/check contracts above remain unchanged. Activation and rollback are now
separate opt-in operations; the earlier “design only” switch discussion describes
the safety boundary, not the command availability.

Example for a neutral agent (all paths and identities below are placeholders):

```sh
cook deploy activate --repo /opt/example-deploy --agent example-agent \
  --root /srv/example-deploy --unit-dir /home/example/.config/systemd/user \
  --scope user --credential-map /srv/example-deploy/credential-map.json --dry-run
cook deploy activate --repo /opt/example-deploy --agent example-agent \
  --root /srv/example-deploy --unit-dir /home/example/.config/systemd/user
cook deploy status --root /srv/example-deploy
cook deploy rollback --root /srv/example-deploy
cook deploy rollback --root /srv/example-deploy --to RUNTIME_ID
```

Add `"stateDirectory": "/srv/example-agent/state"` to the slice-1 host.yml
build-input object. This must be an existing directory; Cook only checks its
metadata and never creates, reads, copies, migrates or removes state. Provisioning
a fresh empty state directory is an operator prerequisite. Changing state path or
agent identity across an activation refuses. No seeds, layers, private fetch,
Vault or runtime GC is performed.

Agent unit declarations supply argv `exec_start`, nonsecret `environment`,
and the closed `unit`, `service`, `install` directive maps. `{runtime}` in
argv/directive values resolves to the checked staged runtime directory; `{state}`
resolves to host.stateDirectory. WorkingDirectory must match stateDirectory.
Service restart defaults to on-failure and Type to simple. System scope defaults
User to agent.user; user scope resolves agent.user through the local account resolver and requires
its uid and primary gid to match the invoking user manager identity before any
write (including lock creation); per-unit User/Group overrides refuse. Sidecars are additional entries
in agent.units, not recipe services. Pre-start hooks and RuntimeDirectory creation
refuse. Environment references are not evaluated; secret-like literals still
refuse via the existing guard. Units run exactly the reviewed argv, not an
implicitly selected launcher. Use the staged run.sh explicitly when appropriate.

A sanitized machine-local credential map (JSON, owned by the invoking uid,
exactly 0600, outside the deploy repository):

```json
{"provider-auth": "/run/example-private/provider-auth"}
```

The corresponding slice-1 credential declaration uses name `provider-auth`,
consumer equal to the unit profile key, deliver `systemd-credential`, and no source or destination field. An optional legacy source path is descriptive only;
activation uses exclusively the local mapping. Copy/file delivery and destination
fields refuse. All declared names must be mapped, and extra names refuse.
Credential targets are never opened, statted, copied, hashed or logged by Cook.
LoadCredential paths appear only in private installed units and private journal
snapshots; dry-run and status redact them. This shape is suitable for sanitized
pilot preparation; no real pilot identities or paths are supplied here.

Unit directories must already exist, be owned and writable by the invoking uid,
not group/world writable, and have no symlink ancestors. Cook installs 0600 files
using fsynced temporary files and rename; it refuses preexisting unmanaged units
or drift. Scope defaults to user; system scope requires appropriate operator
privileges. `--systemctl COMMAND` injects the executable for tests; production
defaults to systemctl. Calls have a five-second timeout. `--timeout MILLISECONDS`
(default 30000, maximum 300000) bounds health polling between calls. Health means
every declared unit reports is-active, not connector/provider readiness.
Same-id activation is a no-op only when the recorded unit tuple and observed
enablement also match. Every unit requires an explicit WantedBy target declaration.
An explicit --runtime selects a verified staged plan for the same agent identity;
the current repo hold still applies. Rollback selects recorded unit snapshots
without requiring the old repo checkout.

### Transaction, failures and recovery

ROOT/activation.lock uses a nonblocking Linux flock; the descriptor remains open
through service operations. Dry-run does not acquire/create a lock and is an
advisory read-only view, not a reservation. ROOT/activation.jsonl is an fsynced
append-only 0600 journal containing before/after runtime, exact unit snapshots and per-unit enablement snapshots.
It is private operational data, not a file to commit. A pending entry is durable
before stopping/disabling old units, installing/enabling new units, or renaming ROOT/current to the
relative runtimes/ID link. A successful health check appends active. Failure stops/disables
the attempted units, restores the old units, enablement and pointer, restarts/checks the old
units, then appends restored. Fresh activation failure removes its units/current.

A crash may leave a pending entry and a mixed set of units, even before current
changes. Further activation refuses. Run `cook deploy rollback --root ROOT`
(with the same injected systemctl in tests) to restore the pending entry's before
snapshot. Recovery is idempotently retryable; failed restoration leaves pending,
never a success receipt. A truncated journal refuses and requires operator
inspection; do not truncate it automatically. No stale-lock deletion is needed:
process exit releases flock. Preserve all referenced runtime/build trees.
Rollback reverses code/unit selection only; it never rewinds mutable state.

### FIX1: identity, effective history and boot persistence

For user scope, account resolution uses /usr/bin/id with bounded, captured output.
Both uid and primary gid must match the invoking process; unknown accounts and
per-unit User/Group changes refuse before lock creation. Cook does not impersonate
another user manager. System scope retains explicit repo User/Group declarations.

Each activation enables all declared units through the injected systemctl in the
selected scope. WantedBy must contain explicit target names (for example
`{"WantedBy": "default.target"}` for a user unit). Enable uses the installed
absolute unit path, so a configured nonstandard unit directory is supported.
Before mutation Cook observes is-enabled for the managed predecessor and journals
the result. Old enablement links are disabled before replacing files; rollback
and recovery disable attempted units and reinstate the recorded enabled/disabled
state of the predecessor. A previously disabled unit remains disabled on rollback,
although it is restarted for health verification. New units already enabled
outside this journal refuse adoption. Unsupported observations (masked, static,
linked, runtime-only enablement, errors) refuse rather than guessing a restore
policy. A successful enable must also be observed as enabled.

Every successful user-scope activate/rollback/recovery and dry-run reports
W_DEPLOY_LINGER_UNVERIFIED. Enabling user units alone does not guarantee the user
manager starts at boot or survives logout. Operators must verify linger and their
host boot policy independently. Cook never runs loginctl or enable-linger, nor
changes machine policy. The conservative warning remains even on hosts where
linger was already configured. System scope does not emit this user-manager
warning. No real reboot or user-manager policy test is implied.

Status/default rollback derive their predecessor from effective committed
transitions. A failed/restored or pending activation does not replace the previous
successful runtime: A → B → attempted C → restored B retains previous A.
Recovery after an interrupted third activation has the same history semantics.
Same-runtime enablement repair does not consume the prior runtime predecessor.

Journal snapshots now require an enabled map. Older experimental slice-2 journals
without enablement evidence refuse rather than invent prior boot state. Retain
such evidence for operator inspection; there is no automatic journal migration.

Rollback/recovery admission reads account metadata only for the selected source
and restore target, not every historical attempt. Their private declarations must
still bind to their runtime IDs so account identity can be established. Full
runtime integrity is required for the restore target before even lock creation
and checked again under the lock. Corrupt executable payloads in discarded
candidates or the runtime being replaced do not prevent restoration of an intact
target. Missing/corrupt identity declarations for selected participants still
refuse; Cook does not guess which account it would affect.
