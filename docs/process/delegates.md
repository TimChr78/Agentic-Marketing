# Phase workflow with delegate tasks

How a phase moves from plan to release when several delegate tasks (subagents) build it in
parallel. The integrator is the agent running the phase; delegates are the agents writing one task
each. The aim is to let CI validate every task on its own as soon as it exists, and to keep shared
files out of the way of parallel work.

## Branches and pull requests

```
main
 └── feat/phase-<n>                 phase branch: the integration point
      ├── <task branch>  →  draft PR into feat/phase-<n>  →  CI  →  review  →  merge
      └── …
 └── PR feat/phase-<n> → main       one full review and CI run, then the release
```

1. **Plan.** Open the tracker and task issues, write the contracts (`docs/design/phase-<n>/`) and
   the ownership map, create `feat/phase-<n>` from `main` and push it.
2. **Dispatch.** Each delegate works in its own worktree, branched from the pushed phase branch, on
   the files its task owns. It commits; it does not push.
3. **Open a draft PR per task.** When a delegate reports, the integrator runs
   `scripts/open-task-pr.sh <task-branch> feat/phase-<n> <issue> "<title>"`. CI runs on the task
   alone, in parallel with the others; there is no local full-suite run per task.
4. **Review and merge into the phase branch.** The integrator reads the diff, checks the delegate's
   evidence, marks the PR ready and merges it once CI is green. Conflicts surface per PR, not in one
   batch. `Closes #` in a PR into a phase branch does not close the issue; the release does
   (`scripts/release/close-issues.mjs`).
5. **Integrate.** After the last task: the phase-level checks that need everything together (browser,
   axe and visual baselines on a fresh seed, reviewed by a person), the independent review, then one
   PR from the phase branch to `main`.
6. **Release** with the release scripts (see `docs/development.md`, “Releasing”).

## Shared files

| File | Rule |
| --- | --- |
| `CHANGELOG.md` | Never edited by a task. Add `changelog.d/<issue>-<slug>.md` instead; the release builds the section. |
| `pnpm-lock.yaml`, `package.json` dependencies | Not changed by a task. Ask the integrator for a dependency; it lands once on the phase branch. |
| Migrations | Only the task the plan names may add one, with the number the plan reserved. |
| Visual baselines, `e2e/visual.spec.ts`, shared test config, generated catalogues | Integrator only. |
| Files outside the task's ownership row | Not edited; report what is needed instead. |

## Tests a delegate runs

- `pnpm test:affected` (or `node scripts/test-affected.mjs --print` to see the selection) for the
  Vitest projects the change touches; the full suite runs in CI.
- `scripts/e2e-docker.sh smoke` for an interface change; `functional` or `axe` when the task's
  contract asks for it. Give each concurrent run its own `TEST_PORT_OFFSET`.
- `npx biome check .` and the typecheck.
- All of it against the one shared test stack: `eval "$(scripts/test-services.sh env)"`. A delegate
  never starts its own containers.

## Brief template

```markdown
# Task <letter>: <title> (GitHub issue #<n>)

Start: `git fetch origin && git checkout -B <task-branch> origin/feat/phase-<n>`.

Read: `gh issue view <n>`, `docs/design/phase-<n>/README.md` (your ownership row, shared interfaces),
`docs/design/phase-<n>/<surface>.md`, the mock-up `docs/design/phase-<n>/mock/<surface>.html`.

Implement exactly: <the contract's essentials>.

## Rules
- Edit only the files your ownership row lists, plus new files in your namespace.
- Failing test first; then the fix. No lockfile or dependency changes; no edits to `CHANGELOG.md`
  (add `changelog.d/<n>-<slug>.md`).
- Tests: `pnpm test:affected`, `scripts/e2e-docker.sh smoke` (interface changes), lint, typecheck,
  against the shared stack (`eval "$(scripts/test-services.sh env)"`). No containers of your own.
- Commit on `<task-branch>` (end each commit with the co-author line); do not push.
- Report: branch, SHA, decisions where the contract was silent, evidence with exit codes, and what
  the integrator must do.
- Commit early and often; never end your turn while a background command still runs.
```
