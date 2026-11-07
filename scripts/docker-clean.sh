#!/usr/bin/env bash
# Remove only resources labelled am-test=1: containers, volumes and networks from the shared test
# stack. Dry run by default; pass --yes to act.
#
#   scripts/docker-clean.sh            show what would be removed and how much it holds
#   scripts/docker-clean.sh --yes      remove it and report the space reclaimed
#
# Nothing is selected by name or by project prefix: an unlabelled container (amtest-*, another
# checkout's am-patch-test-*, a release install) is never touched.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  --yes | -y) ACT=1 ;;
  "" | --dry-run) ACT=0 ;;
  -h | --help | help)
    usage
    exit 0
    ;;
  *)
    echo "error: unknown argument '$1'" >&2
    usage >&2
    exit 2
    ;;
esac

mapfile -t containers < <(docker ps -aq --filter label=am-test=1 2>/dev/null || true)
mapfile -t container_names < <(docker ps -a --filter label=am-test=1 --format '{{.Names}}' 2>/dev/null || true)
mapfile -t volumes < <(docker volume ls -q --filter label=am-test=1 2>/dev/null || true)
mapfile -t networks < <(docker network ls -q --filter label=am-test=1 2>/dev/null || true)

# Sizes as Docker reports them, for the labelled volumes only. `docker system df -v` can be slow
# on a host with many volumes, so it is bounded and falls back to `du` in a throwaway container.
volume_bytes() {
  local names df_output total=0
  names=$(printf '%s\n' "$@" 2>/dev/null || true)
  df_output=$(timeout "${AM_TEST_DF_TIMEOUT:-20}" docker system df -v --format '{{json .Volumes}}' 2>/dev/null || true)
  if [ -n "$df_output" ]; then
    printf '%s' "$df_output" | NAMES="$names" node -e '
      const parse = (s) => {
        const m = String(s || "").match(/([\d.]+)\s*(B|kB|KB|MB|GB|TB)/i);
        if (!m) return 0;
        const units = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
        return Number(m[1]) * (units[m[2].toLowerCase()] || 1);
      };
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk)).on("end", () => {
        let all = [];
        try { all = JSON.parse(raw); } catch {}
        const names = new Set(String(process.env.NAMES || "").split("\n").filter(Boolean));
        let total = 0;
        for (const volume of all) if (names.has(volume.Name)) total += parse(volume.Size);
        console.log(Math.round(total));
      });
    '
    return
  fi
  for name in "$@"; do
    local kb
    kb=$(timeout 20 docker run --rm -v "$name":/v:ro --entrypoint du postgres:16-alpine -sk /v 2>/dev/null | awk 'NR == 1 { print $1 }')
    [ -n "$kb" ] && total=$((total + kb))
  done
  echo $((total * 1024))
}

human() {
  awk -v b="${1:-0}" 'BEGIN {
    if (b >= 1e12) printf "%.2f TB", b / 1e12;
    else if (b >= 1e9) printf "%.2f GB", b / 1e9;
    else if (b >= 1e6) printf "%.1f MB", b / 1e6;
    else if (b >= 1e3) printf "%.1f kB", b / 1e3;
    else printf "%d B", b;
  }'
}

bytes=0
if [ "${#volumes[@]}" -gt 0 ]; then
  bytes=$(volume_bytes "${volumes[@]}")
fi

unlabelled=$(docker ps -aq 2>/dev/null | wc -l)
unlabelled=$((unlabelled - ${#containers[@]}))

echo "am-test stack resources:"
echo "  containers: ${#containers[@]}"
echo "  volumes:    ${#volumes[@]} ($(human "$bytes"))"
echo "  networks:   ${#networks[@]}"
if [ "${#container_names[@]}" -gt 0 ]; then
  printf '  %s\n' "${container_names[@]}" | sed 's/^/    /'
fi
echo "Unlabelled containers left untouched: $unlabelled"
echo

if [ "$ACT" -ne 1 ]; then
  echo "Dry run: nothing changed. Re-run with --yes to remove these am-test resources."
  exit 0
fi

for id in "${containers[@]}"; do
  docker rm -f "$id" >/dev/null
done
removed_volumes=0
for name in "${volumes[@]}"; do
  if docker volume rm "$name" >/dev/null 2>&1; then
    removed_volumes=$((removed_volumes + 1))
  else
    echo "warning: could not remove volume $name (still in use?)" >&2
  fi
done
removed_networks=0
for id in "${networks[@]}"; do
  if docker network rm "$id" >/dev/null 2>&1; then
    removed_networks=$((removed_networks + 1))
  else
    echo "warning: could not remove network $id (still in use?)" >&2
  fi
done

echo "Removed ${#containers[@]} container(s), $removed_volumes volume(s), $removed_networks network(s)."
echo "Space reclaimed from volumes: $(human "$bytes") (measured before removal)."

remaining=$(docker ps -aq --filter label=am-test=1 2>/dev/null | wc -l)
remaining_volumes=$(docker volume ls -q --filter label=am-test=1 2>/dev/null | wc -l)
remaining_networks=$(docker network ls -q --filter label=am-test=1 2>/dev/null | wc -l)
if [ "$remaining" -ne 0 ] || [ "$remaining_volumes" -ne 0 ] || [ "$remaining_networks" -ne 0 ]; then
  echo "warning: ${remaining} container(s), ${remaining_volumes} volume(s) and ${remaining_networks} network(s) labelled am-test=1 remain." >&2
  exit 1
fi
echo "Only am-test-labelled resources were removed; no unlabelled container was touched."
