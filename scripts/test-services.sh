#!/usr/bin/env bash
# One shared test stack per machine, for every checkout and delegate.
#
#   scripts/test-services.sh up [mail|obs ...]   start (and wait for health); optional profiles
#   scripts/test-services.sh down                stop, keep data
#   scripts/test-services.sh reset               stop and drop the volumes
#   scripts/test-services.sh status              what the am-test project is running
#   scripts/test-services.sh logs [service]      follow the logs
#   scripts/test-services.sh env                 print the exports the tests need
#
# Ports and the bind address come from the environment or .env.test (see docker-compose.test.yml).
# The stack binds 127.0.0.1 by default; inside a container it binds the Docker bridge's host address
# (172.17.0.1), because the host's loopback is not reachable from there.
# A wildcard bind (AM_TEST_BIND_IP=0.0.0.0) is allowed but always warned about.
# `env` prints localhost on a normal host and the bridge address inside a container; set
# AM_TEST_HOST to override.
set -euo pipefail

if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
  echo "error: scripts/test-services.sh requires bash >= 4 (macOS: brew install bash, then run with /opt/homebrew/bin/bash)." >&2
  exit 1
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

ENV_FILE=${AM_TEST_ENV_FILE:-$ROOT/.env.test}
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

COMPOSE=()
compose() {
  if [ "${#COMPOSE[@]}" -eq 0 ]; then
    if docker compose version >/dev/null 2>&1; then
      COMPOSE=(docker compose)
    elif command -v docker-compose >/dev/null 2>&1; then
      COMPOSE=(docker-compose)
    else
      echo "error: Docker Compose is not available (tried 'docker compose' and 'docker-compose')." >&2
      exit 1
    fi
  fi
  local env_args=()
  [ -f "$ENV_FILE" ] && env_args=(--env-file "$ENV_FILE")
  # The resolved bind address wins over the compose file's default: loopback on a host, the Docker
  # bridge's host address inside a container, and whatever AM_TEST_BIND_IP names (#605).
  AM_TEST_BIND_IP=$(bind_ip) "${COMPOSE[@]}" "${env_args[@]}" -f "$ROOT/docker-compose.test.yml" -p am-test "$@"
}

in_container() {
  [ -f /.dockerenv ] || [ -f /run/.containerenv ]
}

# Where the published ports bind. The default is loopback because this stack carries a dev OpenBao
# whose root token is `root` and a writable Postgres (am:am), so a LAN-wide default is a security
# finding, not a preference. Inside a container the host's loopback is unreachable, so the bridge's
# host address stands in for it.
bind_ip() {
  if [ -n "${AM_TEST_BIND_IP:-}" ]; then
    printf '%s' "$AM_TEST_BIND_IP"
  elif in_container; then
    printf '172.17.0.1'
  else
    printf '127.0.0.1'
  fi
}

# Print the real bind address, and shout when it is a wildcard.
announce_bind() {
  local bind
  bind=$(bind_ip)
  printf 'test stack published on %s (Postgres %s, ClickHouse %s, Valkey %s, NATS %s, OpenBao %s)\n' \
    "$bind" "$(port_default pg)" "$(port_default ch)" "$(port_default valkey)" "$(port_default nats)" \
    "$(port_default openbao)" >&2
  case "$bind" in
    0.0.0.0 | :: | '[::]')
      {
        echo 'warning: that is a wildcard bind: every interface can reach the test stack.'
        echo "warning: it holds a dev OpenBao whose root token is 'root' and a writable Postgres (am:am)."
        echo 'warning: unset AM_TEST_BIND_IP to get 127.0.0.1 (172.17.0.1 inside a container).'
      } >&2
      ;;
    127.0.0.1 | ::1)
      if in_container; then
        echo 'note: a loopback bind inside a container is unreachable from other containers.' >&2
      fi
      ;;
  esac
}

test_host() {
  local bind
  if [ -n "${AM_TEST_HOST:-}" ]; then
    printf '%s' "$AM_TEST_HOST"
    return
  fi
  bind=$(bind_ip)
  case "$bind" in
    0.0.0.0 | :: | '[::]' | 127.0.0.1 | ::1) printf 'localhost' ;;
    *) printf '%s' "$bind" ;;
  esac
}

port_default() {
  case "$1" in
    pg) printf '%s' "${AM_TEST_PG_PORT:-25432}" ;;
    ch) printf '%s' "${AM_TEST_CH_PORT:-28123}" ;;
    valkey) printf '%s' "${AM_TEST_VALKEY_PORT:-26379}" ;;
    nats) printf '%s' "${AM_TEST_NATS_PORT:-24222}" ;;
    openbao) printf '%s' "${AM_TEST_OPENBAO_PORT:-28200}" ;;
  esac
}

wait_hint() {
  echo
  echo "Exports for this shell:"
  echo "  eval \"\$(scripts/test-services.sh env)\""
}

usage() {
  sed -n '2,/^[^#]/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  up)
    shift
    profiles=()
    for profile in "$@"; do profiles+=(--profile "$profile"); done
    compose "${profiles[@]}" up -d --wait
    announce_bind
    wait_hint
    ;;
  down)
    compose down --remove-orphans
    ;;
  reset)
    compose down -v --remove-orphans
    ;;
  status)
    compose ps
    echo
    docker ps --filter label=am-test=1 --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    ;;
  logs)
    shift
    compose logs --tail=100 -f "$@"
    ;;
  env)
    announce_bind
    host=$(test_host)
    cat <<ENV
export TEST_DATABASE_URL="postgres://am:am@${host}:$(port_default pg)/am_test"
export CLICKHOUSE_URL="http://${host}:$(port_default ch)"
export VALKEY_URL="redis://${host}:$(port_default valkey)"
export NATS_URL="nats://${host}:$(port_default nats)"
export OPENBAO_TEST_ADDR="http://${host}:$(port_default openbao)"
export OPENBAO_TEST_TOKEN="root"
ENV
    ;;
  "" | -h | --help | help)
    usage
    ;;
  *)
    echo "error: unknown command '$1'" >&2
    usage >&2
    exit 2
    ;;
esac
