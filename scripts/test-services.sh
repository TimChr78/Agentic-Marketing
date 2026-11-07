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
# `env` prints localhost on a normal host and 172.17.0.1 inside a container, where the host's
# published ports are only reachable on the Docker bridge; set AM_TEST_HOST to override.
set -euo pipefail

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
  "${COMPOSE[@]}" "${env_args[@]}" -f "$ROOT/docker-compose.test.yml" -p am-test "$@"
}

test_host() {
  if [ -n "${AM_TEST_HOST:-}" ]; then
    printf '%s' "$AM_TEST_HOST"
  elif [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
    printf '172.17.0.1'
  else
    printf 'localhost'
  fi
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
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  up)
    shift
    profiles=()
    for profile in "$@"; do profiles+=(--profile "$profile"); done
    compose "${profiles[@]}" up -d --wait
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
