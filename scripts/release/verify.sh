#!/usr/bin/env bash
# Verify a published release (#521): the checksum file, the build attestations for every asset and
# the image, and the image's two platforms. Prints PASS/FAIL per check and exits non-zero on any
# failure.
#
#   scripts/release/verify.sh <version>
#
# The repository comes from GITHUB_REPOSITORY or `gh repo view`.
set -uo pipefail

usage() {
  echo "usage: scripts/release/verify.sh <version>" >&2
  exit 2
}

version="${1:-}"
[ -n "$version" ] || usage
version="${version#v}"
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || {
  echo "verify: $version is not a version (x.y.z)" >&2
  exit 2
}

repo="${GITHUB_REPOSITORY:-}"
if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)" || {
    echo "verify: cannot find the repository; set GITHUB_REPOSITORY" >&2
    exit 2
  }
fi
owner="${repo%%/*}"
owner="${owner,,}"
image="ghcr.io/${owner}/agentic-marketing:${version}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
run() {
  local name="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    pass "$name"
  else
    fail "$name"
    printf '%s\n' "$output" | sed 's/^/      /'
  fi
}

echo "verify: ${repo} v${version}"

run "download the GitHub release" gh release download "v${version}" --repo "$repo" --dir "$tmp"
if [ -f "$tmp/SHA256SUMS" ]; then
  run "sha256sum -c SHA256SUMS" bash -c 'cd "$1" && sha256sum -c SHA256SUMS' _ "$tmp"
else
  fail "SHA256SUMS is missing from the release"
fi

assets=()
while IFS= read -r file; do assets+=("$file"); done < <(find "$tmp" -maxdepth 1 -type f -printf '%f\n' | sort)
if [ "${#assets[@]}" -eq 0 ]; then
  fail "the release has no assets to attest"
else
  for asset in "${assets[@]}"; do
    run "attestation ${asset}" gh attestation verify "$tmp/${asset}" --repo "$repo"
  done
fi

run "attestation ${image}" gh attestation verify "oci://${image}" --repo "$repo"

manifest=""
if manifest="$(docker manifest inspect "$image" 2>&1)"; then
  for arch in amd64 arm64; do
    if printf '%s' "$manifest" | grep -Eq "\"architecture\"[[:space:]]*:[[:space:]]*\"${arch}\"" &&
      printf '%s' "$manifest" | grep -Eq '"os"[[:space:]]*:[[:space:]]*"linux"'; then
      pass "manifest linux/${arch}"
    else
      fail "manifest linux/${arch}"
    fi
  done
elif manifest="$(docker buildx imagetools inspect "$image" 2>&1)"; then
  for arch in amd64 arm64; do
    if printf '%s' "$manifest" | grep -Eq "Platform:[[:space:]]*linux/${arch}"; then
      pass "manifest linux/${arch}"
    else
      fail "manifest linux/${arch}"
    fi
  done
else
  fail "image manifest for ${image}"
  printf '%s\n' "$manifest" | sed 's/^/      /'
fi

if [ "$failures" -ne 0 ]; then
  echo "verify: ${failures} check(s) failed for v${version}"
  exit 1
fi
echo "verify: all checks passed for v${version}"
