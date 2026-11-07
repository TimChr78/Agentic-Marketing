#!/usr/bin/env bash
# Run the Playwright suite exactly as CI does: the pinned Playwright image, the repository mounted at
# its own path, and a freshly seeded server on the host (or, inside a container, in this container).
#
#   scripts/e2e-docker.sh <smoke|functional|axe|visual|update|shots> [playwright args...]
#
# What a run does:
#   1. builds the admin UI (unless E2E_SKIP_BUILD=1),
#   2. starts apps/server/test/e2e/server.ts on E2E_PORT with a fresh, run-scoped database,
#   3. waits for /ready on E2E_PORT+1 and refuses a server that answered before it could have seeded,
#   4. runs Playwright in mcr.microsoft.com/playwright:v1.64.1-noble,
#   5. always stops the server it started (by its own process group) and drops only the database
#      this invocation created.
#
# The target is Linux (the CI image and the shared test stack are Linux). macOS lacks `setsid` and
# GNU `date`; the script fails fast instead of half-running.
#
# Environment:
#   E2E_PORT=3100              the seeded server's port (E2E_PORT+1 is the fixtures port). When
#                              unset, it comes from e2e/ports.ts (3100 + TEST_PORT_OFFSET).
#   TEST_PORT_OFFSET=0         moves every e2e port together, exactly as Playwright and the helpers do.
#   E2E_DB=e2e_<timestamp>     an explicit database name; refused if it already exists. A fresh,
#                              generated name is used unless you set it.
#   AM_TEST_RUN=...            the run namespace shared with #515 (generated when unset); the
#                              database name is printed by packages/db/test/print-db.ts.
#   E2E_KEEP_DB=1              keep that database for inspection
#   E2E_SKIP_BUILD=1           reuse the existing apps/web/dist
#   E2E_DOCKER_NETWORK=host    docker network for the runner. Default: host; when this script runs
#                              inside a container, container:<name>, found by container name or id,
#                              so the runner shares this namespace and reaches localhost:E2E_PORT.
#                              A container that cannot be resolved is an error, never a silent
#                              fallback to host networking.
#   E2E_READY_TIMEOUT=240      seconds to wait for the seed
#   CHROMIUM=...               override the Chromium path resolved from the image
#
# The server reaches Postgres, ClickHouse, NATS and Valkey through TEST_DATABASE_URL, CLICKHOUSE_URL,
# NATS_URL and VALKEY_URL, which pass straight through from the environment.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Container identity from mountinfo/cgroup, in its own file so the parser is testable.
# shellcheck source=scripts/container-id.sh
. "$REPO_ROOT/scripts/container-id.sh"

IMAGE="${E2E_IMAGE:-mcr.microsoft.com/playwright:v1.64.1-noble}"
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

# --- prerequisites -------------------------------------------------------------------------------
# Checked before any trap is installed: a run that cannot isolate its server or its database must
# not start one.
command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
command -v node >/dev/null 2>&1 || die "node is not on PATH"
command -v pnpm >/dev/null 2>&1 || die "pnpm is not on PATH (try: corepack enable, or add ~/.local/bin)"
command -v curl >/dev/null 2>&1 || die "curl is not on PATH"
if ! command -v setsid >/dev/null 2>&1; then
  die "setsid is required to give the seeded server its own process group (install util-linux; the browser suite targets Linux, not macOS)"
fi
# GNU date's %3N is not portable; seconds and $RANDOM are enough for timing and a unique name, so
# never depend on it.

# --- one run namespace for the whole invocation (#515) -------------------------------------------
# The harness, print-db, the server and the cleanup all agree through this one value. Generate a
# short lower-case id here when the caller did not set one.
AM_TEST_RUN="${AM_TEST_RUN:-e2e$(printf '%x' "$(date +%s)")$(printf '%04x' "$RANDOM")}"
export AM_TEST_RUN

db_name_for() {
  node --import tsx packages/db/test/print-db.ts "am_$1"
}

