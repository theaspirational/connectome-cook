# Exporting a systemd user unit

Add `--user-unit example.service` to an install with both `--bun-path` and
`--node-path` (see [engine preflight](host-engines.md)). Cook writes the unit
inside the installation, not in systemd's search path. The lock records its
absolute location as an operator hint; `cook run` still uses `run.sh`, not
systemd. Names must be plain non-template `.service` names, at most 255 bytes,
without paths or control characters. Invalid names or missing engine options
refuse before recipe resolution or prompts.

The unit invokes /bin/bash with the absolute run.sh and --headless. Literal
node/bun stdio commands use the validated absolute engine paths. With selected
engines, run.sh also prepends the cook-owned `.cook-engines/bin` to its runtime
PATH, so commands using `#!/usr/bin/env node` or bun find the selected engines,
unless the server declares its own `PATH`.
It does not import the engines' sibling executables: custom commands such as
npx must themselves be installed and available on the user manager's inherited
PATH (or use an absolute command path). Those tools are not independently
validated, and explicit absolute shebangs/engine paths are not rewritten.

WorkingDirectory is the installation root, emitted as a bare path with only
systemd's percent specifiers escaped. Unit export refuses paths containing
a colon (the engine PATH separator), ASCII control characters, or ending in
whitespace or a literal backslash (which can
continue the line onto ExecStart); explicit `--out` paths are checked before
recipe resolution, prompts or install writes. Quotes are not added.
Restart is on-failure with a five-second delay, bounded by
`StartLimitIntervalSec=300` and `StartLimitBurst=5` in [Unit]; UMask is 0077.
After fixing a repeated startup failure, run
`systemctl --user reset-failed example.service` before starting it again.
User units cannot order against system network targets or prove network
readiness; startup network failures are covered by the bounded restart policy.
Output streams are connected to the journal, but connectome-host's --headless
mode redirects its own stdout/stderr to `$DATA_DIR/headless.log`, so journalctl
may show little application output. Neither destination should contain secrets.

Only static export is performed: no enable, start, reload, account creation or
linger configuration occurs. After reviewing the generated files, the operator
may manually copy the unit to their user-unit directory and manage it themselves.
Keep the installation at its recorded absolute path and arrange a user
session/linger policy as needed. Export is not readiness or a handshake proof.

For operator-managed environment files, attach a systemd drop-in rather than a
new cook flag. For example, in `example.service.d/environment.conf` beside the
operator's installed unit:

```ini
[Service]
EnvironmentFile=/absolute/operator-managed/host.env
```

This is systemd environment-file syntax, not cook's `--env-file` or a shell
script. Cook does not read, copy, or manage that file. It must be readable by
the user manager; a root-only file cannot be read by an ordinary user manager.

run.sh sources the installation's `.env` after systemd supplies the environment,
so **`.env` values take precedence over the drop-in's EnvironmentFile**. A key
intended to live only in the drop-in must be absent from `.env`: unset it when
installing (and do not supply it through cook's --env-file or prompts), or remove
it from `.env` afterwards. A reinstall writes the key back if it is present in
the installing shell's environment again.

A user unit is not a credential isolation boundary from an agent running under
the same UID. Do not assume this drop-in hides credentials from the agent.

Re-export restores the named unit's mode to 0600. A differently named earlier
export is deliberately retained: cook never removes units or changes installed
copies. Operators must review/remove obsolete exports and installed copies;
the lock's `launch.userUnit` hint records only the latest named export.
A reinstall that omits --user-unit or the engine flags warns before confirmation:
installed copies still launch the same run.sh, and removing selected engines can
make them fail or use unvalidated PATH engines. Review or disable those copies.
While engines remain selected, the existing hint is retained even without a new
export; leaving selected engines drops the hint after the warning.
