#!/usr/bin/env bash
# Smoke test of the Docker image as a self-hoster runs it: docker compose up with a fresh .env,
# bootstrap an owner, sign in, call the API, and post a signup form. Used by CI; run it locally
# with `scripts/smoke.sh` (it creates and removes its own compose project).
#
# Every run has its own id: its compose project (and so its containers, network and volumes), its
# throw-away env file and cookie jar, and its own host ports. Two runs side by side, or a real
# install on the same host, never touch each other, and cleanup removes only this run's project.
set -euo pipefail
cd "$(dirname "$0")/.."

# Per-run identity. The project name scopes containers, networks and volumes, so `down -v` in one
# run cannot remove another run's stack (#870).
RUN_ID="am_smoke_$$_$RANDOM"
export COMPOSE_PROJECT_NAME="$RUN_ID"

# Host ports are not picked here: a free port found now can be taken by another run before `up`
# binds it, and inside a container the check only sees the container's loopback (#877). Instead the
# run publishes port 0 and lets Docker pick the port when the container starts, then reads it back
# with `docker compose port`. SMOKE_PORT/SMOKE_PUBLIC_PORT pin a port instead.
ADMIN_HOST_PORT="${SMOKE_PORT:-0}"
PUBLIC_HOST_PORT="${SMOKE_PUBLIC_PORT:-0}"

# The port the app listens on for the public-only listener inside the container. The published host
# port differs (Docker assigns it); `am smoke` below talks to this one from inside the container.
PUBLIC_LISTEN_PORT=3001

# Inside a container the Docker daemon is the host's, so the published ports are on the host, and
# the host's bridge address is what this script can reach; on a normal host that is loopback.
in_container() { [ -f /.dockerenv ] || grep -qa docker /proc/1/cgroup 2>/dev/null; }
BIND_IP="${SMOKE_BIND_IP:-$(in_container && echo 172.17.0.1 || echo 127.0.0.1)}"
EMAIL=owner@example.com
PASSWORD='smoke-test-password-123'

# Fresh secrets every run, so a smoke run never needs (or leaves) a template value. Passwords are
# hex because Compose interpolates POSTGRES_PASSWORD into DATABASE_URL and cannot percent-encode
# it; the keys are base64 because the server reads base64.
POSTGRES_PASSWORD=$(openssl rand -hex 16)
APP_DB_PASSWORD=$(openssl rand -hex 16)
AUTH_SECRET=$(openssl rand -base64 32)
MASTER_KEY=$(openssl rand -base64 32)

# Build the local image, or reuse it with SMOKE_NO_BUILD=1 (SMOKE_IMAGE names the image). A run
# that builds tags its own image, so a concurrent run cannot swap the tag underneath it; the
# reuse path keeps the CI name am_smoke-app that the release workflow builds (#870).
if [ -n "${SMOKE_NO_BUILD:-}" ]; then
  AM_BUILD_IMAGE="${SMOKE_IMAGE:-am_smoke-app}"
else
  AM_BUILD_IMAGE="${SMOKE_IMAGE:-am_smoke-app-$RUN_ID}"
fi

ENV_FILE=$(mktemp)
COOKIES=$(mktemp)

# Compose prefers the shell's exported variables to --env-file, so an exported AM_PORT, AM_BIND,
# POSTGRES_PASSWORD or similar would silently replace this run's. Clear them, then load the run's
# own file in a subshell for every invocation (including the trap).
dc() (
  unset AM_VERSION AM_PORT AM_BIND AM_BUILD_IMAGE PUBLIC_URL PUBLIC_PORT PUBLIC_BIND ROLE PORT \
    POSTGRES_PASSWORD APP_DB_PASSWORD AUTH_SECRET MASTER_KEY APP_DB_ROLE KEY_PROVIDER WEB_DIST \
    TRUSTED_ORIGINS SKIP_MIGRATIONS 2>/dev/null || true
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  docker compose --env-file "$ENV_FILE" -p "$RUN_ID" -f docker-compose.yml -f docker-compose.build.yml "$@"
)

# Write this run's env file. It is rewritten with the ports Docker assigned, because the trusted
# origin (needed for the browser-style sign-in request) contains the host port, which is known only
# after `up`. Re-running `up` after the rewrite recreates only the app container, with the same
# ports pinned, so it keeps answering on $BASE.
write_env() {
  local admin_host_port="$1" public_host_port="$2" trusted_origins="$3"
  cat >"$ENV_FILE" <<ENV
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
APP_DB_PASSWORD=$APP_DB_PASSWORD
AUTH_SECRET=$AUTH_SECRET
MASTER_KEY=$MASTER_KEY
# PUBLIC_URL stays the container's own admin address: MCP (which `am smoke` below checks) is
# disabled for a plain-HTTP non-loopback address, and inside the container localhost:3000 is the
# admin listener.
PUBLIC_URL=http://localhost:3000
# The script reaches the same server from outside at $BASE, so that origin is trusted explicitly for
# the browser-style sign-in request. Empty until Docker has assigned the port.
TRUSTED_ORIGINS=$trusted_origins
AM_BIND=$BIND_IP
AM_PORT=$admin_host_port
AM_BUILD_IMAGE=$AM_BUILD_IMAGE
PUBLIC_BIND=$BIND_IP:$public_host_port
PUBLIC_PORT=$PUBLIC_LISTEN_PORT
ENV
}

