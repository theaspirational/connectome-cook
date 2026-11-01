# Deployment/recovery manifest v1 (opt-in)

The existing **`connectome.deployment/v1`** envelope gains one optional field,
`manifest`. There is no second deployment schema and no change to cook lock v1.
Preparation still emits the original envelope byte format without this field.
A legacy envelope is readable, but is not a complete recovery declaration.

```sh
cook deployment export connectome.deployment.json --lock connectome.lock \
  --bindings bindings.json > deployment-export.json
cook deployment export deployment-export.json --lock connectome.lock
```

Both commands are offline and read-only; stdout is one canonical JSON envelope
plus newline. Refusals have empty stdout and a value-free code on stderr
(usage 1, validation 2, I/O 3). `--bindings` explicitly enriches a legacy
record and refuses an already enriched envelope; it never edits the source
envelope/lock or records installation/running.
Without that flag only a complete manifest can be exported. No provider lookup,
secret save, fetch, build, unit action, activation or history writer is invoked.
Existing help/default commands are unchanged; use `cook deployment --help`.

## Binding fields

`bindings.json` is the `manifest` object **without** its derived `revision`.
All listed fields except `configRevision` are required; every object is closed. Duplicate JSON keys,
unknown fields/schemas, malformed digests and unresolved source pins reject.
`Name` is `[A-Za-z0-9][A-Za-z0-9_.@-]*`; names in each list are unique.
`Digest` is `sha256:` plus 64 lowercase hex digits.

| Field | Shape / meaning |
| --- | --- |
| `configRevision` | Optional: absent, null, or a full 40-character lowercase configuration Git commit; no branch/tag/PR head. A supplied commit is unverified metadata and is included in the deployment revision. |
| `profiles` | Nonempty distinct Name array, at least one unit per profile. |
| `roles` | `{name, kind, path, owner: {uid, gid}}[]`; kinds `config` and `runtime` required; `state`, `workspace`, `credentials` optional, except credentials are required when providers are nonempty. Config/runtime roots must neither contain nor be contained by state/workspace/credentials roots. Paths are distinct canonical absolute POSIX paths; owner IDs are nonnegative safe integers. Repeat a kind for split roots. Envelope `agent.id`/`lineage` remain the immutable subject identity, not inferred from accounts/paths. |
| `providers` | `{name, required, consumer, role, destination}[]`; references **by name only**. `consumer` names a profile, `role` a credentials-role name, `destination` a canonical relative path. Destinations cannot collide within a role. No provider type, retrieval parameters, values or value hashes. Empty array means no providers. |
| `units` | Nonempty `{name, scope, profile, artifacts, after}[]`; scope `user` or `system`, profile from `profiles`, nonempty distinct artifact-name array. `after` contains distinct other declared unit names in an acyclic graph (internal ordering only). This declares bindings, not generated/effective systemd units or readiness. |
| `artifacts` | Nonempty `{name, role, path, digest}[]`; role names a config/runtime role, path is canonical relative to that role. Both config and runtime artifacts required. Every locked host/component/local-extension code root needs a matching runtime artifact. Digests are supplied nonsecret artifact/closure metadata, not a claim that cook verified the closure. |

Example bindings for the historical synthetic fixture in
`test/fixtures/deployment-v1/`:

```json
{
  "configRevision": "cccccccccccccccccccccccccccccccccccccccc",
  "profiles": ["default"],
  "roles": [
    {"name":"config","kind":"config","path":"/srv/fixture/config","owner":{"uid":1000,"gid":1000}},
    {"name":"runtime","kind":"runtime","path":"/srv/fixture/runtime","owner":{"uid":1000,"gid":1000}},
    {"name":"state","kind":"state","path":"/srv/fixture/state","owner":{"uid":1000,"gid":1000}},
    {"name":"workspace","kind":"workspace","path":"/srv/fixture/workspace","owner":{"uid":1000,"gid":1000}},
    {"name":"credentials","kind":"credentials","path":"/srv/fixture/credentials","owner":{"uid":1000,"gid":1000}}
  ],
  "providers": [],
  "units": [{"name":"fixture.service","scope":"user","profile":"default","artifacts":["host","configuration"],"after":[]}],
  "artifacts": [
    {"name":"host","role":"runtime","path":"app","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    {"name":"configuration","role":"config","path":"recipe.json","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
  ]
}
```

These are synthetic digests, not restore evidence. Review metadata before public
export: labels, paths and the lock must be nonsecret. Arbitrary operator text
cannot be reliably secret-scanned. Never supply private configuration bytes or
hashes of credentials, state, workspace or seed data. Artifact paths overlapping
private role trees reject; config/runtime role roots also cannot overlap private
role roots in either containment direction.
No role contents, environment values or provider values are read by export.
Config artifacts must cover **nonsecret** files only; private config is represented
by a credentials role/reference, not by an artifact hash. `required: false`
records optionality, not evidence that a consumer has been suppressed; lifecycle
integration must enforce that before activation.

`revision` hashes canonical `{agent, desired, materialized, bindings}`, where
`bindings` is the manifest without revision. It binds existing config/lock
hashes, optional unverified configuration commit, artifacts and all deployment
bindings. Changing config with unchanged code changes revision. Lock hash
covers exact bytes including timestamp/newline, so rematerializing may also
change revision. This conservative version identifier is not a code-only hash.
The manifest export/read adapter recomputes revision, not the generic wire
validator. Legacy records incur no revision computation. Export also verifies
exact lock bytes, full host/component commits, credential-free source URLs and
artifact-root coverage. It
cannot prove a supplied config commit, artifact digest or owner mapping is true.

## Compatibility and observations

`materializationV1(envelope, lockBytes)` is the explicit adapter to the existing
host lock v1 reader: legacy envelopes stay legacy (no invented roles/revision),
complete envelopes get additional binding/pin checks. Seed binding and held
verification use this boundary; old `readLockfile` still reads unchanged lock
bytes. Historical unpinned locks remain readable but cannot be promoted/exported
as complete manifests. Split-role declarations do not widen held preparation or
seed's local `data` scope; they are declarative input for later recovery adapters.

Observation records and their readers are deferred until a qualified producer
and consumer exist. Observed-running evidence must remain separate from declared
state; `installed` and `running` stay null, including incomplete transactions.
No preparation or export claims that a deployment is running or authorizes
activation.

This is a recovery **declaration**, not a checkpoint, cold copy, restore receipt,
secret backup or claim of recoverability. Covered/excluded inventories, stopped
writer evidence, independent recovery code/secret routes and restore-drill
qualification belong to the subsequent checkpoint/restore contracts.
