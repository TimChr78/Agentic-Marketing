// Server-rendered sign-in and consent pages for the OAuth flow MCP clients use. Small on purpose:
// no build step, no framework. The consent page lets the person choose what the agent may do;
// MCP clients request every advertised scope, so this is where least privilege happens.

import { randomBytes } from 'node:crypto';
import { brandWordmarkSvg } from '@agentic-marketing/core';

const scopeText: Record<string, string> = {
  'artifacts:read': 'Read journeys, templates and other artifacts',
  'artifacts:write': 'Create and edit drafts',
  'artifacts:publish': 'Submit changes for review, or publish directly where the approval policy allows it',
  'artifacts:approve': 'Approve changes (agents can never use this)',
  'messages:send': 'Send e-mails to people (consent, unsubscribes and suppressions are always enforced)',
  'audit:read': 'Read the audit log',
  'profiles:read': 'Read customer profiles and events (personal data stays hidden)',
  'profiles:pii': 'See personal data in profiles, such as e-mail addresses',
  'profiles:write': 'Record consent and update profile traits',
  'profiles:erase': 'Erase people (agents can never use this)',
  'secrets:read': 'See the names of stored secrets (never their values)',
  'secrets:write': 'Store and delete secrets (agents can never use this)',
  'workspace:admin': 'Change workspace settings (agents can never use this)',
};
const defaultOn = new Set(['openid', 'profile', 'email', 'offline_access', 'artifacts:read', 'artifacts:write', 'artifacts:publish']);

/** The product mark on every server-rendered page, so OAuth sign-in and consent look like the app. */
const brandHeader = `<a class="brand" href="/" aria-label="Agentic Marketing">${brandWordmarkSvg({ width: 180, title: '' })}</a>`;

/**
 * A fresh nonce for the one inline script (and style) each server-rendered page carries (#478).
 * The page's CSP allows exactly that nonce, so an injected `<img onerror>` or any later inline
 * handler cannot run even if a value ever reached the HTML.
 */
export const pageNonce = () => randomBytes(18).toString('base64');

export const pagesCsp = (nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

const layout = (title: string, body: string, nonce: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Agentic Marketing</title>
<style nonce="${nonce}">
  :root { --bg:#f7f8fa; --fg:#14171c; --muted:#646c79; --accent:#2457d6; --accent-fg:#fff; --line:#c9ced6; --card:#fff; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1013; --fg:#e7e9ed; --muted:#8d95a3; --accent:#7097f5; --accent-fg:#0e1013; --line:#3a404b; --card:#15181d; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; padding:48px max(16px, env(safe-area-inset-left)); }
  main { max-width: 420px; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; line-height: 28px; margin: 0 0 4px; } p { color: var(--muted); margin: 0 0 18px; }
  label { display:block; margin: 10px 0; } input[type=email], input[type=password], input[type=text], select { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; font:inherit; }
  .hint { font-size: 12px; margin: 4px 0 14px; }
  button { padding: 9px 16px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; font: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 500; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .scope { display:flex; gap:10px; align-items:flex-start; } .scope code { font-size: 12px; color: var(--muted); }
  .brand { display:inline-flex; margin-bottom: 18px; color: var(--fg); text-decoration: none; }
  .brand svg { height: 30px; width: auto; }
  #err { color: #c42b2b; min-height: 1.5em; }
</style></head><body><main>${brandHeader}${body}</main></body></html>`;

export const loginPage = (nonce: string) => layout(
  'Sign in',
  `<h1>Sign in</h1><p>An app wants to connect to your marketing workspace.</p>
<form id="f">
  <label>E-mail<input id="email" name="email" type="email" autocomplete="username" required></label>
  <label>Password<input id="password" name="password" type="password" autocomplete="current-password" required></label>
  <p id="err" role="alert"></p>
  <button class="primary">Sign in</button>
</form>
<script nonce="${nonce}">
f.onsubmit = async (e) => {
  e.preventDefault(); err.textContent = '';
  const r = await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email.value, password: password.value, oauth_query: location.search.slice(1) }) });
  const j = await r.json().catch(() => ({}));
  if (j.url) location.href = j.url; else err.textContent = j.message || 'Sign-in failed. Check your e-mail and password.';
};
</script>`,
  nonce,
);

export const consentPage = (nonce: string) => layout(
  'Allow access',
  `<h1>Allow access?</h1><p id="who"></p>
