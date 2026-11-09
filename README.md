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
cook build my-agent.json --out ./my-agent-cook

# Install directly onto this machine — no docker. Clones + builds every
# component under ~/.connectome/installs/<name>/, resolves host requirements
# (probe + confirm), writes run.sh + connectome.lock. The full action plan
# is printed and confirmed before anything executes on your machine.
cook install my-agent.json

# Launch. Finds an existing materialization (lock in the named dir, then
# ./<name>-cook, then ~/.connectome/installs/<name>) and launches it without
# re-resolving; falls back to build-then-compose-up. --rebuild forces a re-cook.
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
`${VAR}` references and recorded in the lock. For install steps, export the
parent value and explicitly select its name with `COOK_PASS_ENV` (see below).

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
names that are also `authSecret`; requirement values still appear in the lock.
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

`--pin-refs` (on `build` and `install`) resolves every branch/tag ref —
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
--pin-refs             Resolve branch refs to current SHAs; fail if unresolved
```

### Anthropic credentials

A recipe tree whose agents all explicitly set `agent.provider` to `openai-codex` needs no implicit Anthropic credential. Trees containing an Anthropic agent, an omitted provider (which defaults to Anthropic), or an unknown provider retain the Anthropic requirement: either `ANTHROPIC_API_KEY` (a standard API key from [console.anthropic.com](https://console.anthropic.com/)) or `ANTHROPIC_AUTH_TOKEN` (a long-lived OAuth bearer token, sent by connectome-host as `Authorization: Bearer` instead of `x-api-key`). Cook's prompts, generated `.env.example`, and missing-value checks accept either — press Enter at the `ANTHROPIC_API_KEY` prompt to be offered the auth-token alternative. If both are set, connectome-host prefers the auth token. For every provider, when a recipe explicitly substitutes `${ANTHROPIC_API_KEY}` (or `${ANTHROPIC_AUTH_TOKEN}`) without a default, that exact name is required — connectome-host errors at startup on a missing `${VAR}` — so the other credential can't stand in for it. Default-valued references remain optional in Codex-only trees. Cook does not configure Codex authentication.

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

## License

Apache 2.0. See [LICENSE](./LICENSE).
