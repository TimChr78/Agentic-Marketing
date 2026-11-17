---
section: Changed
---
- Runs on Node.js 26 LTS ("Lithium") instead of Node.js 22, which reaches end of life sooner: the
  Docker image, every CI job, `engines` and the documented prerequisites move to 26, and the web
  and CLI builds target it. **Custom images and hosts that build or run the app themselves must
  move to Node.js 26 before upgrading**; the released images and Compose installs already do.
- Node 26 no longer bundles corepack, so the image and CI install pnpm from npm at the version in
  `packageManager`. Nothing changes for a released image or a Compose install.
