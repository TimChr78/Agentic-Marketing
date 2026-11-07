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

if url="$(gh pr view "$task" --json url -q .url 2>/dev/null)"; then
  echo "already open: $url"
else
  gh pr create --draft --base "$phase" --head "$task" --title "$title" --body-file "$tmp"
fi
