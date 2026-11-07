#!/usr/bin/env bash
# Container identity from the runtime's own files. Sourced by scripts/e2e-docker.sh and exercised
# directly by apps/server/test/e2e-docker-script.test.ts.
#
# Docker names mountinfo paths /docker/containers/<id>/... and newer runtimes /containers/<id>/...;
# cgroup v1 names /docker/<id>, and systemd writes docker-<id>.scope. Only a 64-hex id directly
# after one of those markers counts, so an unrelated overlay or pod id is never picked up.

container_id_from_text() {
  local text
  text="$(cat)"
  [ -n "$text" ] || return 0
  printf '%s\n' "$text" |
    grep -oE '(containers/|/docker/|docker[-/]|containerd[-/]|crio[-/]|libpod[-/])[0-9a-f]{64}' |
    grep -oE '[0-9a-f]{64}' | head -1 || true
}

container_id_from_proc() {
  cat /proc/self/mountinfo /proc/self/cgroup 2>/dev/null | container_id_from_text
}
