# connectome-cook

Recipes in, deployments out. A CLI that takes a [connectome-host](https://github.com/anima-research/connectome-host) recipe (single agent or multi-agent fleet) and materializes it — either as a runnable Docker artifact bundle (`cook build`) or as a direct install onto your machine (`cook install`), with all required MCP servers **and code extensions** baked in.

The pipeline is split in two: a backend-agnostic *resolution* step (walk the recipe tree, detect components, probe host requirements, collect env/credential values) produces an install plan; a backend materializes it. Every materialization writes a `connectome.lock` recording what was resolved, and `cook run` launches from the lock without re-resolving.

> **Status:** alpha. The core pipeline works — `cook init`, `cook check`, `cook build`, `cook install`, and `cook run` all do something useful, end-to-end against the in-repo Triumvirate example. Expect rough edges around `--json` reports and pip-editable arg overlays. Not yet on npm.

## Install

For now, clone + run via Bun:

```bash
git clone https://github.com/Tengro/connectome-cook.git
cd connectome-cook
bun install
./bin/cook --help
```

(npm publish + the standalone `cook` binary are tracked under Phase 4 polish; for now the bin shim runs Bun-on-source directly.)

## Usage

```bash
# Scaffold a starter recipe.
cook init "My Agent" --template minimal --out my-agent.json

# Validate it + see what cook would build.
cook check my-agent.json

# Generate the Docker artifact bundle (Dockerfile, compose, .env.example,
# README, recipes/).  Prompts for any required env vars unless --no-prompts.
cook build my-agent.json --pin-refs --out ./my-agent-cook

# Install directly onto this machine — no docker. Clones + builds every
# component under ~/.connectome/installs/<name>/, resolves host requirements
# (probe + confirm), writes run.sh + connectome.lock. The full action plan
# is printed and confirmed before anything executes on your machine.
cook install my-agent.json

# Launch. Finds an existing materialization (lock in the named dir, then
# ./<name>-cook, then ~/.connectome/installs/<name>) and launches it without
# re-resolving; falls back to build-then-compose-up (pinning is optional).
# --rebuild forces a re-cook.
cook run my-agent.json -- -d            # detached (docker) / launcher args (host)
cook run ~/.connectome/installs/my-agent # launch a materialized dir directly
```

The bin is also installed as **`connectome`** — `connectome cook <recipe>`,
`connectome install <recipe>`, `connectome run <recipe>` are the same commands.

### Extensions

Recipes can carry deployment-specific code — custom context-manager
strategies and agent-framework modules — via the `extensions` block
(connectome-host ≥ the `feat/recipe-extensions` seam):

```jsonc
{
  "agent": { "strategy": { "type": "zk", "floodWindowMs": 250 } },
  "extensions": {
    "zk-strategy": {
      "kind": "strategy",                      // or "module"
      "path": "./extensions/zk/index.ts",      // entry module
      "source": { "url": "https://github.com/you/zk-ext.git", "ref": "main" }
    }
  }
}
```

- **With `source`**: cook clones/builds it into `/app/extensions/<name>`
  (docker) or `<install>/app/extensions/<name>` (host); `path` is relative
  to the repo root. Same install patterns as MCP sources (`npm`,
  `pip-editable`, custom run commands, authSecret, systemPackages).
- **Without `source`, relative path**: cook bundles the entry file's
  directory from your disk (docker) or uses it in place (host).
- Extensions live under the connectome-host tree so they share its
  `node_modules` — `extends AutobiographicalStrategy` resolves against the
  exact versions the host ships.

### Host requirements (discovery)

For code that must link against things already on the machine:

```jsonc
"requirements": {
  "spring-engine": {
    "probe": ["/opt/spring", "~/spring", "$SPRING_HOME"],
    "prompt": "Path to your Spring engine install",
    "exposeAs": "SPRING_HOME"
  }
}
```

Cook probes the candidates, suggests the first hit, lets you confirm or
override, and exposes the answer as `$SPRING_HOME` — usable in recipe
`${VAR}` references. For install steps, export the parent value and explicitly
select its name with `COOK_PASS_ENV` (see below). The lock records requirement names and
origins, never their resolved answers. **Secrets must not be literals in recipes;
supply them through requirements**, not literal defaults or template/environment
strings. `recipe.sha256` and `build.id` are computed from the recipe bytes as
written (including any literal secret), not a redacted recipe.

### Host build environment and source credentials

Git pin resolution and host materialization share filtered process settings
with install commands (`bun install`, npm/pip installs, and custom scripts).
The default parent-variable allowlist is:

- `PATH`, `HOME`, `TMPDIR`, `LANG`, `TERM`, `CI`, `USER`, `LOGNAME`, `SHELL`;
- `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `LC_COLLATE`, `LC_MONETARY`, `LC_NUMERIC`,
  `LC_TIME`, `LC_PAPER`, `LC_NAME`, `LC_ADDRESS`, `LC_TELEPHONE`, `LC_MEASUREMENT`,
  `LC_IDENTIFICATION`;
- `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` and their lowercase forms;
- `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`;
- `PYTHON`, `npm_config_registry`, `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL`,
  `UV_INDEX_URL`, `CARGO_HOME`, `RUSTUP_HOME`, `PKG_CONFIG_PATH`, `CC`, `CXX`,
  `SSH_AUTH_SOCK` (including package-manager Git dependencies).

These are exact names, not prefix wildcards: other `npm_config_*`, `PIP_*`,
`UV_*`, `CARGO_*`, `RUSTUP_*` or `LC_*` variables require explicit selection.

Host builds receive **only** this base allowlist and explicitly selected parent
names. For operator-only inputs, set **`COOK_PASS_ENV`** to comma- or whitespace-separated
parent environment **names**, for example:

```sh
COOK_PASS_ENV=NPM_TOKEN,PRIVATE_SDK cook install recipe.json
```

Only selected, set parent variables are forwarded; an unset parent name is
omitted, never filled from a requirement, probe, prompt or `--env-file` value.
Recipe requirements, env `${VAR}` values, env-file values and `authSecret`
values are **not injected into build environments**. This is structural, not a
provider/sidecar/Git name-exclusion policy: **any** name (including
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, sidecar secrets, `authSecret` names,
`GIT_SSL_KEY` or `DBUS_SESSION_BUS_ADDRESS`) can be explicitly selected, and
then only its parent value is used. Build selection never overrides Git's
separate acquisition/authentication policy.

**Migration:** requirements needed at build time must be named in COOK_PASS_ENV.
Export the desired value in the parent shell, for example:

```sh
SPRING_HOME=/opt/spring COOK_PASS_ENV=SPRING_HOME cook install recipe.json
```

Previously cook passed its whole environment to host builds. It never injected
resolved requirements, although this README said they were available to install
steps. The explicit parent channel keeps that use case without forwarding recipe
values. Additional package-manager settings previously covered by broad prefix
allowlists must also be selected explicitly.

Cook never prints or persists values **via the COOK_PASS_ENV channel** in locks,
generated READMEs, recipes or the runtime `.env`. Normal recipe-declared runtime,
credential-file and requirement materialization is separate and unchanged by
this filtering: the runtime `.env` retains the same names, values and mode (0600), including
names that are also `authSecret`; v2 locks record requirement names only.
Trust every build receiving an explicitly selected credential.

Git additionally receives by default `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`,
`GIT_ASKPASS`, `SSH_ASKPASS`, and `GIT_TERMINAL_PROMPT` for external authentication;
`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `XDG_CONFIG_HOME`,
and `GIT_CONFIG_COUNT` with its indexed `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
entries; the path-valued `GIT_SSL_CAINFO`/`CAPATH`/`CERT`/`KEY` and corresponding
`GIT_PROXY_SSL_*` variables for custom CAs and client certificates; and
`DBUS_SESSION_BUS_ADDRESS`/`XDG_RUNTIME_DIR` for desktop keyrings. Helper settings
`GCM_*` and `GH_TOKEN`/`GITHUB_TOKEN` go to Git by default, preserving existing Git
Credential Manager and GitHub CLI setups. Builds receive these only if explicitly
selected. Ambient repository-redirection variables such as
`GIT_DIR`/`GIT_WORK_TREE`/`GIT_CONFIG_PARAMETERS` are not forwarded to cook's Git
subprocesses, even if selected for builds.

Allowlisted package-manager variables, proxy URLs and operator-selected values
can carry credentials: forward these only when you trust the build scripts,
which can print or persist anything they receive. This filtering prevents
accidental exposure; it is **not a sandbox**. Builds run as your user, can read
local files (including tool configuration under `HOME`), and on Linux may read
cook's unfiltered parent environment via `/proc/$PPID/environ`. Do not run
untrusted recipes with secrets in cook's environment.

Source URLs must not embed password/token userinfo. Bare usernames such as
`https://user-name.1@host/repo.git` are allowed for credential-helper account
selection. After percent-decoding, usernames must be non-empty and contain only
ASCII letters, digits, `.`, `_` and `-`. Any password component (even empty)
is refused. Known token prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
`github_pat_`, `glpat-`) are rejected anywhere in the decoded username, case-insensitively,
as are token usernames (`oauth2`, `x-access-token`, `x-token-auth`).
Protocol-relative (`//host/path`) spellings require an explicit scheme.
Query strings and fragments are unsupported and rejected: source path
derivation does not support these suffixes. This validation is not shell quoting
and does not make generated Docker commands safe for arbitrary URLs or refs.
Surrounding whitespace and ASCII control characters are also rejected. Unknown
token formats may not be recognized: never put credentials in a source URL.

