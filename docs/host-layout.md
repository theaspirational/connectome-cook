# Opt-in split host layout

A standalone legacy installation can use --layout layout.json with selected
absolute engines. The runtime root must equal --out; all five roots must be
absolute, distinct and non-overlapping. Example (nonsecret declarations only):

    {
      "schema": "connectome.host-layout/v1",
      "runtime": "/srv/example/runtime",
      "config": "/srv/example/config",
      "state": "/srv/example/state",
      "workspace": "/srv/example/workspace",
      "credentials": "/srv/example/credentials",
      "connectorState": {
        "heartbeat": {
          "HEARTBEAT_CONFIG_FILE": "settings.json",
          "HEARTBEAT_REMINDERS_FILE": "reminders.json"
        }
      }
    }

Code, run.sh, the optional exported unit and connectome.lock live under runtime.
Lowered recipes and .env live under config. The launcher sets DATA_DIR to state,
WORKSPACE_DIR to workspace, and runs with workspace as CWD and umask 077.
The optional unit also declares workspace as WorkingDirectory.

Each connectorState entry names an existing stdio consumer (by name throughout
the recipe tree). Its environment mapping is lowered to absolute paths under
state/connectors/NAME/. File parents are provisioned privately; file contents
are not created or copied. Unknown/WebSocket consumers, traversal, unsafe
roots and layout-owned DATA_DIR/WORKSPACE_DIR value overrides refuse.
Other connector-specific paths are not guessed or automatically rebased: declare
each state-file env binding explicitly and audit remaining paths.

Linux provisioning creates 0700 roots and state-file parent directories owned
by the effective user. Existing roots with other ownership/modes, symlink
ancestors and non-directories refuse; Cook never chmods/chowns existing roots.
Generated configuration/control files are private, with a 0700 launcher.
Code inside the private runtime root retains upstream build modes.

This first opt-in supports standalone hosts: sidecars, container template files
and legacy recipe credentialFiles refuse rather than leaving mutable files in
the code tree. Use the default layout for those shapes. Credentials has its own
dedicated root; placing values or consumer adoption is a separate operation.
Held candidates reject split layout and retain their disposable data semantics.
Changing or removing a recorded layout on reconcile refuses. Use fresh roots
for a different layout. There is no importer or in-place adoption.

## Stopped-install manual handoff checklist

1. Stop every writer to the old host, workspace, connector state and credentials;
   verify they remain stopped. Do not use a held candidate as an adoption target.
2. Inventory history, model/identity settings, overlays, writable connector
   settings/reminders, workspace files and external credential files. Record
   owners, modes and old absolute/relative paths. Back up independently.
3. Materialize a fresh installation into new, non-overlapping roots. Inspect
   lowered paths and the exported unit without starting it. Keep the same model
   and identity deliberately; Cook does not infer compatibility.
4. With both installations stopped, manually copy the inventoried data to its
   declared destination. Preserve intended ownership and private modes. Do not
   copy candidate metadata, stale launchers, locks or code over the new runtime.
   Do not treat an empty-state build as evidence of migrated-store compatibility.
5. Audit absolute connector-state bindings, workspace paths and credential
   consumers. Verify application-specific formats and backups independently.
6. Only after operator review, arrange service management and validate the new
   installation separately. Retain a stopped rollback copy; never let both
   installations write the same state. Cook neither starts services nor
   certifies history migration, credential adoption or recovery.
