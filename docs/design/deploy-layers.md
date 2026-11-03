# Deploy layers and frozen runtime sets

Status: **design proposal, not implemented**. TASK-0RSJC; baseline
`6d7188787d1a78b18e0e99b3c9fd6a8c3f197ca3` (PR09 slice 1).
All new formats, command spellings and policies below are recommendations.
Layer names, including `cook-runtime-stable`, `cook-connectors-telegram-vasyl`
and `agent-alnold`, are opaque user labels. Cook must infer neither role,
precedence, trust nor update policy from a name.

## 1. Existing boundary and intended extension

The agent repository is the composition root. It explicitly lists a flat,
ordered set of pinned layers; the root contributes its own agent-specific
configuration. Composition produces one validated recipe and one host plan,
then uses the existing installer and staged-candidate publication path. This is
not a pack manager, second installer, service orchestrator or migration executor.

Baseline facts (citations relative to the baseline tree):

- `src/deploy-repo.ts:49-58,145-163` reads bounded JSON-flow YAML, five known
  fleet pin keys, an agent declaration, recipe and optional host inputs. Agent
  versions override existing fleet keys; effective provenance is only
  `base`/`override`. There is no multi-repository resolver.
- `src/deploy-repo.ts:137-159` expands explicit pin placeholders, not historical
  substrings; missing build fields and unbound overrides prevent stage.
  `src/deploy-recipe-schema.ts:21-91` defines closed typed recipe structures;
  `:92-105` also checks cross-field numerical constraints. Fragments must not
  bypass these constraints after merging.
- `src/deploy-stage.ts:17-22,186-212` hashes the canonical plan for the runtime
  ID, reserves `.builds/<id>`, installs once, verifies and atomically publishes
  `runtimes/<id>`. Existing candidates are checked rather than rebuilt. No
  `current` switch occurs. `:83-111` refuses implicit stdio acquisition and
  unsupported payloads, and invokes the legacy installer with a reduced env.
- `src/deploy-stage.ts:113-177` binds the plan, recipe, installer lock, engine
  identities and closure census. `src/candidate/manifest.ts:10-36` binds the
  deployment revision and requires full source commits and code artifacts.
  A source commit is not proof of frozen transitive dependency bytes.
- Held and staged lifecycles are intentionally distinct
  (`src/candidate/schema.ts:16-42`). Held preparation and seed completion remain
  separate (`src/candidate/prepare.ts:12-37`, `src/candidate/seed.ts:9-18,57-71`);
  the held verifier explicitly reports missing qualification
  (`src/candidate/verify.ts:141-153`). Layers must not confer activation authority.

Preserve the restrictions and recovery caveats in `docs/deploy-repo.md:1-22,
99-168`. Staging is **not enforced hold**, even when no service is started.
No secrets retrieval, units installation, hooks, seeds, state adoption, switch,
GC or rollback execution is added by this design.

## 2. References, root and acquisition

Proposed opt-in file: `agents/<slug>/deploy.layers.json` in a committed root.
Without it, use slice 1 unchanged, including its existing local working-tree
behavior, schemas, plan bytes, ID and override rules. With it, require explicit
root commit selection and the layered contract; malformed opt-in data must never
fall back to legacy behavior.

Illustrative structure (SHA placeholders are explanatory, not accepted literals):

```json
{
  "schema": "connectome.deploy-layers/v1",
  "layers": [
    {"name": "cook-runtime-stable", "repo": "https://example.invalid/runtime.git", "commit": "<40 lowercase hex>", "subpath": "sets/r1"},
    {"name": "cook-connectors-telegram-vasyl", "repo": "/var/lib/cook/mirrors/connectors", "commit": "<40 lowercase hex>", "subpath": "telegram"}
  ],
  "overrides": []
}
```

The root is implicitly the final participant, not a self-reference. Record its
repo, full commit and agent subpath through the invocation/lock. A layer's
optional subpath defaults to the repository root and contains `layer.json`.
That closed descriptor has optional `pins`, `recipe`, `host`, `units` and
`credentials` fragment file references, each a relative file under that subpath.
Use existing `versions.yml`, `recipe.json`, `host.yml` content shapes where
applicable; do not introduce arbitrary templating. The root continues to use
`agent.yml`, `recipe.json`, optional `host.yml` and optional `versions.yml`.
Root `agent.yml.versions` participates as explicit pin contributions, not an
implicit last-wins exception in layered mode.