Host HTTP(S) sources support `authSecret`: cook resolves the named token from
`--env-file`, the parent environment, or the prompt, and sends Git an
origin-scoped `http.<source origin>/.extraHeader` (`Authorization: Basic` with
`oauth2:<token>`). This is appended to the operator's existing indexed
`GIT_CONFIG_*` entries for every Git call of that source (including pinning and
fetch), never put in argv, the URL, `.git/config`, logs, or the build environment.
The Git credential channel does not add values to the lock or output artifacts.
Runtime `.env`, recipes and locks retain main's semantics without classifying
names by their Git use: `.env` includes resolved `authSecret` values, and resolved
requirement values remain in the lock even if the name is also an `authSecret`.
Runtime persistence does not forward those values to build subprocesses.
Missing tokens and unsupported transports fail with the declaring source
location; SSH and other
transports can use externally configured Git authentication instead.
An unrecognized credential embedded by the user in a source URL would still be
written to `.git/config` and the lock, so never put credentials in source URLs.

### Sidecars in host mode

`cook install` supports recipes with sidecar `services` and
`containerTemplateFiles`: the agent process runs natively, but sidecars
(databases, wikis) run under docker via a generated
`docker-compose.sidecars.yml`. `run.sh` brings them up with
`docker compose up -d --wait` before exec'ing the agent, renders
runtime templates with `envsubst` (needs `gettext-base`), and honors
`COOK_SKIP_SIDECARS=1`. One networking caveat, warned about at install
time: the native agent reaches sidecars via their **published localhost
ports** — compose service names only resolve inside the docker network.

