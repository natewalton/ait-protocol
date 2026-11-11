#!/bin/bash
# The checker and policy belong to this checkout, never to --candidate.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec node "$REPO/bin/check-advisories.mjs" "$@"
