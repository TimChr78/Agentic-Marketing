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

## One brand per token or connection (#187)

A brand is a workspace. A person can belong to several and switch between them in the admin UI, because their **session** carries a workspace chosen with `X-Workspace-Id`. Credentials are different: an API token and an OAuth/MCP connection each belong to exactly one brand.

- **API tokens.** `apiTokens.create` stores the workspace in the token row. Every request acts in that workspace; the token list shows the brand, and the create dialog offers each brand whose role can grant the chosen scopes. To let a tool work in a second brand, create a second token there. The UI offers that as one step: choose the brand in the create dialog.
- **OAuth consent.** When the person belongs to several brands, the consent page asks which brand the client acts in. The choice is checked against their membership and role (the role must be able to grant the requested scopes), then stored on the grant as its reference id. The issued access token carries a `workspace_id` claim; refresh tokens keep it. A connection issued before this change, or a direct consent that made no choice, has no claim and is refused when the person belongs to more than one brand: reconnect and choose.
- **The header.** `X-Workspace-Id` switches a person's session and nothing else. Sending it on a request authenticated with an API token or an OAuth connection that belongs to another brand answers `403` with a clear message rather than silently ignoring the header. A token or MCP client therefore cannot read or write another brand, with or without the header.
- **Commands and audit.** `workspace.get` returns the bound brand, and `workspace.memberships` returns only that brand to a credential; a person still sees all their memberships. Token creation, edits and revocation are in the audit log under the token's workspace with the token id as the target (`token:<id>` identifies the caller on every subsequent call).

Agents and MCP clients are described in [agents.md](agents.md); the connection steps are in [integrations.md](integrations.md).

## Password reset (#191)

Anyone who signs in with a password can reset it from the sign-in page ("Forgot password?"), without shell access:

1. `/forgot-password` asks for the e-mail address and posts it to `POST /api/auth/forgot-password` (Better Auth's own `POST /api/auth/request-password-reset` does the same and is rate limited alike).
2. The answer is always the same — "If an account exists for that address, we sent a link to reset the password." — whether or not the address is known, whether or not a sender is configured, and whether or not the person uses single sign-on. Only a known password account gets mail. The request path is account-agnostic: it seals the normalized address with a purpose-separated key derived from `AUTH_SECRET` and inserts one durable row, with no account lookup, token generation, tenant data key or provider call. The worker then looks the address up, re-checks eligibility, mints Better Auth's token and sends. Every syntactically valid address therefore does the same bounded local crypto and the same single write, so response timing cannot distinguish a password account from an unknown or single sign-on address.
3. The link goes to `<PUBLIC_URL>/reset-password?token=…` and expires after **45 minutes**. The page asks for the new password twice (at least 10 characters, `autocomplete="new-password"`) and posts it to `POST /api/auth/reset-password` with the token. The server answers `Referrer-Policy: no-referrer` for `/reset-password`, so the token in the query string is not sent on to any other request.
4. A successful reset **revokes every session of that person**: any other browser has to sign in again. API tokens and connected MCP clients are *not* revoked — they are separate credentials with their own scope, listed and revocable under Settings → Integrations. An expired, used or malformed link gets a clear message and a link to request a new one; a token works exactly once.
5. Requesting another link inside a **60-second cooldown** is accepted neutrally but sends nothing. A later request issues a new link; the earlier link keeps working until it is used or expires.

**Delivery.** The request is a row in the durable `password_reset_deliveries` outbox; the **worker** role resolves the account, re-checks eligibility, mints the token through Better Auth's verification adapter and sends. A provider failure is retried with backoff (10 s, 30 s, 60 s) up to four attempts. Each attempt claims one row with a unique lease id immediately before its own send, and every retry, settle and token wipe is fenced by that id, so a worker whose lease was taken over cannot rewrite the successor's outcome; a stale `sending` row is retried after ten minutes and the attempt count still holds. Delivery is **at least once**: a crash after the provider accepted a message but before the row was settled can resend that link. Settled rows keep only the outcome; the sealed address and token are wiped. Unprocessed rows expire and are wiped after 24 hours, and terminal rows are pruned after seven days. That cleanup runs in the worker, so a deployment that runs no worker role never sends and never cleans up (keep at least one worker). A queued request is re-checked immediately before delivery, so a person who became single sign-on only, lost the password credential, or whose link expired or was already used gets no mail. Pending retry tokens are revoked when eligibility or address ownership changes, including after an ambiguous provider failure.

**Where the mail comes from.** The flow is installation-level: the link points at `PUBLIC_URL`, never at a brand's domain. The sender is the transactional e-mail provider of the person's **oldest workspace** (the one they have been a member of longest), so it is a sender they belong to and never a stranger's brand. A person who belongs to several brands gets one link, not one per brand. If none of their workspaces has an enabled transactional provider, the request is still answered neutrally and the server logs an operator warning; the CLI below remains the fallback.

**Single sign-on.** People whose domain has an enforced SSO provider, and accounts without a password (SSO or SCIM provisioned), get no reset mail: a password would not sign them in anyway (`ssoGuard` refuses password sign-in for that domain). They sign in with "Sign in with SSO".

**Rate limits and audit.** Per IP, 5 link requests per 15 minutes; per address, 3 per hour plus the 60-second cooldown; per IP, 10 reset submissions per 15 minutes. All buckets live in Valkey and are shared by every server process. If any required bucket is unavailable, reset requests and submissions return the same generic `503 RATE_LIMIT_UNAVAILABLE` for every account class; no request is queued and no reset is forwarded while the shared limits are unavailable. The worker appends the request outcome to the workspace audit log (surface `internal`, command `auth.passwordResetRequest` / `auth.passwordReset`) with the person, the time, the outcome and the IP in the audit log's `ip` column (migration `0066_password_reset.sql`) — never the address, token or password. A person without a workspace is only in the server log (the audit log is per workspace); an unknown address has no account to attribute, so it appears only as a queue outcome. Without a running worker there is no delivery outcome and no request audit entry.

**Break-glass.** `am reset-password --email you@example.com` (with `AM_RESET_PASSWORD`, a hidden prompt or stdin) still sets a password from the server, for owners with container access and when mail is broken. It is not a user-facing path.

## Brands and domains (#186)

A **brand is a workspace**. Memberships, the `X-Workspace-Id` header, row-level security and the
workspace switcher already separate brands; a domain only decides which workspace a public request
belongs to. One installation keeps **one admin host** (`PUBLIC_URL`) where people sign in and switch
brand; each brand may have its own public links hostname.

Data follows the same boundary: the same e-mail address can be two profiles, an unsubscribe or
suppression applies only inside its brand, and erasure and export are repeated per brand. The full
list is in [Multiple brands on one instance](architecture/security-and-privacy.md#7-multiple-brands-on-one-instance).

### Create a brand from the admin UI (#190)

`workspace.create` makes another brand in the same installation. It is **people-only and audited**,
and a person may call it only when they are **owner of at least one workspace**. Being an admin or
member of the workspace they are currently viewing is not enough; the rule is about ownership
anywhere in the installation, because the new brand is theirs, not the current brand's. Owners,
admins, marketers and viewers who own no brand get `403`.

One person may own at most `WORKSPACE_QUOTA` brands (default 10), counted across the installation
by owner memberships; past that, `workspace.create` answers `403` with the limit and the variable to
raise. The cap keeps one compromised owner session or a runaway script from filling the shared
tables and the `workspace_domains` registry with pending claims.

The call takes a name and optional brand basics:

```json
{
  "name": "Second site",
  "primaryDomain": "links.second.example",
  "pathPrefix": "/am",
  "siteName": "Second site",
  "logoUrl": "https://cdn.second.example/logo.svg"
}
```

In **one transaction** it creates:

- the workspace row, with the same database defaults as `am bootstrap` (approval policy
  `agent_changes`, UTC, an empty seed list and the default autonomy), so a brand created in the UI
  and one created from the CLI cannot drift;
- the caller's `owner` membership;
- a **draft** `brand` artifact with the site name and logo (publish it under Design → Brand when it
  is ready; the switcher shows the workspace name until then);
- when a host is given, a **pending** primary `workspace_domains` row with its verification token.

A duplicate hostname, an invalid logo URL or any other failure rolls all of it back; no half-created
brand is left. The domain is not used for links until `workspace.domains.verify` succeeds, exactly
like one added with `workspace.domains.add`. Nothing is copied from the brand the person came from:
content, audiences, providers and secrets are all new and empty (cloning is a separate decision).

API tokens and OAuth/MCP connections are agents, so they can never call `workspace.create`. The
admin UI shows **New brand** in the switcher only when at least one of the person's memberships is
an owner.

### Register a domain

`workspace.domains.add/update/remove/verify/list` are people-only (`workspace:admin`) and audited. A
domain is a normalised hostname plus an optional path prefix:

- lowercase IDNA hostname, without scheme, port or trailing dot; wildcards, userinfo, queries and
  fragments are refused. A port is refused too rather than silently dropped: links use `https` on
  443 (`http` on localhost), so `https://example.com:8443` and `http://localhost:3000` are input
  errors (#481);
- `https` everywhere, or `http` only on localhost;
- an optional leading-slash prefix such as `/am`, for a site that proxies `/am` to this instance;
- **a hostname belongs to one workspace**: another workspace cannot register any prefix on a host
  that is already claimed or verified, and the same workspace may have one **primary** domain.
  `workspace.get` returns the workspace's `domains` and its effective `linksUrl`; only a **verified**
  primary domain appears as `primaryDomain` in `workspace.get` and `workspace.memberships` (#465);
- an unverified claim holds its hostname for **7 days**. After that another workspace may register
  the same host and prefix, which replaces the expired claim (#467). Verified domains never expire.

The admin host (`PUBLIC_URL`) and the fallback links host (`PUBLIC_LINKS_URL`) are **reserved
installation-wide** and can never be registered as a brand domain (#480): they belong to the
installation, not to one brand.

Normalisation runs before the row is written, so `MartechSignal.COM` and `martechsignal.com` are the
same host, and `/am/` and `am` are the same prefix. Host resolution for a request (before any
workspace is known) reads the registry installation-wide and picks the **longest matching path
prefix**, so several prefixes on one brand's host can coexist. Once any domain has been verified, an
unknown host on a public path is answered with 404; admin routes keep using the session and
`X-Workspace-Id`. That switch is an installation policy and stays on even if the last verified domain
is later removed (#463).

### Verify a domain

A new domain starts **pending** and is listed but inactive: it resolves no requests and supplies no
links until it is verified. This stops a typo, or a hostname someone else controls, from taking
another brand's traffic.

1. Register it: `workspace.domains.add {host, pathPrefix?, isPrimary?}`. The returned row carries a
   `verificationToken`.
2. Point the hostname at the tunnel or ingress, and confirm the public listener serves the challenge:
   `GET https://<host><prefix>/.well-known/am-domain/<verificationToken>` must answer `200` with the
   token. The challenge is answered even while the domain is pending, and on any Host.
3. Run `workspace.domains.verify {id}`. The server fetches the same URL through the shared egress
   guard (timeboxed, at most 4 KiB read, no redirects; plain http only on localhost), compares the
   body with the token, and sets `status: "verified"` and `verifiedAt`. A private, link-local or
   metadata address is refused unless the hostname is listed in `EGRESS_ALLOWED_HOSTS`, like any
   other outbound target. A wrong token, a non-200 answer or an unreachable host is refused without
   repeating the internal error or HTTP status: the caller only learns that the challenge could not
   be reached or did not answer with the token (#466).

Only verified domains are used for request resolution and `linksUrlFor`. Changing a domain's host or
prefix resets it to pending, so verify it again before it serves. Removing the primary domain makes
the workspace fall back to `PUBLIC_LINKS_URL`.

### Verification and the resolver cache

Domain writes invalidate the resolver in the process that ran the command. Every other server
process (api, ingest, worker, replicas) reads its own cache and picks the change up within the
**5-second TTL**, which is the cross-process bound; an in-flight load cannot repopulate the cache
with rows read before an invalidation (#464).

### One tunnel hostname per brand

Point each brand's DNS at the tunnel or ingress, and give the tunnel one hostname per brand:

| Brand | Public host | Path prefix | Primary |
|---|---|---|---|
| Martech Signal | `links.martechsignal.com` | — | yes |
| Second site | `second.example.com` | `/am` | yes |

The certificate must cover every registered hostname. A wildcard certificate (`*.example.com`) can
cover several brands under one parent, but a brand on another domain needs its own name on the
certificate. The public listener (`PUBLIC_PORT`) is the safe target for these hostnames; it serves
only `/f`, `/u`, `/c`, `/a`, `/n`, `/hooks`, `/healthz` and `/readyz`.

With a path prefix, the proxy forwards `/am/*` unchanged, so the public paths are
`https://second.example.com/am/f/<form id>`, `/am/u/...`, `/am/n/...`. Health checks move with it:
`https://second.example.com/am/healthz`.

### What a brand host serves

Every public request resolves its `Host` and path prefix to one workspace before routing:

- a verified registered domain → that workspace;
- the host (and prefix) of `PUBLIC_LINKS_URL` → the installation fallback, exactly as before;
- any other host → `404`, never the admin UI and never another brand's page.

Until the first domain is verified, the installation keeps its old behaviour: public paths answer on
any `Host`, so an upgrade does not break a proxy that rewrites `Host` or a LAN address used for
testing. Verifying a domain switches the check on for every host, and it stays on even after the last
verified domain is removed (#463).

`/f`, `/u` (including `/u/p`), `/c`, `/a`, `/n` and `/hooks` all obey this. A signed token, form,
archive slug, asset id or provider webhook belongs to a workspace, so presenting it on another
brand's host is refused with `404` — never redirected to the brand that owns it. The archive resolves
the brand by host first, then the slug inside that workspace; RSS, sitemap and issue URLs use the
brand's host. Path prefixes are stripped before routing and A's `/am` links stay under
`https://host/am/...`.

The same rule builds links: confirm, unsubscribe, preference centre, `List-Unsubscribe`, the
`/n/w/…` web version, archive pages, form actions, asset URLs and provider webhook URLs use
`linksUrlFor(workspaceId)` — the workspace's verified primary domain, else `PUBLIC_LINKS_URL`. The
signed token format is unchanged; only the base URL follows the brand.

### Fallback and upgrades

`PUBLIC_LINKS_URL` remains the fallback and is not removed. A workspace with no primary domain uses
it exactly as before, which keeps a single-brand install byte-for-byte identical after upgrading:
there is no SQL backfill, because the current URL is configuration rather than data. The fallback
host is reserved and cannot be registered by a workspace (#480); give the default brand its own
hostname if it should appear in the registry. If several workspaces exist and some have no primary
domain, `am doctor` warns that their links still use `PUBLIC_LINKS_URL`.

### `am doctor`

For each registered domain, `am doctor` checks that DNS resolves, that `https://<host><prefix>/healthz`
(or the public listener's path) answers, and that the TLS certificate is valid. A pending domain is
reported as inactive with the verification step. It warns when a registered host is the admin host,
when a multi-brand install has brands without a verified primary domain, and when a host uses a
reserved or private suffix. The checks are short and timeboxed like the other network checks; a fresh
install with no domains reports that links use `PUBLIC_LINKS_URL`.