Rules:

1. A reference is a structured repo URL **or** absolute local Git path, full
   40-lowercase-hex commit, optional clean relative subpath. No credentials in
   URLs, query tokens, short hashes, branch names, tags or PR refs in deploy
   inputs. Initial SHA-1 Git support matches the materialization boundary; other
   object formats fail explicitly rather than truncate.
2. Root list order is for stable presentation and provenance only, never
   precedence. Unique names and unique `(repo, commit, subpath)` entries required;
   same repo at different subpaths/commits is allowed and clearly displayed.
   Reject transitive layer declarations, cycles/self-inclusion and unknown keys.
   Runtime sets are ordinary leaf layers, not hidden recursive bundles.
3. Separate acquisition from planning: proposed `cook deploy resolve` explicitly
   fetches approved exact commits into a private immutable cache and emits a
   lock. `plan`, `stage` and `check` consume that lock and cached objects; they do
   not refresh layer refs. Plan is read-only, including on cache misses. Missing
   objects give an actionable sanitized unresolved-input error, not a network
   fallback. No network operation was performed for this design.
4. Resolve verifies object identity, selected tree and every declared file before
   publishing a cache entry/lock. Disable hooks, filters, submodules, LFS smudge,
   external Git helpers and ambient Git config/auth inheritance. Bound fetch
   time, object/input sizes and layer count. Refuse symlinks, gitlinks, traversal,
   special files and references escaping the selected tree. Never execute repo
   scripts during acquisition or planning.
5. Offline resolve uses only locally available Git objects/cache. Local-path mode
   reads committed objects, not checkout files: dirty/untracked content has no
   effect and is reported as ignored, never silently included. Non-Git local
   directories refuse; authors commit changes before layered staging. No copying
   sibling worktrees. A machine-local source-location map can provide an approved
   mirror for the same locked source identity without changing the lock.
6. Private remote authentication is a later qualified acquisition adapter. Initial
   recommendation: public HTTPS or explicitly approved local mirrors only. Fail
   unsupported private transport closed; do not forward the operator's secrets.

## 3. Contribution and merge contract

Validate **every** raw fragment, including losing contributions, before merge;
validate again after overrides, placeholder expansion and final recipe lowering.
Partial validation allows absent required fields, not unknown fields or invalid
present values. Final validation requires all slice-1 mandatory fields and
cross-field constraints. Keep five pin keys initially; new connectors can use
explicit source commits without adding magic placeholders.

Only root may provide identity/placement (`host`, `user`, `hold`, `layout`,
`paths`, `release`, `seed_settings`, and host `agentId`/`lineage`). Other layers
may propose host build options and unit/credential intent. Unit commands remain
inert desired metadata, not hooks. Credentials contain names, source/destination
refs, delivery mode and consumer names only, never values or value hashes.
No layer contributes instructions/extras as executable filesystem payloads,
child recipes, sidecars or template files in this slice.

Merge algorithm: collect contributions by schema slot; absent means no opinion.
Canonical-identical values coalesce and retain **all** origins. Different values
conflict and refuse unless a root override covers that exact slot. Root values
also conflict; being last does not make them authoritative automatically.

| Slot | Merge unit and array/map behavior |
|---|---|
| `pins` | Map by known pin key; each string atomic. Reasons are nonsecret review metadata, not executable selectors. |
| Recipe ordinary closed objects (`agent`, strategy, thinking, modules object branches, etc.) | Recurse through schema-defined members; scalar values atomic. Different union branches conflict at the union slot. No generic arbitrary-object merge. |
| `recipe.mcpServers` | Map by server name; each whole server entry atomic. Prevent accidental assembly of command from one layer with env/source from another. Root replacement supplies a complete validated server. |
| Recipe arrays | Atomic ordered arrays: args, tools/features/capabilities, subscriptions, system packages, workspace mounts, ignored paths, channels, examples and `fromTools`. No concat, positional patches, dedup or set union. |
| Recipe dictionaries inside an atomic server | `env`, source and sourceMeta stay inside that server's replacement; no cross-layer env precedence. JSON-looking env strings remain strings, not parsed merge documents. |
| `host` | Map by supported option. `chRepo` + `chRef` form one atomic source pair; a fragment must supply both. Layout and credentialBindings are each atomic validated objects; engine paths and userUnit are atomic scalars. |
| `host.hostDependencies` | Atomic ordered array, including explicit `[]`. Never merge packages/ranges implicitly. Existing G5 validation still applies. |
| `units` | Map by profile; each complete unit atomic, including exec arrays and unit/service/environment/install maps. Duplicate effective service names across profiles refuse. |
| `credentials` | Input array normalized to a map keyed by `name`; duplicate names within one input refuse. Whole route atomic per name; output sorted by name. Conflicting destinations/consumer bindings also refuse after merge. |
| Root placement/path maps | Root-only; exact slice-1 validation, no inheritance. |

