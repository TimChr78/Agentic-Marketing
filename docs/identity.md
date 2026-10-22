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
