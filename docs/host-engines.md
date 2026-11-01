# Selected host engines

Legacy host installs can opt into engine preflight:

    cook install recipe.json --out /srv/example/install --no-prompts --yes \
      --bun-path /opt/bun/bin/bun --node-path /opt/node/bin/node \
      --ch-ref FULL_HOST_COMMIT

Both paths must be absolute executable files. Cook temporarily fetches the
selected host source, reads its package.json engines.bun and engines.node, and
checks each executable's --version against those semver ranges. Missing or
invalid requirements, inaccessible source/binaries, and mismatches refuse
before creating or changing the installation. The fetch does not run builds.
A moving host ref is bound to the inspected commit for materialization.

connectome.lock records canonical absolute paths and observed versions. Host
dependency installation and run.sh use the selected absolute Bun; lowered
stdio commands named exactly node or bun use the selected absolute engine.
Build PATH puts those engine directories first. Arbitrary custom commands,
npx, scripts' shebangs, and connector-specific runtime requirements are not
rewritten or independently qualified. No engines are downloaded.

Omitting both flags preserves the legacy PATH-based behavior. Changing the
selected engines invalidates clone/build reuse. This is not a frozen dependency
closure or protection against replacing a binary after installation. Hold
preparation does not accept these legacy options; held launchers still refuse.
