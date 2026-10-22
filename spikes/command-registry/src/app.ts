import { Hono } from 'hono';
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';
import { auth } from './auth';
import { restApi } from './surfaces/rest';
import { mcpEndpoint } from './surfaces/mcp';

// Minimal sign-in and consent pages for the OAuth flow. In the product these are UI routes.
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;max-width:420px;margin:48px auto">${body}</body>`;

const loginPage = page(
  'Sign in',
  `<h1>Sign in</h1>
<form id="f"><p><input name="email" type="email" placeholder="E-mail" required></p>
<p><input name="password" type="password" placeholder="Password" required></p><button>Sign in</button></form>
<p id="err" style="color:#b00"></p>
<script>
f.onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(f);
  const r = await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: fd.get('email'), password: fd.get('password'), oauth_query: location.search.slice(1) }) });
  const j = await r.json();
  if (j.url) location.href = j.url; else err.textContent = j.message || 'Sign-in failed';
};
</script>`,
);

const consentPage = page(
  'Allow access',
  `<h1>Allow access?</h1><p id="who"></p><p>Requested permissions: <b id="sc"></b></p>
<button id="yes">Allow</button> <button id="no">Deny</button>
<script>
const q = new URLSearchParams(location.search);
who.textContent = 'Client ' + (q.get('client_id') || '') + ' wants to act on your behalf.';
sc.textContent = q.get('scope');
const send = async (accept) => {
  const r = await fetch('/api/auth/oauth2/consent', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }) });
  const j = await r.json(); if (j.url) location.href = j.url;
};
yes.onclick = () => send(true); no.onclick = () => send(false);
</script>`,
);

export function createApp() {
  const app = new Hono();

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // OAuth discovery at the root, where MCP clients look for it (RFC 8414 path insertion included).
  const asMeta = oauthProviderAuthServerMetadata(auth);
  const oidcMeta = oauthProviderOpenIdConfigMetadata(auth);
  app.get('/.well-known/oauth-authorization-server', (c) => asMeta(c.req.raw));
  app.get('/.well-known/oauth-authorization-server/*', (c) => asMeta(c.req.raw));
  app.get('/.well-known/openid-configuration', (c) => oidcMeta(c.req.raw));
  app.get('/.well-known/openid-configuration/*', (c) => oidcMeta(c.req.raw));
  // The MCP plugin answers RFC 9728 metadata itself when it sees the root path.
  app.get('/.well-known/oauth-protected-resource', (c) => auth.handler(c.req.raw));
  app.get('/.well-known/oauth-protected-resource/*', (c) => auth.handler(c.req.raw));

  app.get('/login', (c) => c.html(loginPage));
  app.get('/consent', (c) => c.html(consentPage));

  app.all('/mcp', (c) => mcpEndpoint(c.req.raw));
  app.route('/', restApi());
  return app;
}
