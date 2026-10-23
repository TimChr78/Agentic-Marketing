#!/usr/bin/env bash
# Smoke test of the Docker image as a self-hoster runs it: docker compose up with a fresh .env,
# bootstrap an owner, sign in, call the API, and post a signup form. Used by CI; run it locally
# with `scripts/smoke.sh` (it creates and removes its own compose project).
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME=am_smoke
ENV_FILE=$(mktemp)
trap 'docker compose --env-file "$ENV_FILE" logs app | tail -50; docker compose --env-file "$ENV_FILE" down -v >/dev/null 2>&1; rm -f "$ENV_FILE" /tmp/am_smoke_cookies' EXIT

cat >"$ENV_FILE" <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 16)
APP_DB_PASSWORD=$(openssl rand -hex 16)
AUTH_SECRET=$(openssl rand -base64 32)
MASTER_KEY=$(openssl rand -base64 32)
PUBLIC_URL=http://localhost:3000
ENV
dc() { docker compose --env-file "$ENV_FILE" "$@"; }

# SMOKE_NO_BUILD=1 reuses an image built beforehand as am_smoke-app.
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

for _ in $(seq 30); do
  if call messages.list '{"limit":5}' | grep -q '"status":"sent"'; then echo "confirmation e-mail sent"; exit 0; fi
  sleep 1
done
echo "no confirmation e-mail was sent" >&2
exit 1
