// Server-rendered sign-in and consent pages for the OAuth flow MCP clients use. Small on purpose:
// no build step, no framework. The consent page lets the person choose what the agent may do;
// MCP clients request every advertised scope, so this is where least privilege happens.

const scopeText: Record<string, string> = {
  'artifacts:read': 'Read journeys, templates and other artifacts',
  'artifacts:write': 'Create and edit drafts',
  'artifacts:publish': 'Publish, or send changes for approval (your approval policy still applies)',
  'artifacts:approve': 'Approve changes (agents can never use this)',
  'audit:read': 'Read the audit log',
  'secrets:read': 'See the names of stored secrets (never their values)',
  'secrets:write': 'Store and delete secrets (agents can never use this)',
  'workspace:admin': 'Change workspace settings (agents can never use this)',
};
const defaultOn = new Set(['openid', 'profile', 'email', 'offline_access', 'artifacts:read', 'artifacts:write', 'artifacts:publish']);

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Agentic Marketing</title>
<style>
  :root { --bg:#f4f6f9; --fg:#141a24; --muted:#5d6779; --accent:#2f5bea; --line:#dce1e9; --card:#fff; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1117; --fg:#e5e9f0; --muted:#98a2b3; --accent:#7091f8; --line:#29303f; --card:#151a23; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; padding:48px max(16px, env(safe-area-inset-left)); }
  main { max-width: 420px; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 28px; }
  h1 { font-size: 22px; margin: 0 0 4px; } p { color: var(--muted); margin: 0 0 18px; }
  label { display:block; margin: 10px 0; } input[type=email], input[type=password] { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; font:inherit; }
  button { padding: 9px 16px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; font: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .scope { display:flex; gap:10px; align-items:flex-start; } .scope code { font-size: 12px; color: var(--muted); }
  #err { color: #c42b2b; min-height: 1.5em; }
</style></head><body><main>${body}</main></body></html>`;

export const loginPage = layout(
  'Sign in',
  `<h1>Sign in</h1><p>An app wants to connect to your marketing workspace.</p>
<form id="f">
  <label>E-mail<input id="email" name="email" type="email" autocomplete="username" required></label>
  <label>Password<input id="password" name="password" type="password" autocomplete="current-password" required></label>
  <p id="err" role="alert"></p>
  <button class="primary">Sign in</button>
</form>
<script>
f.onsubmit = async (e) => {
  e.preventDefault(); err.textContent = '';
  const r = await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email.value, password: password.value, oauth_query: location.search.slice(1) }) });
  const j = await r.json().catch(() => ({}));
  if (j.url) location.href = j.url; else err.textContent = j.message || 'Sign-in failed. Check your e-mail and password.';
};
</script>`,
);

export const consentPage = layout(
  'Allow access',
  `<h1>Allow access?</h1><p id="who"></p>
<form id="f"><div id="scopes"></div><p id="err" role="alert"></p>
<button class="primary" id="yes">Allow selected</button> <button type="button" id="no">Deny</button></form>
<script>
const text = ${JSON.stringify(scopeText)};
const on = new Set(${JSON.stringify([...defaultOn])});
const q = new URLSearchParams(location.search);
who.textContent = 'An app (' + (q.get('client_id') || 'unknown') + ') wants to act on your behalf. Choose what it may do:';
const requested = (q.get('scope') || '').split(' ').filter(Boolean);
for (const s of requested) {
  if (!text[s]) continue;
  const id = 'scope-' + s.replace(/[^a-z]/g, '-');
  scopes.insertAdjacentHTML('beforeend', '<label class="scope"><input type="checkbox" id="' + id + '" value="' + s + '"' + (on.has(s) ? ' checked' : '') + '><span>' + text[s] + '<br><code>' + s + '</code></span></label>');
}
const send = async (accept) => {
  const chosen = [...scopes.querySelectorAll('input:checked')].map((i) => i.value);
  const identity = requested.filter((s) => !text[s]);
  const r = await fetch('/api/auth/oauth2/consent', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept, scope: [...identity, ...chosen].join(' '), oauth_query: location.search.slice(1) }) });
  const j = await r.json().catch(() => ({}));
  if (j.url) location.href = j.url; else err.textContent = j.message || 'Something went wrong.';
};
f.onsubmit = (e) => { e.preventDefault(); send(true); };
no.onclick = () => send(false);
</script>`,
);