# --- port (e2e/ports.ts semantics) ---------------------------------------------------------------
# The wrapper, Playwright and the helpers all read the port from e2e/ports.ts, so TEST_PORT_OFFSET
# moves the wrapper's port exactly as it moves theirs. An explicit E2E_PORT still wins.
if [ -n "${E2E_PORT:-}" ]; then
  PORT="$E2E_PORT"
else
  PORT="$(node --import tsx -e 'import("./e2e/ports.ts").then((m) => console.log(m.portsFor({ TEST_PORT_OFFSET: process.env.TEST_PORT_OFFSET }).port))')" ||
    die "could not derive the e2e port from e2e/ports.ts"
fi
case "$PORT" in
  '' | *[!0-9]*) die "E2E_PORT must be a port number, got '$PORT'" ;;
esac
READY_PORT=$((PORT + 1))

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

# --- database name and ownership -----------------------------------------------------------------
# An explicit name is accepted only when it does not exist yet: cleanup must never drop a database
# another run (or a person) owns. A generated name is checked absent too, so an existing database
# under that name later can only be this invocation's own server having created it.
if [ -n "${E2E_DB:-}" ]; then
  DB_MODE=explicit
  DB_NAME="$E2E_DB"
  case "$DB_NAME" in
    '' | *[!a-z0-9_]*) die "E2E_DB must be lower-case letters, digits and underscores, got '$DB_NAME'" ;;
  esac
  PG_DB="$(db_name_for "$DB_NAME")" || die "could not compute the database name for E2E_DB=$DB_NAME under AM_TEST_RUN=$AM_TEST_RUN"
  DB_CHECK=0
  db_database_exists "$PG_DB" || DB_CHECK=$?
  if [ "$DB_CHECK" -eq 0 ]; then
    die "database $PG_DB (E2E_DB=$DB_NAME) already exists; refusing to reuse or drop a database this run did not create (unset E2E_DB for a fresh name)"
  fi
  [ "$DB_CHECK" -eq 1 ] || die "could not check whether $PG_DB exists; is TEST_DATABASE_URL reachable?"
else
  DB_MODE=generated
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    DB_NAME="e2e_$(date -u +%Y%m%d_%H%M%S)_$$_$(printf '%04x' "$RANDOM")"
    PG_DB="$(db_name_for "$DB_NAME")" || die "could not compute a database name under AM_TEST_RUN=$AM_TEST_RUN"
    DB_CHECK=0
    db_database_exists "$PG_DB" || DB_CHECK=$?
    [ "$DB_CHECK" -eq 1 ] && break
    [ "$DB_CHECK" -eq 0 ] || die "could not check whether $PG_DB exists; is TEST_DATABASE_URL reachable?"
    [ "$attempt" -lt 5 ] || die "could not find an unused database name after $attempt attempts"
  done
fi
SERVER_LOG="$TMP_ROOT/e2e-server-$AM_TEST_RUN-$DB_NAME.log"

# --- network -------------------------------------------------------------------------------------
inside_container() {
  [ -f /.dockerenv ] || [ -f /run/.containerenv ] ||
    grep -qaE '(docker|containerd|kubepods|crio|libpod)' /proc/self/cgroup 2>/dev/null
}

# A custom $HOSTNAME is a container name, not an id; container_id_from_proc (scripts/container-id.sh)
# reads the id from the runtime's own metadata when the hostname is not enough.

resolve_self_container() {
  local ref name
  for ref in "$@"; do
    [ -n "$ref" ] || continue
    name="$(docker ps --filter "id=$ref" --format '{{.Names}}' 2>/dev/null | head -1 || true)"
    [ -n "$name" ] && {
      printf '%s' "$name"
      return 0
    }
    name="$(docker ps --filter "name=^${ref}$" --format '{{.Names}}' 2>/dev/null | head -1 || true)"
    [ -n "$name" ] && {
      printf '%s' "$name"
      return 0
    }
  done
  return 1
}