# The host port Docker published for a container port, e.g. `127.0.0.1:32768` -> `32768`.
published_port() {
  local mapping first
  mapping="$(dc port app "$1")"
  [ -n "$mapping" ] || { echo "no published port for $1" >&2; exit 1; }
  first="${mapping%%$'\n'*}"
  echo "${first##*:}"
}

# Both ports pinned (SMOKE_PORT and SMOKE_PUBLIC_PORT): the trusted origin is known up front, so a
# single `up` suffices. Otherwise Docker assigns them, and the env file is completed after `up`.
BASE=""
if [ -n "${SMOKE_PORT:-}" ] && [ -n "${SMOKE_PUBLIC_PORT:-}" ]; then
  BASE="http://$BIND_IP:$ADMIN_HOST_PORT"
fi
write_env "$ADMIN_HOST_PORT" "$PUBLIC_HOST_PORT" "$BASE"

# Only this run's project is removed: the name carries the run id, and the temp files are ours.
cleanup() {
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "--- last 50 log lines" >&2
    dc logs app 2>&1 | tail -50 >&2 || true
  fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE" "$COOKIES"
  exit "$code"
}
trap cleanup EXIT

# Always build through the overlay: the default compose file pulls the release image.
# SMOKE_NO_BUILD=1 reuses an image built beforehand as $AM_BUILD_IMAGE.
dc up -d $([ -n "${SMOKE_NO_BUILD:-}" ] || echo --build) --wait --wait-timeout 300

# With a port left at 0 Docker chose it at container start. Read it back and record it, along with
# the origin this script calls, then `up` again: only the app container changes (it keeps the same
# pinned ports and the image is already built), so the sign-in's CSRF check sees $BASE as trusted.
if [ -z "$BASE" ]; then
  ADMIN_HOST_PORT=$(published_port 3000)
  PUBLIC_HOST_PORT=$(published_port "$PUBLIC_LISTEN_PORT")
  BASE="http://$BIND_IP:$ADMIN_HOST_PORT"
  write_env "$ADMIN_HOST_PORT" "$PUBLIC_HOST_PORT" "$BASE"
  dc up -d --wait --wait-timeout 300
fi

curl -fsS "$BASE/readyz" >/dev/null && echo "ready"

dc exec -T -e AM_BOOTSTRAP_PASSWORD="$PASSWORD" app am bootstrap --email "$EMAIL" --workspace Smoke
curl -fsS -c "$COOKIES" -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/sign-in/email" >/dev/null
call() { curl -fsS -b "$COOKIES" -H 'content-type: application/json' -H "origin: $BASE" -d "$2" "$BASE/v1/$1"; }
json() { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s)$1))"; }

call workspace.get '{}' | json '.name' | grep -qx Smoke && echo "signed in"
call emailProviders.create '{"name":"Outbox","adapter":"log","fromEmail":"news@example.com","useFor":["transactional","marketing"]}' >/dev/null
MJML='<mjml><mj-body><mj-section><mj-column><mj-text><a href=\"{{ confirm_url | raw }}\">Confirm</a></mj-text></mj-column></mj-section></mj-body></mjml>'
TPL=$(call artifacts.create "{\"type\":\"email_template\",\"name\":\"Confirm\",\"content\":{\"purpose\":\"onboarding\",\"subject\":\"Confirm\",\"mjml\":\"$MJML\"}}" | json '.artifactId')
call artifacts.requestPublish "{\"artifactId\":\"$TPL\",\"note\":\"smoke\"}" >/dev/null
FORM=$(call artifacts.create "{\"type\":\"form\",\"name\":\"Newsletter\",\"content\":{\"purposes\":[\"marketing_email\"],\"confirmationTemplate\":\"$TPL\",\"consentText\":\"Yes\",\"successUrl\":\"/thanks\",\"confirmedUrl\":\"/welcome\"}}" | json '.artifactId')
call artifacts.requestPublish "{\"artifactId\":\"$FORM\",\"note\":\"smoke\"}" >/dev/null
curl -fsS -H 'content-type: application/json' -d '{"email":"ada@example.com"}' "$BASE/f/$FORM" | grep -q '"ok":true' && echo "form accepted"

sent=""
for _ in $(seq 30); do
  if call messages.list '{"limit":5}' | grep -q '"status":"sent"'; then sent=1; echo "confirmation e-mail sent"; break; fi
  sleep 1
done
[ -n "$sent" ] || { echo "no confirmation e-mail was sent" >&2; exit 1; }

# The checks an operator runs after an upgrade (am smoke) with a narrow token, as an agent has, inside the container against both
# listeners: admin paths hidden on the public one, dot-segments refused, MCP, the provider, a signup.
TOKEN=$(call apiTokens.create '{"name":"smoke","scopes":["artifacts:read"]}' | json '.token')
dc exec -T -e AM_TOKEN="$TOKEN" app am smoke --public-url "http://localhost:$PUBLIC_LISTEN_PORT" --admin-url http://localhost:3000 \
  --form "$FORM" --email grace@example.com
