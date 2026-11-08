#!/bin/bash
# Pinned real-binary lifecycle contract. No authentication or model calls.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
[ "$(uname -s)" = Darwin ] || { echo 'native Codex contract requires macOS' >&2; exit 1; }
case "$(uname -m)" in
  arm64) arch=aarch64 ;;
  x86_64) arch=x86_64 ;;
  *) echo 'unsupported native Codex test architecture' >&2; exit 1 ;;
esac
work="$(mktemp -d "${TMPDIR:-/tmp}/ait-native-contract.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cache="${AIT_CODEX_TEST_CACHE:-$work/cache}"
mkdir -p "$cache"
for version in 0.166.0 0.167.0; do
  case "$version/$arch" in
    0.166.0/aarch64) digest=c48824462fc57681eafb0925d97b11b589010475613904f570b42fea53e240d5 ;;
    0.166.0/x86_64) digest=db0c38713c36199b12e7c8d1629386c35a4ce8f99e1c9ce72f1725a74df67b57 ;;
    0.167.0/aarch64) digest=4b22a2a971be2791c3e31f912f3e77a88ebd64a65812a7289ccba65dd6425fe9 ;;
    0.167.0/x86_64) digest=d8eb4a865a0b17319cde10347523e5bab0978d01725b39f4a639f40905e01221 ;;
  esac
  asset="codex-$arch-apple-darwin"
  archive="$cache/$version-$asset.tar.gz"
  if [ ! -f "$archive" ]; then
    curl --fail --location --retry 2 "https://github.com/openai/codex/releases/download/rust-v$version/$asset.tar.gz" -o "$work/download"
    mv "$work/download" "$archive"
  fi
  actual="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
  [ "$actual" = "$digest" ] || { echo "Codex $version archive SHA256 mismatch" >&2; exit 1; }
  fixture="$work/$version"
  mkdir -p "$fixture/bin" "$fixture/home" "$fixture/xdg"
  tar -xzf "$archive" -C "$fixture/bin" "$asset"
  ln -s "$fixture/bin/$asset" "$fixture/bin/codex"
  HOME="$fixture/home" XDG_DATA_HOME="$fixture/xdg" PATH="$fixture/bin:$PATH" \
    node "$ROOT/mcp/scripts/codex-rollout-resume-test.mjs" --endpoint-contract
done
