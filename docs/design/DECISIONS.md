# v0.2.0 decisions

Calls made while building v0.2.0 (UI and UX overhaul) without the owner in the loop. Each has the options
considered and why. Anything that needed the owner's decision is listed under **Parked** at the end.

## Foundation

### D1. Branch from `main` after 0.1.2 was merged
- **Options:** branch from `pilot-0.1.2`; branch from `main`.
- **Why:** `main` already contains the 0.1.2 merge (PR #47), so `ui-0.2` from `main` has every 0.1.2 fix
  (tracking warnings, test sends, MCP guide) that the issues build on.

### D2. System font stack, no web fonts
- **Options:** keep Google Fonts (Bricolage Grotesque, IBM Plex); self-host Inter (`@fontsource`, OFL-1.1);
  system UI stack.
- **Why:** The admin UI made third-party requests to Google on every load. That's a poor fit for a
  privacy-first product and fails on offline homelab installs. Inter's licence (OFL) is outside the
  MIT/Apache/BSD/ISC list, so it would have needed the owner's sign-off. The system stack is fast and
  legible, and it is what Linear-, Stripe- and GitHub-style consoles fall back to.

### D3. One accent (blue `#2457d6` / `#7097f5`); agent work marked by icon and label, not colour
- **Options:** keep cobalt plus amber "agent" colour; one accent and no agent colour.
- **Why:** The brief asks for one accent used sparingly, with status colours carrying meaning only. Amber
  already means "needs attention", so an amber agent colour made agent drafts look like warnings. An agent
  is an identity, not a status, so it gets a bot icon and the word "Agent".

### D4. Journey categories are the only categorical palette
- **Options:** monochrome nodes; colour per kind (14 kinds); colour per category (7).
- **Why:** #33 asks for colour coding, and seven categories are learnable. Each colour comes with an icon,
  a label and a legend, so colour is never the only cue. Kept out of status pills to avoid clashes.

### D5. Theme stored per user on the device, applied before first paint
- **Options:** server-side user preference (new table + command); `localStorage` per user id.
- **Why:** A theme is a device preference (people use dark on a laptop, light on a phone in daylight), needs
  no migration and can be applied by an inline script before React loads, so there is no flash. The key
  includes the user id so shared devices keep separate choices.

### D6. Router: small in-house history router instead of a dependency
- **Options:** React Router (MIT), TanStack Router (MIT), wouter (Unlicense), hand-written.
- **Why:** The UI needs path matching, links, `navigate`, params and a not-found route. That's about 100
  lines. Unlicense is outside the permitted list, and the larger routers bring loaders and data APIs we
  don't use. Revisit if nested layouts or data loading grow.

### D7. The demo lives at `/demo`, lazily loaded, never in the signed-in shell
- **Options:** drop the demo from the image; separate build only; `/demo` route in the same build.
- **Why:** Tim asked that the demo not show during normal sign-in or after it. `/demo` keeps it one link
  away for signed-out visitors ("Try the demo" on the sign-in page). Its code is a separate chunk that
  the workspace never loads. The single-file demo build (`build:demo`) keeps working for the shareable link.
  Development (`pnpm dev:web`) now shows the real app at `/`, like production.
