import type { Principal, UnknownInputKey } from '@agentic-marketing/commands';
import { type Db, type InputWarningPrincipal, schema } from '@agentic-marketing/db';
import { logger } from '@agentic-marketing/telemetry';
import { sql } from 'drizzle-orm';

// Unknown input keys are evidence for rolling out STRICT_INPUTS (#124). A busy request can carry
// many keys, so events are coalesced for a few seconds and written in the background: recording
// must never slow down or fail the command that caused them. Only key paths are stored.

const FLUSH_MS = 2_000;
// Evidence, not a log of everything: a client sending many made-up keys must not grow the table
// (or this process) without bound. A few keys per call and a few thousand per window show the problem.
const MAX_KEYS_PER_CALL = 50;
const MAX_PENDING = 5_000;
const MAX_PATH = 200;

interface Pending {
  workspaceId: string;
  principalType: InputWarningPrincipal;
  principalId: string;
  command: string;
  keyPath: string;
  firstSeen: Date;
  lastSeen: Date;
  count: number;
}

/** An API token is `token:<id>` on an agent principal; other agents are OAuth clients. */
function clientOf(principal: Principal): { type: InputWarningPrincipal; id: string } {
  if (principal.type === 'user') return { type: 'user', id: principal.userId };
  const clientId = principal.clientId ?? principal.userId;
  return clientId.startsWith('token:') ? { type: 'token', id: clientId.slice('token:'.length) } : { type: 'oauth_client', id: clientId };
}

/** Display names are looked up once per flush; a deleted token or client falls back to its id. */
async function clientLabels(db: Db, rows: Pending[]): Promise<Map<string, string>> {
  const ids = (type: InputWarningPrincipal) => [...new Set(rows.filter((r) => r.principalType === type).map((r) => r.principalId))];
  const labels = new Map<string, string>();
  const add = (type: InputWarningPrincipal, id: string, label: string | null) => {
    if (label) labels.set(`${type}|${id}`, label);
  };

  const users = ids('user');
  if (users.length) {
    const { rows: found } = await db.admin.query<{ id: string; name: string }>(
      `SELECT id, COALESCE(NULLIF(name, ''), email) AS name FROM "user" WHERE id = ANY($1)`,
      [users],
    );
    for (const row of found) add('user', row.id, row.name);
  }
  const tokens = ids('token');
  if (tokens.length) {
    const { rows: found } = await db.admin.query<{ id: string; name: string }>('SELECT id, name FROM api_tokens WHERE id = ANY($1)', [
      tokens,
    ]);
    for (const row of found) add('token', row.id, row.name);
  }
  const clients = ids('oauth_client');
  if (clients.length) {
    const { rows: found } = await db.admin.query<{ id: string; name: string | null }>(
      'SELECT "clientId" AS id, name FROM "oauthClient" WHERE "clientId" = ANY($1)',
      [clients],
    );
    for (const row of found) add('oauth_client', row.id, row.name);
  }
  return labels;
}

export function createInputWarningRecorder(db: Db) {
  const pending = new Map<string, Pending>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    if (!pending.size) return;
    const batch = [...pending.values()];
    pending.clear();

    let labels: Map<string, string>;
    try {
      labels = await clientLabels(db, batch);
    } catch (err) {
      // Without a label the event is still useful; do not drop the evidence over a rename race.
      logger.warn({ err }, 'input warnings: client names not resolved');
      labels = new Map();
    }

    const byWorkspace = new Map<string, Pending[]>();
    for (const row of batch) {
      const list = byWorkspace.get(row.workspaceId) ?? [];
      list.push(row);
      byWorkspace.set(row.workspaceId, list);
    }

    for (const [workspaceId, rows] of byWorkspace) {
      try {
        await db.withWorkspace(workspaceId, async (tx) => {
          for (const row of rows) {
            const clientLabel = labels.get(`${row.principalType}|${row.principalId}`) ?? row.principalId;
            await tx
              .insert(schema.inputWarnings)
              .values({
                workspaceId: row.workspaceId,
                principalType: row.principalType,
                principalId: row.principalId,
                clientLabel,
                command: row.command,
                keyPath: row.keyPath,
                firstSeen: row.firstSeen,
                lastSeen: row.lastSeen,
                count: row.count,
              })
              .onConflictDoUpdate({
                target: [
                  schema.inputWarnings.workspaceId,
                  schema.inputWarnings.principalType,
                  schema.inputWarnings.principalId,
                  schema.inputWarnings.command,
                  schema.inputWarnings.keyPath,
                ],
                set: {
                  clientLabel,
                  count: sql`${schema.inputWarnings.count} + ${row.count}`,
                  lastSeen: sql`greatest(${schema.inputWarnings.lastSeen}, ${row.lastSeen})`,
                },
              });
          }
        });
      } catch (err) {
        logger.error({ err, workspaceId }, 'input warnings: not recorded');
      }
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, FLUSH_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    record(command: string, unknown: UnknownInputKey[], principal: Principal) {
      const client = clientOf(principal);
      const now = new Date();
      for (const item of unknown.slice(0, MAX_KEYS_PER_CALL)) {
        const path = item.path.slice(0, MAX_PATH);
        const key = [principal.workspaceId, client.type, client.id, command, path].join('\u0000');
        const seen = pending.get(key);
        if (seen) {
          seen.count++;
          seen.lastSeen = now;
        } else if (pending.size < MAX_PENDING) {
          pending.set(key, {
            workspaceId: principal.workspaceId,
            principalType: client.type,
            principalId: client.id,
            command,
            keyPath: path,
            firstSeen: now,
            lastSeen: now,
            count: 1,
          });
        }
      }
      schedule();
    },
    /** Tests and shutdown can wait for pending events instead of the timer. */
    flush,
  };
}
