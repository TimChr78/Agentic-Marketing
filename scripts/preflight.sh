#!/usr/bin/env bash
# Preflight for the shared am-test stack. Prints PASS/FAIL per check and exits non-zero when
# anything fails. Run it before `scripts/test-services.sh up` or a long test run.
#
#   scripts/preflight.sh
#
# Threshold and ports follow the same environment/.env.test as the stack:
#   AM_TEST_MIN_FREE_GB=10 (default), AM_TEST_PG_PORT, AM_TEST_CH_PORT, ...
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

ENV_FILE=${AM_TEST_ENV_FILE:-$ROOT/.env.test}
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

FAILED=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAILED=1
}
note() { printf '      %s\n' "$*"; }

MIN_FREE_GB=${AM_TEST_MIN_FREE_GB:-10}
PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble
IMAGES=(
  postgres:16-alpine
  clickhouse/clickhouse-server:26.8
  valkey/valkey:8.1.9
  nats:2.15.0-alpine
  openbao/openbao:2.6.4
  "$PLAYWRIGHT_IMAGE"
)

# --- toolchain -------------------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  pass "node is present ($(node --version))"
else
  fail "node is not on PATH (needs Node 22+)"
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    pass "docker is present and the daemon answers"
  else
    fail "docker is installed but the daemon does not answer"
  fi
else
  fail "docker is not on PATH"
fi

if command -v pnpm >/dev/null 2>&1 && pnpm --version >/dev/null 2>&1; then
  pass "pnpm is on PATH ($(pnpm --version))"
elif corepack pnpm --version >/dev/null 2>&1; then
  fail "pnpm is not on PATH, though corepack can run it ($(corepack pnpm --version))"
  note 'create the shim: corepack enable --install-directory "$HOME/.local/bin" pnpm'
  note 'then: export PATH="$HOME/.local/bin:$PATH"'
else
  fail "pnpm is missing and 'corepack pnpm' does not work either"
  note 'install Node 22+ (which ships corepack), then run: corepack enable'
fi

# --- disk headroom ---------------------------------------------------------------------------
check_avail() {
  local label=$1 path=$2 avail_kb=$3 avail_gb
  if [ -z "$avail_kb" ]; then
    fail "$label: cannot read free space for $path"
    return
  fi
  avail_gb=$(awk -v k="$avail_kb" 'BEGIN { printf "%.1f", k / 1024 / 1024 }')
  if awk -v k="$avail_kb" -v min="$MIN_FREE_GB" 'BEGIN { exit !(k / 1024 / 1024 >= min) }'; then
    pass "$label: ${avail_gb} GB free on $path (threshold ${MIN_FREE_GB} GB)"
  else
    fail "$label: ${avail_gb} GB free on $path, below the ${MIN_FREE_GB} GB threshold"
    note "free space or raise AM_TEST_MIN_FREE_GB only if this is deliberate"
  fi
}

check_disk() {
  local label=$1 path=$2 avail_kb
  if [ ! -d "$path" ]; then
    fail "$label: $path does not exist"
    return
  fi
  avail_kb=$(df -Pk "$path" 2>/dev/null | awk 'NR == 2 { print $4 }')
  check_avail "$label" "$path" "$avail_kb"
}

check_disk "repo filesystem" "$ROOT"

docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
if [ -n "$docker_root" ] && [ -d "$docker_root" ]; then
  check_disk "docker data root" "$docker_root"
elif [ -n "$docker_root" ] && docker image inspect "$PLAYWRIGHT_IMAGE" >/dev/null 2>&1; then
  # Running inside a container: the daemon's data root is on the host, not in this filesystem.
  avail_kb=$(docker run --rm -v "$docker_root":/check:ro --entrypoint df "$PLAYWRIGHT_IMAGE" -Pk /check 2>/dev/null | awk 'NR == 2 { print $4 }')
  check_avail "docker data root" "$docker_root" "$avail_kb"
else
  fail "docker data root: cannot read it (is the daemon running?)"
fi

# --- pinned images ---------------------------------------------------------------------------
for image in "${IMAGES[@]}"; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    pass "image present: $image"
  else
    fail "image missing: $image"
    note "pull it with: docker pull $image"
  fi
done

# --- ports -----------------------------------------------------------------------------------
PG_PORT=${AM_TEST_PG_PORT:-25432}
CH_PORT=${AM_TEST_CH_PORT:-28123}
VALKEY_PORT=${AM_TEST_VALKEY_PORT:-26379}
NATS_PORT=${AM_TEST_NATS_PORT:-24222}
OPENBAO_PORT=${AM_TEST_OPENBAO_PORT:-28200}
PORTS="$PG_PORT,$CH_PORT,$VALKEY_PORT,$NATS_PORT,$OPENBAO_PORT"

# Probe from a host-network container, because this script may itself run inside a container
# whose own namespace cannot see the ports the tests will use on the host.
PROBE='
const net = require("node:net");
const ports = String(process.argv[1] || "").split(",").filter(Boolean).map(Number);
(async () => {
  for (const port of ports) {
    const server = net.createServer();
    const free = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "0.0.0.0", () => server.close(() => resolve(true)));
    });
    console.log(`${port} ${free ? "free" : "busy"}`);
  }
})();
'
probe_output=""
if docker image inspect "$PLAYWRIGHT_IMAGE" >/dev/null 2>&1; then
  probe_output=$(docker run --rm --network host --entrypoint node "$PLAYWRIGHT_IMAGE" -e "$PROBE" "$PORTS" 2>/dev/null || true)
fi

if [ -z "$probe_output" ]; then
  note "could not probe host ports from a container; checking Docker publishers only"
  for port in ${PORTS//,/ }; do
    owners=$(docker ps --filter "publish=$port" --format '{{.Names}}	{{.Label "am-test"}}' 2>/dev/null || true)
    if [ -z "$owners" ]; then
      pass "port $port is not published by Docker"
    elif printf '%s\n' "$owners" | grep -qv $'\t1$'; then
      fail "port $port is held by a container outside the am-test stack:"
      printf '%s\n' "$owners" | sed 's/^/      /'
    else
      pass "port $port is held by the am-test stack"
    fi
  done
else
  while read -r port state; do
    [ -n "$port" ] || continue
    if [ "$state" = free ]; then
      pass "port $port is free"
      continue
    fi
    owners=$(docker ps --filter "publish=$port" --format '{{.Names}}	{{.Label "am-test"}}' 2>/dev/null || true)
    if [ -z "$owners" ]; then
      fail "port $port is in use by a non-Docker process on the host"
    elif printf '%s\n' "$owners" | grep -qv $'\t1$'; then
      fail "port $port is held by a container outside the am-test stack:"
      printf '%s\n' "$owners" | sed 's/^/      /'
    else
      pass "port $port is held by the am-test stack"
    fi
  done <<<"$probe_output"
fi

# --- test environment ------------------------------------------------------------------------
if docker ps -q --filter label=am-test=1 --filter status=running 2>/dev/null | grep -q .; then
  for var in TEST_DATABASE_URL CLICKHOUSE_URL VALKEY_URL NATS_URL OPENBAO_TEST_ADDR OPENBAO_TEST_TOKEN; do
    if [ -n "${!var:-}" ]; then
      pass "$var is set"
    else
      fail "$var is not set while the stack is up"
      note 'run: eval "$(scripts/test-services.sh env)"'
    fi
  done
else
  pass "test stack is down, so TEST_* variables are not required"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "Preflight failed. Fix the FAIL lines above."
  exit 1
fi
echo "Preflight passed."