<form id="f">
<div id="brand"><label>Brand this connection acts in<select id="workspace" required><option value="">Loading your brands…</option></select></label>
<p class="hint">One connection acts in one brand. To let an agent work in another brand, connect it again and choose that brand.</p></div>
<div id="scopes"></div><p id="err" role="alert"></p>
<button class="primary" id="yes">Allow selected</button> <button type="button" id="no">Deny</button></form>
<script nonce="${nonce}">
const text = ${JSON.stringify(scopeText)};
const on = new Set(${JSON.stringify([...defaultOn])});
const q = new URLSearchParams(location.search);
const brandSelect = document.getElementById('workspace');
who.textContent = 'An app (' + (q.get('client_id') || 'unknown') + ') wants to act on your behalf. Choose the brand it may act in and what it may do:';
const requested = (q.get('scope') || '').split(' ').filter(Boolean);
for (const s of requested) {
  if (!text[s]) continue;
  const label = document.createElement('label');
  label.className = 'scope';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 'scope-' + s.replace(/[^a-z]/g, '-');
  box.value = s;
  box.checked = on.has(s);
  const span = document.createElement('span');
  span.textContent = text[s];
  span.append(document.createElement('br'));
  const code = document.createElement('code');
  code.textContent = s;
  span.append(code);
  label.append(box, span);
  scopes.append(label);
}
const chosenScopes = () => [...scopes.querySelectorAll('input:checked')].map((i) => i.value);
const loadBrands = async () => {
  const r = await fetch('/v1/workspace.memberships', { method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' }, body: '{}' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'Could not load your brands.');
  const list = j.workspaces || [];
  if (!list.length) throw new Error('You do not belong to a brand yet. Ask someone to invite you first.');
  // Brand names are people-supplied: build elements and set textContent, never parse HTML (#478).
  brandSelect.replaceChildren(...list.map((w) => {
    const option = document.createElement('option');
    option.value = w.id;
    option.textContent = w.name + ' (' + w.role + ')';
    return option;
  }));
};
loadBrands().catch((e) => { err.textContent = e.message; yes.disabled = true; });
const send = async (accept) => {
  err.textContent = '';
  const chosen = chosenScopes();
  const identity = requested.filter((s) => !text[s]);
  const scope = [...identity, ...chosen].join(' ');
  if (accept) {
    if (!brandSelect.value) { err.textContent = 'Choose the brand this connection acts in.'; return; }
    const brand = await fetch('/api/oauth/workspace', { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: brandSelect.value, scope, oauthQuery: location.search.slice(1) }) });
    const b = await brand.json().catch(() => ({}));
    if (!brand.ok) { err.textContent = b.message || 'That brand cannot be chosen.'; return; }
  }
  const r = await fetch('/api/auth/oauth2/consent', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept, scope, oauth_query: location.search.slice(1) }) });
  const j = await r.json().catch(() => ({}));
  if (j.url) location.href = j.url; else err.textContent = j.message || 'Something went wrong.';
};
f.onsubmit = (e) => { e.preventDefault(); send(true); };
no.onclick = () => send(false);
</script>`,
  nonce,
);

// Invitation links look like /invite#<token>; the token stays out of server logs and Referer headers.
export const invitePage = (nonce: string) => layout(
  'Join workspace',
  `<h1>Join the workspace</h1><p>Sign in, or create an account, with the e-mail address the invitation was sent to.</p>
<form id="f">
  <label id="nameRow" hidden>Name<input id="name" name="name" type="text" autocomplete="name"></label>
  <label>E-mail<input id="email" name="email" type="email" autocomplete="username" required></label>
  <label>Password<input id="password" name="password" type="password" autocomplete="current-password" minlength="10" required></label>
  <p id="err" role="alert"></p>
  <button class="primary" id="go">Sign in and join</button> <button type="button" id="mode">I don't have an account</button>
</form>
<p id="done" hidden></p>
<script nonce="${nonce}">
const token = location.hash.slice(1);
let signUp = false;
mode.onclick = () => {
  signUp = !signUp; nameRow.hidden = !signUp;
  go.textContent = signUp ? 'Create account and join' : 'Sign in and join';
  mode.textContent = signUp ? 'I already have an account' : "I don't have an account";
  password.autocomplete = signUp ? 'new-password' : 'current-password';
};
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }));
const accept = async () => {
  const r = await post('/api/invitations/accept', { token });
  if (!r.ok) { err.textContent = r.body.message || 'Could not accept the invitation.'; return false; }
  f.hidden = true; done.hidden = false;
  done.textContent = 'You joined the workspace as ' + r.body.role + '. You can close this page.';
  return true;
};
f.onsubmit = async (e) => {
  e.preventDefault(); err.textContent = '';
  const r = signUp
    ? await post('/api/auth/sign-up/email', { name: name.value || email.value, email: email.value, password: password.value })
    : await post('/api/auth/sign-in/email', { email: email.value, password: password.value });
  if (!r.ok) { err.textContent = r.body.message || 'Sign-in failed. Check your e-mail and password.'; return; }
  await accept();
};
if (!token) { err.textContent = 'This link has no invitation token. Copy the whole link.'; go.disabled = true; }
</script>`,
  nonce,
);
