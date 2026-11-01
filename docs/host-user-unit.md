# Exporting a systemd user unit

Add --user-unit example.service to a legacy install with both --bun-path and
--node-path (see [engine preflight](host-engines.md)). Cook writes the unit
inside the installation, not in systemd's search path. The lock records its
absolute location. Unit names cannot contain paths or template specifiers.

The unit invokes /bin/bash with the absolute run.sh and --headless. run.sh uses
the validated absolute Bun and lowered stdio engine paths. WorkingDirectory is
the installation root. Restart is on-failure with a five-second delay; UMask is
0077; both output streams go to the journal. Only static export is performed:
no enable, start, reload, account creation or linger configuration occurs.

After reviewing the generated files, the operator may manually copy the unit
to their user-unit directory and manage it themselves. Keep the installation
at its recorded absolute path and arrange a user session/linger policy as
needed. Journal output may contain application output: consumers must not log
credentials. Export is not readiness, a handshake proof, or a held activation
path. Held preparation rejects this option; its launcher continues to exit 4.
