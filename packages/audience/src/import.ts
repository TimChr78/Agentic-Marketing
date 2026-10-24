import { createHash } from 'node:crypto';
import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { isoDateTime, newId } from '@agentic-marketing/core';
import { acceptItems } from '@agentic-marketing/ingest';
import { z } from 'zod';

// Importing people with their consent history, e.g. newsletter subscribers moving from another
// tool. Rows become identify events and "Subscription Imported" events from an import batch (imp_)
// source, so identity resolution, segments and journeys see them like any other event, and the
// consent hook records the consents with the imported timestamps and proof.

export const IMPORTED = 'Subscription Imported';

const Row = z.object({
  email: z.email().max(320),
  userId: z.string().min(1).max(200).optional(),
  traits: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('e.g. {"firstName": "Ada"}; personal traits are sealed per the tracking plan'),
  consent: z
    .array(
      z.object({
        purpose: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        status: z.enum(['granted', 'denied', 'withdrawn', 'objected']),
        recordedAt: isoDateTime('recordedAt').optional().describe('When the person gave it, from the old system'),
        proof: z
          .record(z.string(), z.unknown())
          .default({})
          .describe('e.g. {"system": "Kit", "form": "Homepage", "ip": "…", "confirmed_at": "…"}'),
      }),
    )
    .max(10)
    .default([]),
});

export const importProfiles = defineCommand({
  name: 'profiles.import',
  title: 'Import people with their consent',
  description:
    'Bring in up to 5,000 people per call (e.g. newsletter subscribers exported from another tool) with their consent history and proof. Re-importing the same rows changes nothing. Only people can import consent.',
  input: z.object({
    label: z.string().min(1).max(200).describe('What this is, e.g. "Kit export 2026-10-22"; kept as proof'),
    rows: z.array(Row).min(1).max(5000),
  }),
  output: z.object({
    batchId: z.string(),
    accepted: z.number(),
    rejected: z.array(z.object({ index: z.number(), error: z.string() })),
  }),
  permission: 'profiles:write',
  effect: 'write',
  humansOnly: true,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const purposes = (await publishedSingleton(ctx.tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
    const known = new Set(purposes.map((p) => p.key));
    const rejected: { index: number; error: string }[] = [];
    const items: unknown[] = [];
    const rowOf: number[] = [];
    for (const [index, r] of input.rows.entries()) {
      const bad = r.consent.find((c) => !known.has(c.purpose));
      if (bad) {
        rejected.push({ index, error: `unknown purpose "${bad.purpose}"` });
        continue;
      }
      const email = r.email.toLowerCase();
      // Stable ids: re-importing the same row is deduplicated on the bus.
      const key = createHash('sha256')
        .update(`${email}\n${JSON.stringify(r)}`)
        .digest('hex')
        .slice(0, 32);
      const who = r.userId
        ? { userId: r.userId }
        : { anonymousId: `import:${createHash('sha256').update(email).digest('hex').slice(0, 24)}` };
      items.push({ type: 'identify', ...who, messageId: `imp:${key}:identify`, traits: { ...r.traits, email } });
      rowOf.push(index);
      if (r.consent.length) {
        items.push({
          type: 'track',
          event: IMPORTED,
          ...who,
          messageId: `imp:${key}:consent`,
          properties: { consent: r.consent, label: input.label, imported_by: ctx.principal.userId },
        });
        rowOf.push(index);
      }
    }
    const batchId = newId('imp');
    const plan = await publishedSingleton(ctx.tx, 'tracking_plan');
    const out = acceptItems(items, { id: batchId, workspaceId: ws, kind: 'server', requiredPurpose: null }, { plan, purposes });
    for (const r of out.rejected) rejected.push({ index: rowOf[r.index], error: r.error });
    if (out.accepted.length) await ctx.services.bus.publish(out.accepted);
    return { batchId, accepted: input.rows.length - new Set(rejected.map((r) => r.index)).size, rejected };
  },
});
