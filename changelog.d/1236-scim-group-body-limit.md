---
section: Fixed
issues: [1236]
---
- A SCIM group up to the 50,000 members its schema allows is accepted. The body limit for
  `/scim/v2` was 1 MB, which refused a large group (about 4 MB with the member display names
  Okta and Entra ID send) with 413 before the request ran.
