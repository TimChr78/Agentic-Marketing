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

## Navigation and pages (#34)

### D8. Information architecture: two additions to the brief's list
- **Options:** exactly the brief's entries; add AI prompts and Preferences.
- **Why:** AI prompts are artifacts that journeys use and had a 0.1 screen; leaving them only in search
  would hide a feature, so they sit last under Build. Settings → Preferences (theme, your permissions in
  plain words) is open to every role; everything else under Settings stays admin-only as specified. SMS,
  push and AI providers share Settings → Providers with e-mail, so "providers" means one page.

### D9. Hide what a role can't use, and explain deep links instead of 403s
- **Options:** disable with a tooltip; hide.
- **Why:** The brief says hide or disable and never offer an action that 403s. Nav entries and actions are
  hidden by the permission of the command they run; a deep link to a page the role can't open shows "Your
  role can't open this page" with the role named. Read-only roles see content with controls read-only.

### D10. One generic artifact page; type editors plug into it
- **Options:** a bespoke page per type; one detail page with type-specific editors and previews.
- **Why:** Every artifact must have content, preview, versions, diff, state, who changed what and the
  role-allowed actions. One page guarantees that for all 16 types (including ones without an editor, which
  get the JSON editor that agents also use), and the editors stay small. Previews are shared with the
  approval drawer, so reviewers and builders see the same thing.

### D11. Author names on versions and in the audit log (additive output)
- **Options:** resolve names in the browser (needs member lists the role may not read); add names server-side.
- **Why:** "Who changed what" must read "Hermes (Sam Rivera)", not `token:tok_…`. `artifacts.history` and
  `artifacts.get` now return `by` (person, token with owner, or OAuth client) next to the raw `author`;
  `audit.list` returns `actorName` and takes an optional `target` filter; `secrets.list` returns
  `updatedByName`. All additive.

## Approvals (#41, #48)

### D12. "Not yet viewed" is tracked per person on the device
- **Options:** a server table of review views (migration, new command); browser storage keyed by person,
  approval and version.
- **Why:** It is a reviewing aid that gates batch approve in the UI, not an audit record (the approval
  itself is audited). It is per version, so a new version is "not yet viewed" again. Agents cannot approve
  at all, so nothing is lost if a person clears their browser; they just open the preview again.

### D13. The review link is `/approvals/<id>` on `PUBLIC_URL`
- **Options:** a query parameter on the list; a path.
- **Why:** A path survives copy/paste in chat tools and works with the SPA fallback. `requestPublish`
  returns `reviewUrl` and `next`; `approvals.list` returns `reviewUrl` for each request.

### D14. After a decision, the drawer moves to the next pending request
- **Why:** Reviewers work through a queue; closing and reopening for each item is friction. The list and
  the nav badge refresh after every decision.

## Providers, tokens and secrets (#40, #44, #36)

### D15. Provider fields come from the adapter schemas, plus a docs link per adapter
- **Why:** The form asks exactly what the server validates; validation errors map back to the named field.
  Adapters gained `docsUrl` and field descriptions (additive). Credentials are never pre-filled; on edit,
  filling any credential replaces them all, as the API already did.

### D16. Token edits: admins only, step-up by password, applied on the next request
- **Options:** as specified (humans-only, `workspace:admin`); also let owners of tokens edit their own.
- **Why:** As specified. Narrowing applies immediately because principals are resolved per request. A token
  narrowed while an MCP session is open gets a JSON-RPC tool error ("This API token does not have …"), not
  an HTTP 403, so clients such as Hermes keep their session instead of treating it as an auth failure.
  People who sign in only with SSO have no password; widening tells them to ask an admin with one.

### D17. Secrets are listed by name, never shown; rotate = set again
- **Why:** The API never returns values; the screen says so and offers Rotate (same name, new value).

## Hosted pages and assets (#37, #35)

### D18. The brand is a singleton artifact that goes through review
- **Options:** workspace settings (admin-only, unversioned); an artifact.
- **Why:** The brand changes what subscribers see, like a template, so it gets versions, diff and approval,
  and agents can draft it. A form may override parts of it (`hostedPages`). The renderer is shared by the
  public routes and the preview, so the preview is exact. Previews disable the button but no longer fade
  it, so colours can be judged.

### D19. Assets are stored in Postgres and served from `/a/<id>/<file>` on the links host
- **Options:** S3-compatible storage (another service to run); Postgres `bytea` with a 5 MB default limit.
- **Why:** Pilot sites use a few logos and images; Postgres keeps backups and RLS in one place and adds no
  service. Responses are immutable and cacheable (ETag, long max-age), so a CDN in front takes the load.
  Bytes are sniffed, not trusted from the declared type. SVG is accepted after sanitising against an
  allow-list: only drawing elements and presentation attributes survive, scripts, event handlers,
  external `href`/`url()` and DOCTYPEs do not, and the upload reports what was removed. That is safe
  because the sandbox CSP and `nosniff` still guard a directly opened file, `<img>` never runs an SVG's
  scripts, and `/a` is on the public listener only. The original SVG is served to hosted pages; a PNG
  rendition at 2× (capped at 2000 px) is stored with the asset and used in e-mail, where SVG does not
  render. Usage is found by the asset id in latest and published artifact versions, and delete warns
  with the list.

