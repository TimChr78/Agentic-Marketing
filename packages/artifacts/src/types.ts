import { z } from 'zod';

// Artifact types and their content schemas. Every type gets versioning, diffs and approvals from
// the generic artifact commands; the schema is what makes content valid for that type.

const note = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).describe('Markdown text'),
});

const nodeKinds = [
  'trigger',
  'wait',
  'waitEvent',
  'branch',
  'split',
  'email',
  'webhook',
  'updateProfile',
  'aiDecide',
  'aiGenerate',
  'goal',
  'exit',
] as const;
const journeyNode = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .describe('Short id unique within the journey, e.g. "n1"'),
  kind: z.enum(nodeKinds),
  label: z.string().min(1).max(120),
  config: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({})
    .describe('Step settings, e.g. {"duration":"P2D"}'),
  next: z
    .array(z.object({ to: z.string(), label: z.string().max(40).optional() }))
    .optional()
    .describe('Steps this one continues to. Omit to continue with the following node.'),
});
const journey = z.object({
  purpose: z.enum(['onboarding', 'marketing_email']).describe('Purpose of the messages; the send gateway derives the lawful basis from it'),
  goal: z.string().max(200).optional(),
  nodes: z
    .array(journeyNode)
    .min(1)
    .max(200)
    .superRefine((nodes, ctx) => {
      const ids = new Set<string>();
      for (const n of nodes) {
        if (ids.has(n.id)) ctx.addIssue({ code: 'custom', message: `Duplicate node id "${n.id}"` });
        ids.add(n.id);
      }
      for (const n of nodes)
        for (const e of n.next ?? [])
          if (!ids.has(e.to)) ctx.addIssue({ code: 'custom', message: `Node "${n.id}" continues to unknown node "${e.to}"` });
      const triggers = nodes.filter((n) => n.kind === 'trigger').length;
      if (triggers !== 1) ctx.addIssue({ code: 'custom', message: `A journey needs exactly one trigger node, found ${triggers}` });
    }),
});

export const artifactTypes = {
  note: { prefix: 'not', label: 'Note', description: 'Free-form note, used to exercise the artifact system.', content: note },
  journey: { prefix: 'jrn', label: 'Journey', description: 'A customer journey graph: trigger, steps and branches.', content: journey },
} as const;

export type ArtifactType = keyof typeof artifactTypes;
export const ARTIFACT_TYPES = Object.keys(artifactTypes) as [ArtifactType, ...ArtifactType[]];
export const artifactTypeEnum = z.enum(ARTIFACT_TYPES);
