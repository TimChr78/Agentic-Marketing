#!/usr/bin/env bash
# Smoke test of the Docker image as a self-hoster runs it: docker compose up with a fresh .env,
# bootstrap an owner, sign in, call the API, and post a signup form. Used by CI; run it locally
# with `scripts/smoke.sh` (it creates and removes its own compose project).
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME=am_smoke
export AM_PORT=3000
# Build the local image, or reuse it with SMOKE_NO_BUILD=1 (SMOKE_IMAGE names the image).
export AM_BUILD_IMAGE="${SMOKE_IMAGE:-am_smoke-app}"
ENV_FILE=$(mktemp)
dc() {
  docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.build.yml "$@"
}
trap 'dc logs app | tail -50; dc down -v >/dev/null 2>&1; rm -f "$ENV_FILE" /tmp/am_smoke_cookies' EXIT

cat >"$ENV_FILE" <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 16)
APP_DB_PASSWORD=$(openssl rand -hex 16)
AUTH_SECRET=$(openssl rand -base64 32)
MASTER_KEY=$(openssl rand -base64 32)
PUBLIC_URL=http://localhost:3000
AM_PORT=3000
PUBLIC_PORT=3001
ENV

# Always build through the overlay: the default compose file pulls the release image.
# SMOKE_NO_BUILD=1 reuses an image built beforehand as $AM_BUILD_IMAGE (am_smoke-app by default).
dc up -d $([ -n "${SMOKE_NO_BUILD:-}" ] || echo --build) --wait --wait-timeout 300
curl -fsS http://localhost:3000/readyz >/dev/null && echo "ready"

EMAIL=owner@example.com PASSWORD='smoke-test-password-123'
dc exec -T -e AM_BOOTSTRAP_PASSWORD="$PASSWORD" app am bootstrap --email "$EMAIL" --workspace Smoke
curl -fsS -c /tmp/am_smoke_cookies -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" http://localhost:3000/api/auth/sign-in/email >/dev/null
call() { curl -fsS -b /tmp/am_smoke_cookies -H 'content-type: application/json' -d "$2" "http://localhost:3000/v1/$1"; }
json() { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s)$1))"; }

call workspace.get '{}' | json '.name' | grep -qx Smoke && echo "signed in"
call emailProviders.create '{"name":"Outbox","adapter":"log","fromEmail":"news@example.com","useFor":["transactional","marketing"]}' >/dev/null
MJML='<mjml><mj-body><mj-section><mj-column><mj-text><a href=\"{{ confirm_url | raw }}\">Confirm</a></mj-text></mj-column></mj-section></mj-body></mjml>'
TPL=$(call artifacts.create "{\"type\":\"email_template\",\"name\":\"Confirm\",\"content\":{\"purpose\":\"onboarding\",\"subject\":\"Confirm\",\"mjml\":\"$MJML\"}}" | json '.artifactId')
call artifacts.requestPublish "{\"artifactId\":\"$TPL\",\"note\":\"smoke\"}" >/dev/null
FORM=$(call artifacts.create "{\"type\":\"form\",\"name\":\"Newsletter\",\"content\":{\"purposes\":[\"marketing_email\"],\"confirmationTemplate\":\"$TPL\",\"consentText\":\"Yes\",\"successUrl\":\"/thanks\",\"confirmedUrl\":\"/welcome\"}}" | json '.artifactId')
call artifacts.requestPublish "{\"artifactId\":\"$FORM\",\"note\":\"smoke\"}" >/dev/null
curl -fsS -H 'content-type: application/json' -d '{"email":"ada@example.com"}' "http://localhost:3000/f/$FORM" | grep -q '"ok":true' && echo "form accepted"

sent=""
for _ in $(seq 30); do
  if call messages.list '{"limit":5}' | grep -q '"status":"sent"'; then sent=1; echo "confirmation e-mail sent"; break; fi
  sleep 1
done
[ -n "$sent" ] || { echo "no confirmation e-mail was sent" >&2; exit 1; }

# The checks an operator runs after an upgrade (am smoke) with a narrow token, as an agent has, inside the container against both
# listeners: admin paths hidden on the public one, dot-segments refused, MCP, the provider, a signup.
TOKEN=$(call apiTokens.create '{"name":"smoke","scopes":["artifacts:read"]}' | json '.token')
dc exec -T -e AM_TOKEN="$TOKEN" app am smoke --public-url http://localhost:3001 --admin-url http://localhost:3000 \
  --form "$FORM" --email grace@example.com
