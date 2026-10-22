import { schema } from '@agentic-marketing/db';
import { journeyChecks } from '@agentic-marketing/journeys';
import { inArray } from 'drizzle-orm';
import { connectors } from './connectors';

// Publish checks for journey automation steps: the webhook endpoints and connections exist, the
// connector offers the action, and a literal input fits the action's schema.
journeyChecks.push(async (def, tx) => {
  const problems: string[] = [];
  const endpoints = def.nodes.filter((n) => n.kind === 'webhook').map((n) => String(n.config.endpoint));
  const actions = def.nodes.filter((n) => n.kind === 'action');
  if (endpoints.length) {
    const found = new Set(
      (
        await tx
          .select({ id: schema.webhookEndpoints.id })
          .from(schema.webhookEndpoints)
          .where(inArray(schema.webhookEndpoints.id, endpoints))
      ).map((r) => r.id),
    );
    for (const e of new Set(endpoints)) if (!found.has(e)) problems.push(`${e} is not a webhook endpoint`);
  }
  if (actions.length) {
    const ids = actions.map((n) => String(n.config.connection));
    const rows = new Map((await tx.select().from(schema.connections).where(inArray(schema.connections.id, ids))).map((r) => [r.id, r]));
    for (const n of actions) {
      const row = rows.get(String(n.config.connection));
      if (!row) {
        problems.push(`node "${n.id}": ${n.config.connection} is not a connection`);
        continue;
      }
      const a = connectors[row.connector]?.actions?.[String(n.config.action)];
      if (!a) {
        problems.push(`node "${n.id}": ${row.connector} has no action "${n.config.action}"`);
        continue;
      }
      if (n.config.input && typeof n.config.input === 'object') {
        const r = a.input.safeParse(n.config.input);
        if (!r.success)
          problems.push(`node "${n.id}": the input does not fit ${row.connector} ${n.config.action}: ${r.error.issues[0]?.message}`);
      }
    }
  }
  return problems;
});
