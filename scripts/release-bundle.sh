#!/usr/bin/env bash
# Builds the Compose bundle of a release and checks its notes (#119):
#   scripts/release-bundle.sh 0.3.0 [OUT_DIR]   (OUT_DIR defaults to dist)
# Writes OUT_DIR/agentic-marketing-compose-<version>.tar.gz with docker-compose.yml, .env.example,
# compose.override.example.yaml, UPGRADING.md and CHANGELOG.md (every release's upgrade block, for
# upgrades that skip releases) in one directory, so a self-hoster installs and
# upgrades from the release page alone. The release workflow runs it; so can anyone, to check a
# release before tagging it.
set -euo pipefail
cd "$(dirname "$0")/.."
v="${1:?usage: scripts/release-bundle.sh <version> [out-dir]}"
out="${2:-dist}"
fail() { echo "release-bundle: $*" >&2; exit 1; }

# The files pin the release they ship with, so a fresh install never pulls another version.
grep -Eq "agentic-marketing:\\\$\{AM_VERSION:-$v\}" docker-compose.yml || fail "docker-compose.yml does not default AM_VERSION to $v"
grep -qx "AM_VERSION=$v" .env.example || fail ".env.example does not set AM_VERSION=$v"
for f in compose.override.example.yaml UPGRADING.md; do [ -f "$f" ] || fail "$f is missing"; done

# Every release note has the upgrade block in the same shape (see UPGRADING.md).
section=$(awk -v v="$v" '$0 ~ "^## \\[" v "\\]" {on=1; next} /^## \[/ {on=0} on' CHANGELOG.md)
[ -n "$section" ] || fail "CHANGELOG.md has no section for $v"
upgrade=$(printf '%s\n' "$section" | awk '/^### Upgrading from / {on=1} /^### / && !/^### Upgrading from / {on=0} on')
[ -n "$upgrade" ] || fail "the $v section of CHANGELOG.md has no '### Upgrading from …' block"
for label in Migrations Configuration 'Breaking changes' 'Manual steps' Upgrade; do
  printf '%s\n' "$upgrade" | grep -q "^- \*\*$label:\*\*" || fail "the upgrade block of $v has no '- **$label:**' line"
done

name="agentic-marketing-compose-$v"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$name" "$out"
cp docker-compose.yml .env.example compose.override.example.yaml UPGRADING.md CHANGELOG.md "$stage/$name/"
# Reproducible archive: fixed order, owner and times.
tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner --mtime='1970-01-01 00:00Z' -cf - "$name" | gzip -n >"$out/$name.tar.gz"
echo "$out/$name.tar.gz"
