# Deploy repositories: slice 1

`cook deploy` adapts the connectome-agents layout to the **existing legacy host
installer**, not to a second installation engine. It does not switch, activate,
install units, execute hooks, seed history, retrieve Vault secrets, or migrate
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

## Later switch / retention / rollback (design only)

A future separately approved switch should verify the exact candidate and unit/
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
needed. Unit installation, Vault, activation, switch and rollback execution remain
out of scope for this slice.

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
