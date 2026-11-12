---
section: Security
issues: [727]
---
- The auth stack moves to Better Auth 1.7.22 together: `better-auth`, `@better-auth/{core,oauth-provider,sso,mcp,cimd}`, `@better-auth/utils` 0.5.1, `@better-fetch/fetch` 1.3.3, `better-call` 1.4.5 and `jose` 6.2.16. The `pnpm` overrides that held three of those packages at 1.7.7 are gone; the new Dependabot group moves the whole stack in one PR.
- A password reset that fails to save or to revoke the person's sessions no longer keeps the new password or burns the link, so the same link still works.
- OAuth consent is per brand: granting an MCP client access in one brand is no longer reused, or overwritten, by a grant in another.
- Sign-in is stricter with identity providers: OIDC SSO providers whose issuer does not match discovery are refused at registration, and SAML responses are checked against the clock skew and replay protection (including assertion IDs written as XML character references). SAML certificates and callback URLs can now be rotated for accounts that are already linked.
- Revoking the current session or deleting the account now expires the session cookie immediately, and a `"false"` `email_verified` claim no longer counts as verified.
