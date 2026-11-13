#!/usr/bin/env bash
# Smoke test of the Docker image as a self-hoster runs it: docker compose up with a fresh .env,
# bootstrap an owner, sign in, call the API, and post a signup form. Used by CI; run it locally
# with `scripts/smoke.sh` (it creates and removes its own compose project).
#
# Every run has its own id: its compose project (and so its containers, network and volumes), its
# throw-away env file and cookie jar, and its own free ports. Two runs side by side, or a real
# install on the same host, never touch each other, and cleanup removes only this run's project.
set -euo pipefail
cd "$(dirname "$0")/.."

# Per-run identity. The project name scopes containers, networks and volumes, so `down -v` in one
# run cannot remove another run's stack (#870).
RUN_ID="am_smoke_$$_$RANDOM"
export COMPOSE_PROJECT_NAME="$RUN_ID"

# Free host ports for this run, never a fixed 3000 that an installed stack may hold. Both sockets
# are opened together, so the two ports differ; the first is the admin port, the second the public
# listener. SMOKE_PORT/SMOKE_PUBLIC_PORT override them.
if [ -n "${SMOKE_PORT:-}" ] && [ -n "${SMOKE_PUBLIC_PORT:-}" ]; then
  PORT="$SMOKE_PORT"
  PUBLIC_PORT="$SMOKE_PUBLIC_PORT"
else
  read -r FREE_ADMIN FREE_PUBLIC <<<"$(node -e '
    const { createServer } = require("node:net");
    const servers = [];
    const open = () =>
      new Promise((resolve) => {
        const server = createServer();
        servers.push(server);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    Promise.all([open(), open()]).then(([admin, pub]) => {
      console.log(admin, pub);
      for (const server of servers) server.close();
    });
  ')"
  PORT="${SMOKE_PORT:-$FREE_ADMIN}"
  PUBLIC_PORT="${SMOKE_PUBLIC_PORT:-$FREE_PUBLIC}"
fi

# Inside a container the Docker daemon is the host's, so the published ports are on the host, and
# the host's bridge address is what this script can reach; on a normal host that is loopback.
in_container() { [ -f /.dockerenv ] || grep -qa docker /proc/1/cgroup 2>/dev/null; }
BIND_IP="${SMOKE_BIND_IP:-$(in_container && echo 172.17.0.1 || echo 127.0.0.1)}"
BASE="http://$BIND_IP:$PORT"
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

cat >"$ENV_FILE" <<ENV
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
APP_DB_PASSWORD=$APP_DB_PASSWORD
AUTH_SECRET=$AUTH_SECRET
MASTER_KEY=$MASTER_KEY
# PUBLIC_URL stays the container's own admin address: MCP (which `am smoke` below checks) is
# disabled for a plain-HTTP non-loopback address, and inside the container localhost:3000 is the
# admin listener. The script reaches the same server from outside at $BASE, so that origin is
# trusted explicitly for the browser-style sign-in request.
PUBLIC_URL=http://localhost:3000
TRUSTED_ORIGINS=$BASE
AM_BIND=$BIND_IP
AM_PORT=$PORT
AM_BUILD_IMAGE=$AM_BUILD_IMAGE
PUBLIC_BIND=$BIND_IP:$PUBLIC_PORT
PUBLIC_PORT=$PUBLIC_PORT
ENV

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
curl -fsS "$BASE/readyz" >/dev/null && echo "ready"

dc exec -T -e AM_BOOTSTRAP_PASSWORD="$PASSWORD" app am bootstrap --email "$EMAIL" --workspace Smoke
curl -fsS -c "$COOKIES" -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/sign-in/email" >/dev/null
call() { curl -fsS -b "$COOKIES" -H 'content-type: application/json' -d "$2" "$BASE/v1/$1"; }
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
dc exec -T -e AM_TOKEN="$TOKEN" app am smoke --public-url "http://localhost:$PUBLIC_PORT" --admin-url http://localhost:3000 \
  --form "$FORM" --email grace@example.com