### D28. `confirmedUrl` is optional; the confirm page allows its origin in `form-action` (0.2.2, #115)
- **Options:** render the confirmed page and link (or meta-refresh) to the site; keep the 303 and widen
  `form-action` per response; make `confirmedUrl` optional.
- **Why:** Chromium applies `form-action` to the redirect after a form POST, so `form-action 'self'` blocked
  the 303 to the site's welcome page after the confirmation was already recorded. The 303 is kept (no
  extra click, no meta-refresh, which a strict CSP would also have to allow), and only the confirm page adds
  the origin of its own form's `confirmedUrl`; every other directive stays as it was. Without
  `confirmedUrl` the POST answers 200 with the branded confirmed page in place, like unsubscribe already
  did, so that page from #37 is finally served. Unsubscribe and expired never redirect, so they keep
  `form-action 'self'`. The REST/MCP change is additive: forms that set `confirmedUrl` behave as before.

## Journey builder (#33)

### D20. Outcomes are positional; removing a middle one points it at a new Exit
- **Why:** In the stored JSON `next[0]` is "yes", `next[1]` is "no" (and so on for waits, splits and AI
  options). Removing the first outcome by shifting the array would silently turn "no" into "yes". The
  builder instead points the removed outcome at a new Exit step and says so. Outcomes connect in order.

### D21. Autosave on the journey builder only
- **Why:** The canvas produces many small edits; saving each a moment later (one draft version, not one per
  edit) keeps work safe. Other editors keep an explicit Save, because their changes are deliberate and a
  half-typed subject should not become a draft. Autosave never overwrites someone else's newer version (412).

### D22. Keyboard paths for everything on the canvas
- **Why:** Drag and drop is not accessible on its own: the palette buttons add a step after the selected
  one, the inspector's "Continues to" selects connect steps, Delete removes the selection (steps and focused
  connections), Shift+F10 opens the context menu, Ctrl+Z / Ctrl+Shift+Z undo and redo, and the steps are also
  listed as text.

## API (#49, #50, #51, #45)

### D23. Unknown input keys: warn first, strict by flag
- **Why:** As specified. The executor walks the input schema (unions, records and wrappers included) and
  lists every unknown key path with the keys allowed there. Default: log and return `warnings`; with
  `STRICT_INPUTS=true`: `invalid_input` naming the key. MCP passes raw arguments to the executor so the
  SDK can't strip them first.

### D24. MCP results: full JSON text by default, summary by flag; output schemas everywhere
- **Options:** switch to a short summary; keep JSON.
- **Why:** Clients that only read `content[0].text` (as Hermes did) would lose data if it became a summary.
  `MCP_TEXT_CONTENT=summary` is opt-in. Every tool now declares `outputSchema` (allowing the optional
  `warnings`), so clients can use `structuredContent` directly.

### D25. Date-times accept offsets and are stored in UTC; the UI picks in the workspace time zone
- **Why:** `isoDateTime` accepts `Z` or `±hh:mm`, rejects a time without a zone with an example, and
  normalises to UTC. Workspaces gained a time zone (migration 0023, default `UTC` so nothing changes until
  an admin sets it); the UI shows dates and the send-time picker in it and sends ISO with the offset.

### D26. `MCP_TOOL_NAME_STYLE=underscore` added; id formats unchanged
- **Why:** The underscore style was a small, contained change (tool name mapping in one place), so it is
  in, off by default. Item 10 of #45 (workspace ids are UUIDs while artifacts use prefixed ids) is noted
  only: changing workspace ids would touch every table, token and URL for no functional gain.

## How the work was done

### D27. Delegated pieces
- Backend for #48–#51 and #45 item 4, #44 and #41's review data, #35's storage and commands, and #37's
  renderer, and these UI pieces were delegated to DeepSeek V4.1 Flash via OpenCode with written briefs,
  then reviewed, merged and fixed here: settings pages (secrets, users, policy, purposes, workspace,
  preferences), audience and insights pages, the form and segment editors, SMS/push/AI providers, webhooks
  and connections, and the ports of the copilot, broadcast sending status, prompt tests and experience
  results. The shell, design system, approvals, providers, tokens, assets, brand, templates and the journey
  builder were written directly.

## Parked (needs the owner)

1. **"Send me a test" for approvers — decided in 0.2.1 (#53): option 2.** The approval drawer offers it
   to roles with `artifacts:write` (owner, admin, builder). The built-in approver role lacks it, and giving
   approvers full test sends would change who can send (pause rule 2), so `templates.sendTest` and
   `broadcasts.sendTest` also accept `artifacts:approve` when `to` is omitted: the caller is the only
   recipient. Passing `to` (even the caller's own address) still needs `artifacts:write`, and agents never
   get the alternative, so an approver's token cannot use it.
