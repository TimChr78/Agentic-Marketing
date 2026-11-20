---
section: Security
issues: [1129]
---
- SCIM provisioning can no longer take over an account. A workspace's identity provider may not change the global e-mail address or name of a person who also belongs to another workspace or owns one, and it may not replace, patch or delete that workspace's owner at all (`PUT`, `PATCH` and `DELETE` answer 403). Creating a user whose e-mail already has an account links it only when the address's domain is a verified single sign-on domain of that workspace; otherwise the request fails with a 409 `uniqueness` error, while `active` and `externalId` changes still apply.
