---
section: Fixed
issues: [552]
---
- A demo `Select` no longer drops a caller's `aria-description` when the control is unrestricted, and a restricted select ignores a change event instead of running its command.
- The `nodemailer` copy used by the development SMTP server is now 10.1.4, closing three Dependabot advisories; the runtime copy already used a patched version.