Unknown slots refuse. Empty object/array is an explicit value at atomic slots,
not deletion; null is a value only where the schema permits it (`seed_settings`
remains null). No deletion operation initially: removing an unwanted contributed
server requires changing/splitting the layer, not a broad masking patch.

A root override is `{path, expect, value, reason}`: path is an exact schema-aware
JSON pointer at an atomic merge slot; `expect` lists every contributing
`layer@commit`, file/pointer and canonical value digest (including root if it
contributes). `value` is the explicit full replacement, validated normally;
reason is required nonsecret text. Reject wildcards, ancestor blanket overrides,
stale expectations, overlapping overrides and overrides with no conflict.
The digest is of reviewed nonsecret configuration, never a credential value.
For example, two telegram server entries conflict at `/recipe/mcpServers/telegram`;
root must acknowledge both full entries, not just change their `args` leaf.
Changing a losing layer invalidates that expectation and requires fresh review.

Expand pins only after resolution. Preserve `${ENV_NAME}` as references; never
read the environment to evaluate them. Changing a pin without an executable
recipe/host binding is missing input as today. Unit placeholders remain intent.
A root's permission to override does not bypass security or schema refusal.

## 4. Plan, lock and reproducible stage

Proposed `connectome.deploy-plan/v2` contains effective pins, host, configuration,
recipeDigest, missing fields, source inventory, provenance and `layersLockDigest`.
The printed plan shows effective recipe values as well as their provenance (or
an adjacent canonical recipe view); the recipe digest alone is not reviewable.
Use JSON pointers to every effective leaf, array element and empty container.
Each origin is `(layer name, repo, full commit, subpath, file, input pointer)`;
show it as `layer@sha` in human output. For replacement entries, leaves point to
the root override and retain displaced origins. Pin-expanded strings record
both the template origin and pin origin. Defaults, if introduced, have explicit
schema-version origins, never fictional repo provenance. Values/paths are printed
only after full secret/schema validation; invalid raw keys/values are not echoed.

Keep two locks with different responsibilities:

- New `connectome.deploy-layers-lock/v1` (`deploy.layers.lock.json`): root and
  every layer's source identity, commit, selected subpath/tree identity, ordered
  list of admitted files with mode and SHA-256 byte digests, descriptor digest,
  schema/merge algorithm version and frozen effective recipe/host/configuration
  plus provenance. Its canonical digest excludes only its own digest field (if
  present); no timestamps, machine cache locations or moving channel aliases.
  Sorted file records define the selected-input digest; include comments/raw bytes
  so even nonsemantic source edits are auditable. Unreferenced repo files are not
  imported or executed; the commit still identifies the enclosing repository.
- Existing `connectome.lock` remains the installer materialization v1 lock, not
  repurposed as a layer lock (`src/candidate/lockfile.ts:4-11`). It records actual
  installed sources and dependency records and is bound by the envelope.

Avoid hash cycles: freeze source/merge lock first; plan references its digest;
plan ID follows; materialization lock and manifest follow building. The layers
lock contains neither plan ID nor materialization digest. Store it in
`.cook/deploy.layers.lock.json`, make it a manifest config artifact and include
it in the closure census. Extend the explicit metadata allowlist in
`src/deploy-stage.ts:154-156`; no opportunistic acceptance of unknown files.

Layered stage requires a lock: revalidate source/digest/trust, recompose from
cached admitted inputs, compare the frozen result, then call the existing
installer. Check binds lock, plan, recipe, provenance, engines, materialization
and artifacts. Check of a retained candidate can use its stored inputs/lock
without the originating repositories being online. Retain the validated input
snapshot alongside the lock in a bounded private config artifact so this check
can reproduce the merge, not merely trust a cached effective result. Snapshot
files and their census are manifest-bound; admit only declared nonsecret files,
not the entire source checkout. It must still apply current
trust policy and verify all bindings. No implicit lock updates on stage/check.
A stale root/lock pair fails and asks for explicit resolve/review.