### Pinned builds

Docker `build` works without `--pin-refs`; unresolved commits are omitted,
not guessed. Add `--pin-refs` for immutable Git provenance.
`--pin-refs` (also optional on `install`) resolves every branch/tag ref —
components and connectome-host itself — to its current commit SHA via
`git ls-remote` at cook time. The SHA is baked into clone/checkout steps
(and the `CH_REF` build-arg default) and recorded in `connectome.lock`,
so rebuilding later reproduces the exact trees. Unresolvable refs (offline,
authentication failures) fail before any files are written or clones/builds start.
Private `authSecret` symbolic refs use the same environment-only token channel. Only full
40-hex SHA-1 or 64-hex SHA-256 object IDs are trusted without remote lookup;
short hex strings are resolved as symbolic refs, like other branch/tag names.
Abbreviated commit IDs cannot be pinned: use the full 40-hex ID from
`git rev-parse <ref>` with `--pin-refs`.

Compatibility: Docker `cook build --pin-refs` also resolves private symbolic
refs with `authSecret` instead of warning and continuing unpinned. Resolution
failures are fatal. Docker image-build authentication without `--pin-refs` is
unchanged; its existing credentialed-remote persistence is not fixed here.

### `connectome.lock` v2

Both backends write v2; readers accept v1 and v2 and refuse unknown versions.
The next successful build/install rewrites a v1 record as v2 (host reconcile
can keep matching checkouts, reading their actual `HEAD` even if v1 omitted
commits). An unreadable/unknown host lock refuses reconcile rather than
silently reinstalling. `cook run` still launches either version without resolving.

