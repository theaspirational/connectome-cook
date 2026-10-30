#!/usr/bin/env bash
# Disposable Linux user-service fixture. No production units or data are used.
# Run with XDG_RUNTIME_DIR set for the test user's systemd instance.
set -euo pipefail
root=$(mktemp -d)
name="cook-candidate-fixture-$$"
cleanup() {
  systemctl --user stop "$name.service" "$name-sidecar.service" >/dev/null 2>&1 || :
  systemctl --user reset-failed "$name.service" "$name-sidecar.service" >/dev/null 2>&1 || :
  rm -rf -- "$root"
}
trap cleanup EXIT
# Exercise the actual production renderer, not a hand-copied guard.
bun -e 'import {renderLauncher} from "./src/backends/host.ts"; console.log(renderLauncher("fixture.json", {candidate:true,hasSidecars:true,envsubstFiles:[]}));' > "$root/run.sh"
chmod 700 "$root/run.sh"
printf 'touch "%s/env-ran"\n' "$root" > "$root/.env"
# A successful systemd-run submission is not service success; inspect its exit.
for n in 1 2 3; do
  systemd-run --user --no-block --unit="$name" --property=Type=oneshot --property=RemainAfterExit=yes "$root/run.sh"
  for attempt in $(seq 1 100); do
    state=$(systemctl --user show "$name.service" -p ActiveState --value)
    [ "$state" = failed ] && break
    sleep 0.02
  done
  status=$(systemctl --user show "$name.service" -p ExecMainStatus --value)
  [ "$status" = 4 ]
  [ ! -e "$root/env-ran" ]
  [ ! -e "$root/data" ]
  printf 'guarded service launch %s: exit=%s, no env/data effects\n' "$n" "$status"
  systemctl --user reset-failed "$name.service"
  # reset-failed unloads the transient failed unit before reusing the name.
  sleep 0.05
done
# Intentional negative boundary: an independent sidecar does not invoke run.sh.
systemd-run --user --wait --unit="$name-sidecar" /usr/bin/touch "$root/independent-sidecar-ran"
[ -f "$root/independent-sidecar-ran" ]
printf 'independent sidecar unit ran: intentionally outside PR01b hold guarantee\n'
