#!/usr/bin/env bash
# Runs setup.mjs in clean Docker containers, the way a participant would on a fresh machine.
#
#   test/sandbox.sh            Node 22 and 24, plus Node 18 and 20 (must be rejected)
#   test/sandbox.sh 22         one Node version only
#
# Each container gets a copy of the repo (the host checkout is mounted read-only),
# runs the unit and integration tests, then a real end-to-end setup: downloading and
# starting the DeepSeek harness, installing the ladder scorer, and the OpenRouter checks.
# Needs Docker and internet access.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -gt 0 ]; then VERSIONS=("$@"); else VERSIONS=(22 24); fi
FAILED=()

in_container() {
  local image="$1" script="$2"
  docker run --rm -v "$REPO:/repo:ro" "$image" bash -euo pipefail -c "
    cp -r /repo /work && rm -rf /work/bench/task-board/node_modules && cd /work
    $script"
}

for v in "${VERSIONS[@]}"; do
  echo "=== Node $v ==="
  if in_container "node:$v-bookworm" '
    node --version
    node --test --test-reporter=tap test/setup.test.mjs > /tmp/unit.log 2>&1 || { cat /tmp/unit.log; exit 1; }
    grep -E "^# (tests|pass|fail)" /tmp/unit.log

    # A participant with no Git identity yet: it is flagged, and setup still finishes.
    node setup.mjs --yes --no-color --skip-harness --skip-bench > /tmp/no-id.log || true
    grep -q "Git identity — user.name or user.email not set" /tmp/no-id.log

    # The real run.
    git config --global user.name "Sandbox Participant"
    git config --global user.email "participant@example.com"
    set +e
    node setup.mjs --yes --no-color > /tmp/setup.log 2>&1
    code=$?
    set -e
    cat /tmp/setup.log
    test "$code" -eq 0
    grep -q "✔ DeepSeek harness web UI — started on 127.0.0.1:3080" /tmp/setup.log
    grep -q "✔ DeepSeek models on OpenRouter" /tmp/setup.log
    grep -q "✔ Model ladder scorer — installed" /tmp/setup.log
    grep -q "! Claude Code — not installed" /tmp/setup.log
    # The harness was stopped again.
    sleep 2
    if (exec 3<>/dev/tcp/127.0.0.1/3080) 2>/dev/null; then echo "harness still running"; exit 1; fi
    # A second run is safe, and does not reinstall the scorer.
    node setup.mjs --yes --no-color --skip-harness > /tmp/again.log
    grep -q "✔ Model ladder scorer — installed" /tmp/again.log
    echo "SANDBOX OK"
  '; then echo "Node $v: passed"; else FAILED+=("$v"); echo "Node $v: FAILED"; fi
done

if [ "$#" -eq 0 ]; then
  for old in 18 20; do
    echo "=== Node $old (must be rejected) ==="
    if in_container "node:$old-bookworm" "
      set +e; node setup.mjs --check --no-color --skip-harness --skip-bench > /tmp/old.log 2>&1; code=\$?; set -e
      cat /tmp/old.log
      test \"\$code\" -eq 1
      grep -q '✖ Node.js — v$old' /tmp/old.log
    "; then echo "Node $old: rejected as expected"; else FAILED+=("$old"); echo "Node $old: FAILED"; fi
  done
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "Sandbox failures on Node: ${FAILED[*]}"
  exit 1
fi
echo "All sandbox runs passed."