**Reproducibility boundary:** layer pinning makes configuration reproducible, not
arbitrary shell builds deterministic. Before declaring a layered lock stageable,
freeze all executable Git refs to commits, package inputs to exact versions plus
integrity, G5 archives to digest, engines to expected byte digests and required
build closure to retained content. Record these in the lock's build-input section;
reject unresolved npm ranges/tags, missing closure or uncontrolled downloads.
A source-only lock may carry explicit missing build-input records for planning,
but is not stageable or eligible for candidate promotion. Never synthesize
missing engine/dependency digests from labels. The new locked installer boundary
must consume these inputs without re-resolving
refs or fetching dependencies. Offline stage is supported only with that complete
cache; a cache miss refuses before reserving a build. This is additional work,
not a claim about slice 1's `--pin-refs` invocation (`src/deploy-stage.ts:100-109`).
Custom builds that cannot meet this contract remain planning-only. Even a fully
pinned build may be nondeterministic; reuse the verified saved candidate for
byte-identical promotion rather than promise rebuild equivalence.

Runtime ID remains lowercase SHA-256 hex of canonical resolved plan, using the
v2 schema discriminator. `{build}` expansion follows ID derivation, avoiding a
path/hash cycle. Same lock/plan at the same root selects the same candidate;
changed provenance or commits produce a new ID even if effective values match.
The envelope remains `connectome.deployment/v1`, `staged-candidate`, with
`desired.configDigest = hash(canonical(plan))`, installed/running null. The new
config artifact participates in `deploymentRevision`; do not put a digest into
`configRevision`, which is a Git commit slot (`src/candidate/schema.ts:102-106`).
Keep held-only readers/seed behavior unchanged. Preserve stable absolute build
paths and no-relocation constraints (`docs/deploy-repo.md:117-129`).

## 5. Named runtime sets and promotion

A runtime set is an ordinary leaf layer revision containing a coherent pin/host
build-input recipe, optionally connector defaults. `stable`, `latest`,
`experimental`, `ba-agents`, `feat-x` are arbitrary aliases for `(repo, commit,
subpath, digest)`, not privileged branches or reserved runtime types. An optional
reviewed catalog outside the build inputs maps those names to references.
Selecting a catalog entry is an explicit resolution operation; root deploy
inputs and locks contain the frozen reference, never a live alias lookup.

Example: catalog `latest -> R7`, `experimental -> R8`, `stable -> R6`.
Resolve latest once and build agent A with R7. Moving upstream main or changing
latest to R8 cannot change A's lock. Promotion sets stable to **the same R7
reference/digest**, and associates A's already verified lock/candidate with that
promotion; it does not build again. Catalog commit, selection spelling, approver
and time belong to a separate promotion receipt, not the frozen build plan.
Keep layer instance names fixed during promotion: renaming a layer or editing
root composition changes provenance/ID and is not metadata-only promotion.

The immutable root commit remains in the lock. Do not rewrite root files merely
to relabel latest as stable and then expect the same plan ID. Future resolutions
may use stable's target; an existing deployment promotes the **same lock**.
Different agents/configuration/engine/platform bindings may need different
candidates even with the same runtime-set revision. Cross-machine binary reuse
or relocation is not provided. At the same build root, repeated stage checks the
saved candidate without rebuilding; missing retained bytes require explicit
restaging and new verification, not a claim of byte-identical promotion.

Rollback input is the previous complete lock, not re-resolution of yesterday's
stable name. Retain its candidate, manifest, installer lock, effective configuration
and unit intent. Future activation must separately authorize the matching
code/config/unit tuple and state compatibility; layers never restore credentials,
history or queues. Do not prune referenced `.builds` trees. This implements the
*selection model* for rollback, not a rollback command or recovery guarantee.

## 6. Trust and secrets

Recommend operator-controlled allowlists of exact repository identities and
local source roots, evaluated before acquisition and again before stage. A layer
cannot allowlist itself, extend trust, enable transitive imports or grant build
permissions. Track the policy digest in a separate admission receipt bound to
the lock/plan; changing policy must trigger re-admission, not silently rebuild
or mutate a candidate. Allowlisting establishes eligibility for review, not
safety of arbitrary code. Source code and custom installers are not sandboxed
by current staging. Network-enabled/custom builds need separate qualification.