NETWORK="${E2E_DOCKER_NETWORK:-}"
if [ -z "$NETWORK" ]; then
  if inside_container; then
    PROC_CONTAINER_ID="$(container_id_from_proc)"
    if ! SELF_CONTAINER="$(resolve_self_container "${HOSTNAME:-}" "$PROC_CONTAINER_ID")"; then
      die "running inside a container but could not resolve it from \$HOSTNAME (${HOSTNAME:-unset}), /proc/self/mountinfo or /proc/self/cgroup; set E2E_DOCKER_NETWORK=container:<this-container-name> (use host only when the test stack is reachable that way)"
    fi
    NETWORK="container:$SELF_CONTAINER"
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
REPORTED_PID=""
LAUNCHED_PID=""
PGID_FILE=""
DB_OWNED=0
CALLER_PGID="$(ps -o pgid= -p $$ | tr -d ' ')"

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

signal_server() {
  local signal="$1"
  if [ -n "$SERVER_PGID" ] && [ "$SERVER_PGID" != "$CALLER_PGID" ] && [ "$SERVER_PGID" != "$$" ]; then
    kill "-$signal" -- "-$SERVER_PGID" 2>/dev/null && return 0
  elif [ -n "$SERVER_PGID" ]; then
    log "WARN: refusing to signal process group $SERVER_PGID (the caller's own group); signalling pid $SERVER_PID only"
  fi
  kill "-$signal" "$SERVER_PID" 2>/dev/null
}

# Before the group is verified there is still a launched child (setsid, then the server). Stop that
# exact pid so a timeout or a cancellation during the PID handshake cannot leak it.
stop_unverified_pid() {
  local pid="$1"
  log "stopping the seeded server launcher (pid $pid; process group not verified)"
  kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -KILL "$pid" 2>/dev/null
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if [ -n "$SERVER_PGID" ]; then
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      log "stopping the seeded server (pid $SERVER_PID, process group $SERVER_PGID)"
      signal_server TERM
      for _ in $(seq 1 50); do
        kill -0 "$SERVER_PID" 2>/dev/null || break
        sleep 0.2
      done
      signal_server KILL
    else
      log "seeded server (pid $SERVER_PID) is already gone"
    fi
  elif [ -n "$REPORTED_PID" ] && kill -0 "$REPORTED_PID" 2>/dev/null; then
    stop_unverified_pid "$REPORTED_PID"
  elif [ -n "$LAUNCHED_PID" ] && kill -0 "$LAUNCHED_PID" 2>/dev/null; then
    stop_unverified_pid "$LAUNCHED_PID"
  fi
  # Drop only the exact database this invocation created. Both kinds of name were verified absent
  # before launch, so a confirmed existence means this run's server created it, even if the seed
  # failed before the workspace check. A failed probe (exit 2) never grants ownership.
  owned=0
  if [ "$DB_OWNED" = 1 ]; then
    owned=1
  else
    db_database_exists "$PG_DB"
    DB_STATE=$?
    [ "$DB_STATE" -eq 0 ] && owned=1
  fi
  if [ "${E2E_KEEP_DB:-0}" = "1" ] && [ "$owned" = 1 ]; then
    log "keeping database $PG_DB (E2E_KEEP_DB=1)"
  elif [ "$owned" = 1 ]; then
    if db_drop "$PG_DB"; then
      log "dropped database $PG_DB"
    else
      log "WARN: could not drop database $PG_DB"
    fi
  else
    log "leaving database $PG_DB alone (this run never created it)"
  fi
  if [ -n "$PGID_FILE" ]; then
    rm -f "$PGID_FILE"
  fi
  restore_ownership
  if [ "$code" -eq 0 ]; then
    log "PASS: $COMMAND (database $PG_DB, port $PORT, run $AM_TEST_RUN)"
  else
    log "FAIL: $COMMAND exited with $code (database $PG_DB, server log $SERVER_LOG)"
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
PGID_FILE="$TMP_ROOT/e2e-pgid-$AM_TEST_RUN-$$"
rm -f "$PGID_FILE"
STARTED_AT="$(date +%s)"
log "starting the seeded server on port $PORT with database $PG_DB (run $AM_TEST_RUN)"
# The child creates its own session and writes the process group it leads before exec'ing the
# server, so the group is established and verifiable instead of inferred from ps at launch time.
setsid bash -c '
  printf "%s\n" "$$" > "$1"
  shift
  exec "$@"
' _ "$PGID_FILE" env \
  AM_TEST_RUN="$AM_TEST_RUN" \
  E2E_PORT="$PORT" \
  E2E_DB="$DB_NAME" \
  TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://am:am@localhost:5432/am_test}" \
  CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://localhost:8123}" \
  VALKEY_URL="${VALKEY_URL:-redis://localhost:6379}" \
  NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}" \
  npx tsx apps/server/test/e2e/server.ts >"$SERVER_LOG" 2>&1 &
LAUNCHED_PID=$!

for _ in $(seq 1 100); do
  [ -s "$PGID_FILE" ] && break
  sleep 0.1
done
if [ ! -s "$PGID_FILE" ]; then
  die "the seeded server (launcher pid $LAUNCHED_PID) did not report its process group; refusing to signal an unverified group"
fi
REPORTED_PID="$(tr -d '[:space:]' <"$PGID_FILE")"
case "$REPORTED_PID" in
  '' | *[!0-9]* | 0) die "the seeded server reported an invalid process group '$REPORTED_PID'" ;;
