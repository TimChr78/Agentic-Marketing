# Single sign-on, SCIM and agent permissions

## Single sign-on (OIDC, SAML)

People can sign in through the company identity provider (Okta, Entra ID, Google Workspace, Keycloak, Auth0…), with OpenID Connect or SAML 2.0. A provider belongs to one workspace: whoever signs in through it becomes a member with the provider's default role (`admin`, `marketer`, `approver` or `viewer`; owners are made by people).

Owners and admins set up a provider with the auth endpoints (signed in, in the browser or with the session cookie):

```bash
# OIDC: issuer and client credentials from the identity provider; endpoints come from its discovery document.
curl -X POST https://marketing.example.com/api/auth/sso/register -H 'content-type: application/json' -b cookies.txt -d '{
  "providerId": "acme-okta", "issuer": "https://acme.okta.com", "domain": "acme.com",
  "workspaceId": "<workspace id>", "defaultRole": "marketer",
  "oidcConfig": { "clientId": "…", "clientSecret": "…", "pkce": true }
}'
```

- Register `https://marketing.example.com/api/auth/sso/callback/<providerId>` as the redirect URI at the identity provider.
- SAML: pass `samlConfig` (the IdP's `entryPoint`, `cert`, or its metadata XML) instead of `oidcConfig`; the service provider metadata is at `/api/auth/sso/saml2/sp/metadata?providerId=<providerId>` and the assertion consumer service at `/api/auth/sso/saml2/sp/acs/<providerId>`.
- **Domain verification** (on by default): before anyone signs in through a provider, prove the domain with a DNS TXT record. `POST /api/auth/sso/request-domain-verification {providerId}` returns the token to publish; `POST /api/auth/sso/verify-domain {providerId}` checks it. This stops a workspace from claiming another company's domain. `SSO_DOMAIN_VERIFICATION=false` turns it off for development only.
- **Enforcing SSO:** `POST /api/auth/sso/update-provider {providerId, enforced: true}` turns off password sign-in and sign-up for the provider's (verified) domain.
- Identity providers on private addresses (a Keycloak on the company network) must be listed in `TRUSTED_ORIGINS`.
- `sso.list` shows a workspace's providers (also to agents with `workspace:admin`). People sign in at `/login` with "Sign in with SSO" (`POST /api/auth/sign-in/sso {email}`).

## SCIM provisioning

With SCIM 2.0 the identity provider creates, updates and deactivates members as the company directory changes.

1. `scim.configure {defaultRole, groupRoles}`: the role new people get, and which identity-provider groups map to which roles (`{"Marketing Admins": "admin", "Marketing": "marketer"}`; the highest role wins).
2. `scim.rotateToken`: the bearer token, shown once.
3. In the identity provider: SCIM base URL `https://marketing.example.com/scim/v2`, authentication "HTTP header / bearer token", and push users and groups.

Supported: `Users` and `Groups` with list (`filter=userName eq "…"`, `externalId`, `displayName`), get, create, replace, `PATCH` (add, replace, remove, in Okta's and Entra ID's forms) and delete; `ServiceProviderConfig` and `ResourceTypes`. Deactivating or deleting a person removes them from the workspace (their account and other workspaces stay). Owners are never changed by SCIM. While SCIM is on, single sign-on no longer adds members by itself: the directory decides. Every change is in the audit log with surface `scim`.

## Agents asking for more permissions (scope step-up)

An MCP client gets the permissions the person granted when connecting, at most what the person's role allows. Tools the role allows but the connection lacks are still listed, marked "Needs the … permission". Calling one answers HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, which MCP clients answer by sending the person through authorization again for the larger set of scopes. API tokens have fixed scopes and do not step up.

## Password reset (#191)

Anyone who signs in with a password can reset it from the sign-in page ("Forgot password?"), without shell access:

1. `/forgot-password` asks for the e-mail address and posts it to `POST /api/auth/forgot-password` (Better Auth's own `POST /api/auth/request-password-reset` does the same and is rate limited alike).
2. The answer is always the same — "If an account exists for that address, we sent a link to reset the password." — whether or not the address is known, whether or not a sender is configured, and whether or not the person uses single sign-on. Only a known password account gets mail.
3. The link goes to `<PUBLIC_URL>/reset-password?token=…` and expires after **45 minutes**. The page asks for the new password twice (at least 10 characters, `autocomplete="new-password"`) and posts it to `POST /api/auth/reset-password` with the token. The server answers `Referrer-Policy: no-referrer` for `/reset-password`, so the token in the query string is not sent on to any other request.
4. A successful reset **revokes every session of that person**: any other browser has to sign in again. API tokens and connected MCP clients are *not* revoked — they are separate credentials with their own scope, listed and revocable under Settings → Integrations. An expired, used or malformed link gets a clear message and a link to request a new one; a token works exactly once.
5. Requesting another link inside a **60-second cooldown** is accepted neutrally but sends nothing. A later request issues a new link; the earlier link keeps working until it is used or expires.

**Where the mail comes from.** The flow is installation-level: the link points at `PUBLIC_URL`, never at a brand's domain. The sender is the transactional e-mail provider of the person's **oldest workspace** (the one they have been a member of longest), so it is a sender they belong to and never a stranger's brand. A person who belongs to several brands gets one link, not one per brand. If none of their workspaces has an enabled transactional provider, the request is still answered neutrally and the server logs an operator warning; the CLI below remains the fallback.

**Single sign-on.** People whose domain has an enforced SSO provider, and accounts without a password (SSO or SCIM provisioned), get no reset mail: a password would not sign them in anyway (`ssoGuard` refuses password sign-in for that domain). They sign in with "Sign in with SSO".

**Rate limits and audit.** Per IP, 5 link requests per 15 minutes; per address, 3 per hour plus the 60-second cooldown; per IP, 10 reset submissions per 15 minutes. All buckets live in Valkey and are shared by every server process. Each request and each completed reset appends an entry to the workspace audit log (surface `internal`, command `auth.passwordResetRequest` / `auth.passwordReset`) with the person, the time, the outcome and the IP in the audit log's `ip` column (migration `0066_password_reset.sql`) — never the token or the password. A person without a workspace is only in the server log (the audit log is per workspace).

**Break-glass.** `am reset-password --email you@example.com` (with `AM_RESET_PASSWORD`, a hidden prompt or stdin) still sets a password from the server, for owners with container access and when mail is broken. It is not a user-facing path.
