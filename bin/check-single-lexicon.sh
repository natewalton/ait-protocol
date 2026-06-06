#!/bin/bash
# ADR-0039: each package must resolve @atproto/lexicon to a single version.
# A second copy means the @atproto/* deps straddled two release generations
# again — the bug class fixed in specs/appview-single-lexicon-copy.md, where
# duplicate copies make `instanceof BlobRef` unreliable across the firehose
# boundary. Run after any @atproto/* dependency change. The repo has no CI
# (ADR-0002, local-only), so this is a manual gate; wire it in if CI is added.
#
# Exit 0 = invariant holds (≤1 lexicon version per package). Exit 1 = straddle.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
status=0

for pkg in appview mcp; do
  dir="$REPO/$pkg/node_modules"
  if [ ! -d "$dir" ]; then
    echo "  $pkg: no node_modules — run 'npm install' in $pkg/ first (skipped)"
    continue
  fi
  versions="$(
    find -L "$dir" -path '*@atproto/lexicon/package.json' 2>/dev/null |
      while IFS= read -r p; do
        node -e 'console.log(require(process.argv[1]).version)' "$p" 2>/dev/null
      done | sort -u
  )"
  n="$(printf '%s' "$versions" | grep -c . || true)"
  if [ "$n" -le 1 ]; then
    echo "  $pkg: @atproto/lexicon -> ${versions:-none} (ok)"
  else
    echo "  $pkg: FAIL -- $n @atproto/lexicon versions installed:"
    printf '%s\n' "$versions" | sed 's/^/        /'
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo ""
  echo "Straddle detected. Align that package's @atproto/* deps to one lexicon"
  echo "generation (declare only what it imports) and reinstall — ADR-0039 /"
  echo "specs/appview-single-lexicon-copy.md."
else
  echo "OK -- single @atproto/lexicon per package (ADR-0039)."
fi
exit "$status"
