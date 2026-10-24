#!/bin/sh
# Dev helper: restart the seeded server on :3100.
PID=$(ss -ltnp | grep ":3100 " | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$PID" ] && kill $PID && sleep 2
cd "$(dirname "$0")/.." && (npx tsx apps/server/test/e2e/server.ts > /tmp/am-e2e.log 2>&1 &)
for i in $(seq 1 120); do grep -q "Ready on\|Error" /tmp/am-e2e.log 2>/dev/null && break; sleep 1; done
grep -v '"level":30' /tmp/am-e2e.log | tail -n 12
