# Recipes

Recipes are curated, versioned bundles of artifacts for the marketing loops almost every workspace builds by hand: a welcome journey with double opt-in, a lead-magnet drip, a weekly newsletter and a win-back. A recipe is data, not a hidden workflow: you can read every artifact, parameter and prerequisite before anything is created.

Installing a recipe creates **version 1 drafts** with fresh artifact ids. It never publishes and never sends. Review the drafts (or submit them together with `artifacts.requestPublishBundle`), and the normal approval policy decides what goes live.

## The four initial recipes

| Recipe id | What it creates | Loop |
|---|---|---|
| `welcome-doi` | Confirmation e-mail, welcome e-mail, follow-up, subscriber segment, double opt-in form, welcome journey | Signup → confirm → welcome → wait 3 days → start here |
| `lead-magnet-drip` | Four e-mails and a journey | `Lead Magnet Downloaded` → deliver → teach → prove → invite, four e-mails over 8 days |
| `weekly-newsletter` | Subscriber segment, this issue's template and a broadcast | Draft the issue → review the template and broadcast together → send to the segment |
| `win-back` | Lapsed-customer segment, two e-mails and a journey | Join the lapsed segment → check in → wait 5 days → a way back |

Each recipe has its own defaults, for example the site name, the purpose key, the delays and (for the newsletter) an optional send time. Open one with `recipes.get` to read its docs and review checklist.

## Commands

All four are ordinary commands, so they are also REST endpoints (`POST /v1/<command>`) and MCP tools.

```json
recipes.list {}
recipes.get {"recipeId":"welcome-doi"}
recipes.preview {"recipeId":"weekly-newsletter","params":{"issueTitle":"Issue 47"}}
recipes.install {"recipeId":"weekly-newsletter","params":{"issueTitle":"Issue 47","sendAt":"2026-11-06T07:00:00Z"}}
```

- **`recipes.list`** returns the recipes this server ships, with their parameters and prerequisite count.
- **`recipes.get`** returns one recipe in full: parameters, prerequisites, artifact content, documentation and the review checklist.
- **`recipes.preview`** is read-only. It fills defaults, validates the parameters, checks the prerequisites and resolves the artifacts. References between the new artifacts (a journey's templates, a broadcast's template and segment, a form's confirmation e-mail) are resolved to preview ids so you can see the shape; no row is written, and an install gives the drafts its own fresh ids.
- **`recipes.install`** does the same checks and writes version 1 drafts. Its result lists the new ids, the resolved parameters, the prerequisite results and the checklist its next step names `requestPublishBundle`.

`recipes.preview` and `recipes.install` report each prerequisite separately (`ok`, `description`, `message`). The usual missing one is an e-mail provider: add one in Settings → Providers with `useFor: ["marketing"]`. The other is a purpose with the e-mail channel; the default purposes include `marketing_email`, so a fresh workspace only needs the provider.

## Parameters and placeholders

A recipe's `parameters` declare a key, a type (`string`, `email`, `url`, `number`, `boolean`, `duration` or `datetime`), whether it is required, a default, and optional validation (`minLength`, `maxLength`, `pattern`, `min`, `max`, `options`). The install fills defaults and refuses unknown keys, missing required values and values that fail their type or constraints.

Artifact content uses two placeholder namespaces:

- `{{param.<key>}}` for a parameter value;
- `{{ref.<key>}}` for the id of another artifact in the same recipe, addressed by its local `key`.

A string that is exactly one optional placeholder with no value is **omitted** from the object, so an optional send time becomes "send when published" instead of an empty date. The placeholders are deliberately namespaced: Liquid variables such as `{{ profile.firstName }}` or `{{ unsubscribe_url }}` pass through untouched.

## Versioning and upgrades

A recipe file has an `id` and a `version`. Installing always creates fresh artifact ids, so installing a newer version never overwrites work you have already edited. To move to a newer version, read the newer recipe (`recipes.get`/`recipes.preview`), install it, compare the new drafts with your live artifacts, and publish only the changes you want through the normal review path. Nothing is deleted or replaced by an install.

## For agents

Installing is a `draft` action class: an agent with `artifacts:write` may install drafts. Publishing is not part of a recipe install. An agent submits the drafts it wants live with `artifacts.requestPublish` or `artifacts.requestPublishBundle`, and the workspace approval policy and the agent's mandate decide whether that publishes, waits for a person or is refused. The install result's `next` field says the same thing, and every recipe's `checklist` is written to be read before submitting.

## Recipe files and tests

The shipped recipes live in [`packages/artifacts/recipes`](../packages/artifacts/recipes) as one JSON file each, in the `agentic-marketing/recipe@1` format. `packages/artifacts/src/recipes.ts` defines the schema and the resolver; `packages/artifacts/test/recipes.test.ts` checks that every shipped file matches the schema, that every `{{param.*}}` and `{{ref.*}}` is declared, and that resolving each recipe with its defaults passes the publish-time content validation for every artifact type. `apps/server/test/recipes.test.ts` covers the gallery, the missing-provider prerequisite, installs that publish nothing, and an agent's install followed by the approval path.

A new recipe is a JSON file with `format`, `id`, `version`, `title`, `description`, `parameters`, `prerequisites`, `artifacts`, `docs` and `checklist`. Add it to the directory; the loader picks it up and the tests hold it to the same rules.
