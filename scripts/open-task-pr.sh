#!/usr/bin/env bash
# Push a delegate's task branch and open a draft PR against the phase branch, so CI validates the
# task on its own while it is reviewed. The integrator runs this; delegates commit but do not push.
#
#   scripts/open-task-pr.sh <task-branch> <phase-branch> <issue> "<title>" [body-file]
#
# The PR body comes from the body file, or a minimal body with "Closes #<issue>".
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <task-branch> <phase-branch> <issue> \"<title>\" [body-file]" >&2
  exit 2
fi
task="$1"; phase="$2"; issue="$3"; title="$4"; body_file="${5:-}"

case "$issue" in (*[!0-9]*|'') echo "error: issue must be a number, got '$issue'" >&2; exit 2;; esac
# Only the documented phase-branch form: an arbitrary base (main, a release branch) is refused.
case "$phase" in (feat/phase-[0-9]*) ;; (*) echo "error: '$phase' is not a phase branch (expected feat/phase-<n>)" >&2; exit 2;; esac
case "$task" in
  ("$phase"|main|master|feat/phase-*|release-*) echo "error: '$task' cannot be a task branch" >&2; exit 2;;
esac
git rev-parse --verify --quiet "refs/heads/$task" >/dev/null || { echo "error: no local branch '$task'" >&2; exit 1; }
git ls-remote --exit-code --heads origin "$phase" >/dev/null || { echo "error: phase branch '$phase' is not on origin; push it first" >&2; exit 1; }

# A task branch must be based on the phase branch, or its PR would carry unrelated commits.
git fetch --quiet origin "$phase"
if ! git merge-base --is-ancestor "origin/$phase" "$task"; then
  echo "error: '$task' does not contain origin/$phase; merge or rebase it onto the phase branch first" >&2
  exit 1
fi

git push --quiet --set-upstream origin "$task"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
if [ -n "$body_file" ]; then
  cp "$body_file" "$tmp"
else
  printf 'Task for the phase branch `%s`.\n\nCloses #%s\n' "$phase" "$issue" > "$tmp"
fi
grep -Eq "(Closes|Fixes|Resolves) #$issue\b" "$tmp" || printf '\nCloses #%s\n' "$issue" >> "$tmp"

# Reuse only an OPEN pull request from this head into this phase branch; anything else (a PR into
# main, a closed one) is not the task PR, so a new draft is opened.
existing="$(gh pr list --state open --head "$task" --base "$phase" --json url -q '.[0].url' 2>/dev/null || true)"
if [ -n "$existing" ]; then
  echo "already open: $existing"
else
  gh pr create --draft --base "$phase" --head "$task" --title "$title" --body-file "$tmp"
fi
