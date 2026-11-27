---
section: Fixed
issues: [1233]
---
- SCIM `PUT /scim/v2/Users/{id}` that changes a user's e-mail to one another account already holds
  answers 409 `uniqueness`, as create does, instead of a 500 that the identity provider retries;
  two concurrent replaces that both saw the address free answer the same way.