esac
ACTUAL_PGID="$(ps -o pgid= -p "$REPORTED_PID" 2>/dev/null | tr -d ' ')"
[ "$ACTUAL_PGID" = "$REPORTED_PID" ] ||
  die "seeded server pid $REPORTED_PID is not the leader of its own process group (pgid '${ACTUAL_PGID:-none}')"
[ "$REPORTED_PID" != "$CALLER_PGID" ] ||
  die "seeded server process group $REPORTED_PID equals the caller's group; refusing to signal it"
kill -0 "$REPORTED_PID" 2>/dev/null || die "seeded server pid $REPORTED_PID is not running"
# Only a verified private leader becomes the group cleanup may signal.
SERVER_PID="$REPORTED_PID"
SERVER_PGID="$REPORTED_PID"
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

ELAPSED_S=$(( $(date +%s) - STARTED_AT ))
log "server ready after ${ELAPSED_S}s"

# The fresh database name is the proof that this server seeded, not a stopwatch: a stale server on
# the same port answers /ready at once but never creates this run's database.
if ! db_database_exists "$PG_DB"; then
  if [ "$ELAPSED_S" -lt "$MIN_SEED_SECONDS" ]; then
    die "answered /ready after only ${ELAPSED_S}s and database $PG_DB does not exist; a stale server must be answering, or the seed never ran"
  fi
  die "database $PG_DB does not exist after ${ELAPSED_S}s; the server did not seed"
fi
if ! db_has_seeded_workspace "$PG_DB"; then
  die "database $PG_DB has no seeded workspace; the seed did not finish"
fi
# Only now has this invocation proved that it created and seeded exactly this database.
DB_OWNED=1
log "verified seeded database $PG_DB (run $AM_TEST_RUN)"

# --- Playwright in the CI image ------------------------------------------------------------------
# Concurrent runs share the mounted checkout, so Playwright's artifacts go to a directory named
# after this run instead of the fixed test-results/ that every run would otherwise delete.
OUTPUT_DIR="test-results/$AM_TEST_RUN"
if [ "$COMMAND" = "shots" ]; then
  [ -f e2e/screenshots.mjs ] || die "e2e/screenshots.mjs does not exist"
  set -- node e2e/screenshots.mjs reports/shots "$@"
else
  case "$COMMAND" in
    smoke) set -- npx playwright test --output "$OUTPUT_DIR" --project=functional --grep '@smoke' "$@" ;;
    functional) set -- npx playwright test --output "$OUTPUT_DIR" --project=functional "$@" ;;
    axe) set -- npx playwright test --output "$OUTPUT_DIR" --project=axe "$@" ;;
    visual) set -- npx playwright test --output "$OUTPUT_DIR" -c playwright.visual.config.ts "$@" ;;
    update) set -- npx playwright test --output "$OUTPUT_DIR" -c playwright.visual.config.ts --update-snapshots "$@" ;;
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
