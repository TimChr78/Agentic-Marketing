#!/usr/bin/env bash
# Run the Playwright suite exactly as CI does: the pinned Playwright image, the repository mounted at
# its own path, and a freshly seeded server on the host (or, inside a container, in this container).
#
#   scripts/e2e-docker.sh <smoke|functional|axe|visual|update|shots> [playwright args...]
#
# What a run does:
#   1. builds the admin UI (unless E2E_SKIP_BUILD=1),
#   2. starts apps/server/test/e2e/server.ts on E2E_PORT with a fresh database name per run,
#   3. waits for /ready on E2E_PORT+1 and refuses a server that answered before it could have seeded,
#   4. runs Playwright in mcr.microsoft.com/playwright:v1.64.1-noble,
#   5. always stops the server it started (by process group) and drops the database it created.
#
# Environment:
#   E2E_PORT=3100              the seeded server's port (E2E_PORT+1 is the fixtures port)
#   E2E_DB=e2e_<timestamp>     the database name; a fresh one per run unless you set it yourself
#   E2E_KEEP_DB=1              keep that database for inspection
#   E2E_SKIP_BUILD=1           reuse the existing apps/web/dist
#   E2E_DOCKER_NETWORK=host    docker network for the runner. Default: host; when this script runs
#                              inside a container whose name matches $HOSTNAME, container:<name>,
#                              so the container shares this namespace and reaches localhost:E2E_PORT.
#   E2E_READY_TIMEOUT=240      seconds to wait for the seed
#   CHROMIUM=...               override the Chromium path resolved from the image
#
# The server reaches Postgres, ClickHouse, NATS and Valkey through TEST_DATABASE_URL, CLICKHOUSE_URL,
# NATS_URL and VALKEY_URL, which pass straight through from the environment.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${E2E_IMAGE:-mcr.microsoft.com/playwright:v1.64.1-noble}"
PORT="${E2E_PORT:-3100}"
READY_PORT=$((PORT + 1))
READY_TIMEOUT="${E2E_READY_TIMEOUT:-240}"
# A real seed takes about 30 s. Answering sooner than this is not proof, but it is the wording we
# use when the fresh database is also missing.
MIN_SEED_SECONDS="${E2E_MIN_SEED_SECONDS:-10}"
# Prefer /tmp/opencode, but it is root-owned in some containers; fall back to the usual temp dir.
TMP_ROOT="${E2E_TMPDIR:-${TMPDIR:-/tmp}}"
if [ -d /tmp/opencode ] && [ -w /tmp/opencode ]; then TMP_ROOT=/tmp/opencode; fi
mkdir -p "$TMP_ROOT"

export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

if [ $# -lt 1 ]; then
  echo "usage: $0 <smoke|functional|axe|visual|update|shots> [playwright args...]" >&2
  exit 2
fi
COMMAND="$1"
shift

case "$COMMAND" in
  smoke | functional | axe | visual | update | shots) ;;
  *)
    echo "FAIL: unknown subcommand '$COMMAND' (expected smoke, functional, axe, visual, update or shots)" >&2
    exit 2
    ;;
esac

log() { printf '%s\n' "$*"; }
die() {
  log "FAIL: $*"
  exit 1
}

# --- who holds a port ---------------------------------------------------------------------------
# No lsof/ss/fuser on the CI-style images, so read /proc: the listening socket's inode in
# /proc/net/tcp{,6}, then the process that has it open. Prints one "pid command" per holder.
port_holders() {
  PORT_TO_CHECK="$1" node -e '
    const fs = require("node:fs");
    const port = Number(process.env.PORT_TO_CHECK);
    const inodes = new Set();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      for (const line of text.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 10 || cols[3] !== "0A") continue;
        const local = cols[1];
        if (Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16) === port) inodes.add(cols[9]);
      }
    }
    if (!inodes.size) process.exit(0);
    const seen = new Set();
    for (const pid of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(pid) || seen.has(pid)) continue;
      let fds = [];
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        let target = "";
        try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (!match || !inodes.has(match[1])) continue;
        let cmd = "";
        try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch {}
        console.log(`${pid} ${cmd}`);
        seen.add(pid);
        break;
      }
    }
    if (!seen.size) console.log(`(pid unknown; listening socket inode ${[...inodes].join(", ")})`);
  '
}

# --- Postgres helpers (pg resolves from apps/server) ----------------------------------------------
db_database_exists() {
  ( cd "$REPO_ROOT/apps/server" && DBNAME="$1" TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://am:am@localhost:5432/am_test}" node -e '
    const { Client } = require("pg");
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = "/postgres";
    const client = new Client({ connectionString: url.toString() });
    (async () => {
      await client.connect();
      const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [process.env.DBNAME]);
      await client.end();
      process.exit(result.rowCount ? 0 : 1);
    })().catch((error) => { console.error(error.message); process.exit(2); });
  ' 2>/dev/null )
}