Reject secret literals in every admitted descriptor, fragment, override and lock,
including overridden values. Reuse and tighten typed reference guards, bounded
strict parsing, URL checks, duplicate-key rejection and sanitized errors
(`src/deploy-repo.ts:36-52,107-129`, `src/candidate/schema.ts:180-217`). Do not
serialize rejected values or hashes of them. Input bounds should include an
aggregate budget (recommend 32 layers, 2 MiB/file, 32 MiB total admitted inputs)
to prevent many-small-file bypasses. Unconsumed repository content is not scanned
as a claimed credential audit; never import it as build configuration.

Existing secret detection is heuristic, not proof that prose contains no secret.
In layered sensitive env/token slots allow only declared `${ENV_NAME}` or typed
credential references, not arbitrary slash-prefixed strings merely resembling
paths. Credential routing stays external/private and no credential bytes are
opened by resolve/plan/stage/check. Keep remote source authentication separate
from runtime credential intent. No ambient env inheritance or auth hooks; no
Vault calls, value rendering, token validation or restart on promotion.

## 7. Migration grounded in supplied references

Reference boundary: an internal migration plan (not public) is a read-only
proposal/historical report, not evidence of current production or current cook
behavior. Its §4.1–4.3 and §7 motivate separate desired/materialized state,
private recovery, external provider tooling and retained rollback tuples. Its
claims about ba-agents beyond the supplied connectome-agents shape are
**unverified here**; do not infer actual ba-agents URLs, commits, agent inventory,
Vault implementation or runtime compatibility from them.

Inspected reference: a private ba-agents-shaped fleet repository,
using `git show` and `git ls-tree`, without fetching or running its launcher.
`versions.yml:1-13` has runtime/slack/telegram/github_mcpl/terminal_sessions
labels and reasons in comments, not full executable source commits. Its runtime
comment explicitly labels some build/toolchain information unverified.
The inspected `agents/` tree contains one agent directory with `agent.yml`,
`recipe.json`, `SERVER.md` and `launch.py`. `agent.yml:1-29` records legacy placement and
unit intent; `SERVER.md:3-10` says this is an offline import and that required
`deployment.json` is absent. None of this proves live readiness.

Migration steps, not actions performed by this task:

1. Treat a reviewed `versions.yml` snapshot as the **first runtime set**, named
   `ba-agents` if the owner prefers. Preserve the five labels and comments. Add
   explicit repo/full-commit/toolchain/dependency bindings from separately
   supplied evidence; never expand short directory labels into invented hashes.
   Until supplied, this set can plan but cannot stage. This imports the observed
   shared-pins pattern, not an unseen ba-agents deployment system.
2. In connectome-agents, add the opt-in root list only after an unchanged legacy
   plan is captured as a fixture. Initially point to a local committed layer
   with the existing pins; retain identity, paths, units, credentials and seed
   settings at the agent root. Fill missing host inputs explicitly.
3. Extract connector entries one at a time into reviewed layers. Compare complete
   effective recipe/unit/credential intent before and after. Historical concrete
   paths require deliberate edits to explicit bindings, not substring rewriting.
   Existing stdio entries need acquisition metadata; the reference's launcher
   and absent deployment/env files cannot be imported as a reproducible closure.
   No automatic script execution or sibling copying to paper over missing inputs.
4. Produce and review a frozen lock; exercise only synthetic offline stage/check
   and promotion/rollback-selection fixtures first. Keep the old production
   method intact. Layer support does not satisfy migration §7's units, seed-once,
   full recovery, connector qualification or the private fleet's acceptance requirements.

## 8. Delivery slices and tests

Estimates are engineering-day estimates including focused tests, not commitments;
exclude review latency, live qualification and dependency-owner work.

| Slice | Deliverable / exit evidence | Estimate |
|---|---|---|
| L1 | Closed fragment/root schema, merge/override engine and per-field plan provenance; local committed-object reader; legacy golden plans unchanged. Planning only. | 3–5 days |
| L2 | Allowlisted acquisition/cache, offline/local resolver, immutable source lock and frozen runtime-set selection. Negative transport/path/cache tests. | 3–5 days |
| L3 | Complete build-input admission and locked installer handoff; staged lock artifact/check integration; missing dependency closure refuses. Split closure adapters by supported source kind. | 5–10 days; higher if upstream build inputs cannot be frozen |
| L4 | Metadata-only promotion and previous-lock rollback selection, retention documentation, sanitized connectome-agents migration fixtures. No activation. | 2–4 days |

