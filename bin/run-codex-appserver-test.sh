#!/bin/bash
# Regression check for the shared Codex app-server's inherited open-file limit.
set -euo pipefail

# The launcher execs this same file as its fake Codex binary. Reporting from the
# replacement process proves the resource limit survives the real exec boundary.
if [ "${1:-}" = "app-server" ]; then
  printf 'fake-codex-soft-limit=%s\n' "$(ulimit -Sn)"
  exit 0
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}"
TEST_DIR="$(mktemp -d "$TMP_ROOT/ait-codex-limit-test.XXXXXX")"

cleanup() {
  rmdir "$TEST_DIR" 2>/dev/null || true
}
trap cleanup EXIT

output="$({
  ulimit -Sn 256
  AIT_CODEX_SHARED_SOCKET="$TEST_DIR/codex.sock" \
    CODEX_BIN="$REPO/bin/run-codex-appserver-test.sh" \
    NODE_BIN=/usr/bin/true \
    "$REPO/bin/run-codex-appserver.sh"
})"

actual="$(printf '%s\n' "$output" | sed -n 's/^fake-codex-soft-limit=//p')"
if [ "$actual" != "8192" ]; then
  echo "run-codex-appserver-test: expected soft limit 8192, got ${actual:-no result}" >&2
  exit 1
fi

# A host that cannot supply the promised capacity must fail before Codex starts.
low_hard_status=0
low_hard_output="$(
  {
    ulimit -Sn 512
    ulimit -Hn 512
    AIT_CODEX_SHARED_SOCKET="$TEST_DIR/low-hard-codex.sock" \
      CODEX_BIN="$REPO/bin/run-codex-appserver-test.sh" \
      NODE_BIN=/usr/bin/true \
      "$REPO/bin/run-codex-appserver.sh"
  } 2>&1
)" || low_hard_status=$?

if [ "$low_hard_status" -eq 0 ] || printf '%s\n' "$low_hard_output" | grep -q '^fake-codex-soft-limit='; then
  echo "run-codex-appserver-test: launcher reached Codex below the required hard limit" >&2
  exit 1
fi

echo "run-codex-appserver-test: passed (soft limit $actual; low hard limit rejected)"