db_has_seeded_workspace() {
  ( cd "$REPO_ROOT/apps/server" && DBNAME="$1" TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://am:am@localhost:5432/am_test}" node -e '
    const { Client } = require("pg");
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = "/" + process.env.DBNAME;
    const client = new Client({ connectionString: url.toString() });
    (async () => {
      await client.connect();
      const result = await client.query("SELECT count(*)::int AS n FROM workspaces");
      await client.end();
      process.exit(result.rows[0].n > 0 ? 0 : 1);
    })().catch((error) => { console.error(error.message); process.exit(2); });
  ' 2>/dev/null )
}

db_drop() {
  local name="$1"
  if ! printf '%s' "$name" | grep -Eq '^[a-z0-9_]+$'; then
    log "WARN: refusing to drop a database with an unexpected name: $name"
    return 0
  fi
  ( cd "$REPO_ROOT/apps/server" && DBNAME="$name" TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://am:am@localhost:5432/am_test}" node -e '
    const { Client } = require("pg");
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = "/postgres";
    const client = new Client({ connectionString: url.toString() });
    (async () => {
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS "${process.env.DBNAME}" WITH (FORCE)`);
      await client.end();
    })().catch((error) => { console.error(error.message); process.exit(1); });
  ' )
}

# --- preflight -----------------------------------------------------------------------------------
for port in "$PORT" "$READY_PORT"; do
  holders="$(port_holders "$port")"
  if [ -n "$holders" ]; then
    log "FAIL: port $port is already in use; refusing to start a second seeded server."
    log "      holder(s):"
    printf '%s\n' "$holders" | sed 's/^/      /'
    exit 1
  fi
done

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
command -v node >/dev/null 2>&1 || die "node is not on PATH"
command -v pnpm >/dev/null 2>&1 || die "pnpm is not on PATH (try: corepack enable, or add ~/.local/bin)"

DB_NAME="${E2E_DB:-e2e_$(date -u +%Y%m%d_%H%M%S)_$$}"
case "$DB_NAME" in
  e2e_*) ;;
  *) log "WARN: E2E_DB=$DB_NAME does not start with e2e_; the server prefixes it with am_ anyway." ;;
esac
PG_DB="am_$DB_NAME"
SERVER_LOG="$TMP_ROOT/e2e-server-$DB_NAME.log"

# --- network -------------------------------------------------------------------------------------
NETWORK="${E2E_DOCKER_NETWORK:-}"
if [ -z "$NETWORK" ]; then
  if [ -f /.dockerenv ] && [ -n "${HOSTNAME:-}" ]; then
    SELF_CONTAINER="$(docker ps --filter "id=$HOSTNAME" --format '{{.Names}}' 2>/dev/null | head -1 || true)"
    if [ -n "$SELF_CONTAINER" ]; then
      NETWORK="container:$SELF_CONTAINER"
    else
      NETWORK="host"
    fi
  else
    NETWORK="host"
  fi
fi
log "docker network: $NETWORK"

if [ -n "${CHROMIUM:-}" ]; then
  CHROMIUM_PATH="$CHROMIUM"
else
  CHROMIUM_PATH="$(docker run --rm "$IMAGE" sh -c 'ls -d /ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1')"
fi
[ -n "$CHROMIUM_PATH" ] || die "could not resolve Chromium inside $IMAGE"
log "chromium: $CHROMIUM_PATH"

# --- server lifecycle ----------------------------------------------------------------------------
SERVER_PID=""
SERVER_PGID=""

# The image runs as root (as it does in CI). Hand the files it wrote back to the invoking user, so a
# trace or a screenshot stays editable and removable afterwards.
restore_ownership() {
  [ "$(id -u)" = "0" ] && return 0
  docker run --rm --user 0 \
    -v "$REPO_ROOT":"$REPO_ROOT" \
    -w "$REPO_ROOT" \
    -e OWNER="$(id -u):$(id -g)" \
    "$IMAGE" sh -c 'for p in test-results reports shots-p25-composer; do [ -e "$p" ] && chown -R "$OWNER" "$p"; done' \
    >/dev/null 2>&1 || true
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log "stopping the seeded server (pid $SERVER_PID, process group $SERVER_PGID)"
    kill -TERM -- "-$SERVER_PGID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 50); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL -- "-$SERVER_PGID" 2>/dev/null || kill -KILL "$SERVER_PID" 2>/dev/null
  elif [ -n "$SERVER_PID" ]; then
    log "seeded server (pid $SERVER_PID) is already gone"
  fi
  if [ "${E2E_KEEP_DB:-0}" = "1" ]; then
    log "keeping database $PG_DB (E2E_KEEP_DB=1)"
  elif [ -n "$DB_NAME" ]; then
    if db_drop "$PG_DB"; then
      log "dropped database $PG_DB"
    else
      log "WARN: could not drop database $PG_DB"
    fi
  fi
  restore_ownership
  if [ "$code" -eq 0 ]; then
    log "PASS: $COMMAND (database $DB_NAME, port $PORT)"
  else
    log "FAIL: $COMMAND exited with $code (database $DB_NAME, server log $SERVER_LOG)"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- build ---------------------------------------------------------------------------------------
if [ "${E2E_SKIP_BUILD:-0}" = "1" ]; then
  log "skipping the UI build (E2E_SKIP_BUILD=1)"
else
  log "building the admin UI"
  build_started="$(date +%s)"
  pnpm --filter @agentic-marketing/web build:live
  log "built in $(( $(date +%s) - build_started ))s"
fi

# --- start the server ----------------------------------------------------------------------------
STARTED_MS="$(date +%s%3N)"
log "starting the seeded server on port $PORT with database $PG_DB"
setsid env \
  E2E_PORT="$PORT" \
  E2E_DB="$DB_NAME" \
  TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://am:am@localhost:5432/am_test}" \
  CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://localhost:8123}" \
  VALKEY_URL="${VALKEY_URL:-redis://localhost:6379}" \
  NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}" \
  npx tsx apps/server/test/e2e/server.ts >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
SERVER_PGID="$(ps -o pgid= -p "$SERVER_PID" | tr -d ' ')"
[ -n "$SERVER_PGID" ] || SERVER_PGID="$SERVER_PID"
log "server pid $SERVER_PID, process group $SERVER_PGID; log $SERVER_LOG"

ready=0
deadline=$(( $(date +%s) + READY_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    log "the seeded server exited before it was ready; last lines of $SERVER_LOG:"
    tail -n 40 "$SERVER_LOG" | sed 's/^/  /'
    die "server exited before /ready"
  fi
  if curl -fsS "http://127.0.0.1:$READY_PORT/ready" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || {
  log "the seeded server did not answer /ready within ${READY_TIMEOUT}s; last lines of $SERVER_LOG:"
  tail -n 40 "$SERVER_LOG" | sed 's/^/  /'
  die "timed out waiting for /ready on port $READY_PORT"
}

ELAPSED_MS=$(( $(date +%s%3N) - STARTED_MS ))
ELAPSED_S=$(( ELAPSED_MS / 1000 ))
log "server ready after ${ELAPSED_S}s"

# The fresh database name is the proof that this server seeded, not a stopwatch: a stale server on
# the same port answers /ready at once but never creates am_e2e_<timestamp>.
if ! db_database_exists "$PG_DB"; then
  if [ "$ELAPSED_S" -lt "$MIN_SEED_SECONDS" ]; then
    die "answered /ready after only ${ELAPSED_S}s and database $PG_DB does not exist; a stale server must be answering, or the seed never ran"
  fi
  die "database $PG_DB does not exist after ${ELAPSED_S}s; the server did not seed"
fi
if ! db_has_seeded_workspace "$PG_DB"; then
  die "database $PG_DB has no seeded workspace; the seed did not finish"
fi
log "verified seeded database $PG_DB"

# --- Playwright in the CI image ------------------------------------------------------------------
if [ "$COMMAND" = "shots" ]; then
  [ -f e2e/screenshots.mjs ] || die "e2e/screenshots.mjs does not exist"
  set -- node e2e/screenshots.mjs reports/shots "$@"
else
  case "$COMMAND" in
    smoke) set -- npx playwright test --project=functional --grep '@smoke' "$@" ;;
    functional) set -- npx playwright test --project=functional "$@" ;;
    axe) set -- npx playwright test --project=axe "$@" ;;
    visual) set -- npx playwright test -c playwright.visual.config.ts "$@" ;;
    update) set -- npx playwright test -c playwright.visual.config.ts --update-snapshots "$@" ;;
  esac
fi

log "running: ${*}"
if ! docker run --rm --init \
  --network "$NETWORK" \
  -v "$REPO_ROOT":"$REPO_ROOT" \
  -w "$REPO_ROOT" \
  -e CHROMIUM="$CHROMIUM_PATH" \
  -e E2E_BASE="http://localhost:$PORT" \
  -e E2E_PORT="$PORT" \
  -e E2E_FIXTURES="http://127.0.0.1:$READY_PORT" \
  -e CI="${CI:-}" \
  "$IMAGE" "$@"; then
  exit 1
fi