Test plan for implementation:

- Pure merges: reordered maps, identical contributions/all origins, conflicting
  scalar/pin/union/server/unit/route, atomic arrays (including empty), duplicate
  names, prohibited deletion, stale/overlapping root overrides, invalid losing
  fragments and post-expansion cross-field failures. Permuting layers cannot
  change effective values; presentation order remains explicitly locked.
- Acquisition: full SHA versus tags/branches, missing objects offline, local dirty
  worktree ignored, missing commits, corrupt cache, escapes/symlinks/gitlinks,
  duplicate/escaped JSON keys, aggregate size limits, transitive declarations,
  non-allowlisted source, URL credentials and disabled Git filters/helpers.
  Use local synthetic Git repos/fake fetch only; no live credentials.
- Secret sentinels in every layer, losing fragment, override, URL and inherited
  env: refusal with no sentinel in stdout/stderr, argv, cache metadata, plan or
  lock. Check credential file contents are never read. Invalid keys stay private.
- Identity: recomposition matches lock; any file/mode/commit/provenance/build-input
  tamper refuses. Stable/latest aliases resolving to the same target yield the
  same frozen plan; moving main/alias afterwards has no effect. Changing root
  commit changes ID; pure promotion leaves lock, ID and candidate bytes intact.
- Production-path fixture: actual CLI resolve → plan → stage → check with local
  synthetic sources and a hermetic build, network disabled and fake build counter.
  Second stage/promotion must not increment the counter. Corrupt a dependency,
  engine or lock and require refusal; missing closure must fail before reservation.
  Verify manifest export includes lock artifact and unchanged lifecycle separation.
- Publication: concurrent stages, failed build, crash before/after publication,
  foreign links, wrong modes/owners and retained previous lock; no `current`,
  units, history, workspace or credentials writes. Previous-lock selection works
  offline and preserves newer state. Old slice-1 fixtures retain identical plans,
  IDs and behavior; held prepare/seed/verify still reject staged envelopes.

This design-only change requires document/citation/scope checks, not a build or
runtime test. The tests above are future gates, not results claimed here.

## 9. Open questions for owner

1. **Naming/catalog policy:** adopt `deploy.layers.json`, `layer.json` and a
   separate optional runtime-set catalog? Recommend these explicit opt-in files;
   reserve no semantic prefixes or special names, including latest/stable.
2. **Trust authority:** who maintains repo/local-root allowlists and approves
   custom builds/private acquisition? Recommend operator-owned policy outside
   layer repos; public HTTPS/local mirrors first, no transitive layers. Revisit
   signed catalogs only with a named signing/revocation owner.
3. **Promotion authority/retention:** who approves moving stable and how long are
   prior locks/candidates retained? Recommend reviewed metadata-only promotions,
   retain at least current and previous verified tuples plus recovery-policy
   requirements; no automated GC in these slices.
4. **Initial runtime-set completeness:** who supplies authoritative full commits,
   engine bytes and closure for the observed versions labels? Recommend begin
   with a planning-only ba-agents-pattern snapshot; never infer missing facts or
   treat connectome-agents' offline import as a deployable release.

## 10. Review checklist

For an implementation review, require explicit evidence that (a) no layered
command silently falls back to the legacy reader, (b) catalog metadata is absent
from the plan hash while all actual source provenance is present, (c) both input
snapshot and lock are verified before trusting effective values, and (d) engine
and dependency hashes are typed digest slots rather than secret-scanner bypasses
for arbitrary strings. A successful plan with missing inputs is not a successful
stage, and a successful check is not activation or migration qualification.

## 11. Residual limits

This design changes no implementation and authorizes no deployment. Closed
schema/secret heuristics cannot prove arbitrary prose safe; allowlists cannot
prove source code safe; pins alone cannot make arbitrary builds deterministic.
Saved candidates remain path-bound and susceptible to same-uid mutation, which
check detects rather than prevents. A previous lock is not a backup of mutable
state, private credentials or provider identity. Actual ba-agents behavior and
production compatibility remain unverified beyond the supplied source shape.