The record adds:

- `cook: {version, commit?}` (package version; commit omitted because installed
  packages have no reliable source checkout), `recipe: {path, sha256}` (exact
  loaded UTF-8 root JSON, before validation/substitution), and full
  40/64-hex Git commits for connectome-host and Git components when known.
  Docker omits unresolved commits; host requires actual checkout HEADs.
  Any recorded commit must be a full SHA.
- Discriminated `components`: `kind: "git"` provenance, or
  `kind: "npm", name, spec, version?, integrity?` plus the existing key/role.
  `spec` preserves the complete declared `source.npm` string; `name` is its
  package name and `version` is included only for an exact version. Tags and
  ranges remain accepted. Only explicit `source.npm` entries are inventoried;
  bare npx/uvx commands remain runtime-managed. No registry lookup is added.
  Integrity is included only from offline metadata already available to cook;
  currently there is none, so it is omitted. Docker installs the declared spec;
  host retains its existing npx behavior, not a global-install claim.
- `build: {id, dir}`: absolute output directory and deterministic ID described
  below; `credentials: string[]`: sorted unique input names, never values.
  `LockedRequirement` has **no secret discriminator** on main; its old
  `value?: string` could leak any secret supplied via `requirements.exposeAs`.
  V2 removes all requirement answers, including ordinary paths, from the lock;
  resolution, install environment and `.env` are unchanged. Old v1 locks
  may already contain secrets: rewriting cannot undo a previous disclosure. Credential names
  reuse `deriveRequiredVars`/`RequiredVar` (build/sidecar scopes and provider
  alternatives), requirement env names and credential-file field overrides
  (or `path#field` without an override). Unclassified runtime/requirement
  inputs are included conservatively, so this is a superset of secret names.
- `outputs`: explicit generated-file inventory, with build-relative paths,
  SHA-256 digests and numeric permission bits (`mode & 0777`). Launch files,
  Compose/Dockerfile/docs and lowered recipes normally have hashes. Before
  computing any public output digest, cook checks its generated bytes against
  **every resolved requirement answer**, regardless of source (prompt, process
  env, env-file, or accepted probe/default). Raw values and cook's JSON, YAML,
  Docker env and shell-escaped forms are checked, including embedded values.
  A match gets mode only plus `"sha256Omitted": "contains-requirement-value"`;
  neither the matching value nor its name is recorded. All **non-empty** values
  match, even one character: short secrets must not retain offline verifiers.
  This can conservatively omit unrelated hashes for common short answers;
  empty/unresolved answers match nothing. `.env` has **mode only**, never
  content/hash. Credential/secret files and rendered templates
  also have mode only: hashing a rendered secret would expose a verifier.
  Paths are resolved then made build-relative and deduplicated; if a public
  path is also declared sensitive, sensitive wins and only mode is recorded.
  Hashes are computed from generated bytes in memory before writing: a hash
  describes what cook wrote, **not what is on disk**. Public outputs whose
  generated bytes are unavailable get mode only (currently none). Cook does
  **not** defend writes against a pre-seeded output directory; use a fresh
  directory. Links and concurrent changes can still redirect/overwrite writes.
  The lock itself, cloned/copied trees and operator state are not hashed.

**Recipe secret boundary:** secrets must not be literals in recipes; supply
secrets through requirements instead. `recipe.sha256` and `build.id` are
computed from the recipe bytes as written, including literal secrets: the
public-output guard does not redact or change input identity. These identity
hashes can therefore verify guesses about an operator-supplied literal secret.

**Identity formula:** `build.id = hex(SHA256(UTF8(canonicalJSON(input))))`.
Canonical JSON sorts object keys lexically, omits undefined object properties,
retains array order and has no whitespace. `input` is:
`{recipe: rootSha256, recipes: [{path, sha256}, ...],
pins: {connectomeHost: {url, ref, commit}, components}, cook: {version},
backend, options}`. Recipe identity paths are relative to the root recipe
directory (including the root filename), never absolute; URL trees use
relative URL pathnames plus query strings. Recipes retain walker order;
component pins sort by key. Moving an identical tree or changing only the
output directory keeps the ID.
Git pin entries contain `kind,key,role,url,ref,commit,install`; npm entries
contain `kind,key,role,name,spec,version?,integrity?`. Options are `strict` and
`allowIncompleteTemplates`, plus Docker's optional `imageName`. Timestamps,
output/check-out directories, prompt flags, env-file paths and resolved values
are excluded; every pin participates. Programmatically constructed walks that
lack loader hashes use SHA-256 of canonical recipe JSON. This is an input
identity, not a claim that arbitrary install scripts/dependencies are hermetic.

Local extension paths remain in `localExtensions`. Sibling copies have no Git
provenance and are excluded from the Git inventory on both backends (Docker
already excluded them); no invented SHA is assigned. Without a split layout there is no cook-defined
state root outside `build.dir`: the host launcher defaults to
`build.dir/data`, and Docker's generated bind paths are build-relative.
In that case `state` is omitted, not guessed from ambient `DATA_DIR` or arbitrary
recipe mounts. Split layouts record their declared state root. Engine bindings,
unit hints, layout declarations and host dependency inputs remain optional
extensions; they do not alter the v2 identity formula. Health is not added.

### Templates

- `minimal` — single agent, no MCP servers, generic system prompt.
- `zulip-agent` — single agent staffing a Zulip channel.
- `triumvirate` — three-agent fleet (miner + reviewer + clerk) with conductor.

### Build flags

```
--out <dir>            Output directory (default: ./<recipe-name>-cook)
--strict               Fail if any MCP server lacks a `source` block
--image-name <name>    Override the generated image name
--no-prompts           Non-interactive; warn-and-continue on missing values
--env-file <path>      Read variable values from this file before prompting
--pin-refs             Optional: resolve full Git commit SHAs
```

### Anthropic credentials

A recipe tree whose agents all explicitly set `agent.provider` to `openai-codex` needs no implicit Anthropic credential. Trees containing an Anthropic agent, an omitted provider (which defaults to Anthropic), or an unknown provider retain the Anthropic requirement: either `ANTHROPIC_API_KEY` (a standard API key from [console.anthropic.com](https://console.anthropic.com/)) or `ANTHROPIC_AUTH_TOKEN` (a long-lived OAuth bearer token, sent by connectome-host as `Authorization: Bearer` instead of `x-api-key`). Cook's prompts, generated `.env.example`, and missing-value checks accept either — press Enter at the `ANTHROPIC_API_KEY` prompt to be offered the auth-token alternative. If both are set, connectome-host prefers the auth token. For every provider, when a recipe explicitly substitutes `${ANTHROPIC_API_KEY}` (or `${ANTHROPIC_AUTH_TOKEN}`) without a default, that exact name is required — connectome-host errors at startup on a missing `${VAR}` — so the other credential can't stand in for it. Default-valued references remain optional in Codex-only trees. Cook does not configure Codex authentication.

Host installs: [operator-selected engine preflight](docs/host-engines.md),
[static systemd user-unit export](docs/host-user-unit.md) and
[opt-in split layout and manual handoff](docs/host-layout.md).

## What gets generated

```
<outDir>/                    # cook build (docker backend)
├── Dockerfile               # multi-stage; one builder per source (MCP + extensions) + ch-deps + runtime
├── docker-compose.yml       # single service; bind mounts from workspace mounts
├── .env.example             # template for the Anthropic credential + recipe ${VAR}s
├── .env                     # only when prompts/env-file/process.env supplied values
├── README.md                # operator instructions, data-driven from the recipe
├── connectome.lock          # record of the materialization (components, requirements, launch)
├── extensions/              # local extension bundles (when declared)
└── recipes/
    └── <each-walked-recipe>.json    # lowered configurations (overlays applied, source → sourceMeta)

<installDir>/                # cook install (host backend)
├── app/                     # connectome-host checkout (bun install'd; extensions under app/extensions/)
├── <repo-basename>/         # MCP source checkouts (mirrors the container layout)
├── recipes/                 # lowered configurations with host-absolute paths
├── .env                     # shell-sourceable operator values (mode 0600)
├── run.sh                   # launcher: source .env, cd app, exec bun
└── connectome.lock
```

The build context for `docker build` is `<outDir>` itself — operators don't need to clone connectome-cook to build the resulting image.

## Repo layout

```
connectome-cook/
├── bin/
│   └── cook                     # the CLI shim (defers to src/cli.ts)
├── src/
│   ├── cli.ts                   # subcommand dispatch + flag parsing
│   ├── walker.ts                # load + traverse fleet children
│   ├── source-detector.ts       # collect + dedupe McpSource list
│   ├── env-collector.ts         # scan recipes for ${VAR} references
│   ├── prompts.ts               # interactive collection of missing values
│   ├── init.ts                  # cook init templates
│   ├── slug.ts                  # shared slugify helper
│   ├── runtimes/                # per-install-pattern Dockerfile fragments
│   │   └── {npm,pip,custom,index}.ts
│   ├── generators/              # one file per output artifact
│   │   └── {dockerfile,compose,overlay,env,readme}.ts
│   └── vendor/
│       └── recipe.ts            # vendored from connectome-host (re-sync periodically)
├── examples/
│   └── triumvirate/             # canonical hand-curated reference + cook test target
├── docs/
│   ├── DESIGN-NOTES.md          # lessons from building the hand-curated examples
│   └── BUILD-PLAN.md            # phased implementation plan
└── test/
    └── e2e.test.ts              # cook build → verify artifacts round-trip
```

## Why a separate repo

- **connectome-host** is the framework — code, modules, recipe loader. Stays focused on the runtime.
- **Recipe repos** declare what to run, not how to deploy it.
- **connectome-cook** is the bridge: takes any recipe, emits a deployable artifact bundle. Versioned and released independently.

## Future home

For now this lives in @Tengro's namespace. Once the CLI is meaningfully battle-tested against richer recipe trees (multi-source, BuildKit secrets, mixed install patterns), it'll be handed off to anima-research alongside connectome-host.

Host installs: [hash-pinned local dependency inputs](docs/host-dependency.md).
With `--host-dependency`, nested npm overrides (even unrelated ones) refuse
before install writes; disjoint flat overrides and resolutions remain supported.

## License

Apache 2.0. See [LICENSE](./LICENSE).
