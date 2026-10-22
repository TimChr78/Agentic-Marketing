import { z } from 'zod';

// Artifact types and their content schemas. Every type gets versioning, diffs and approvals from
// the generic artifact commands; the schema is what makes content valid for that type.

const Key = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

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
  purpose: Key.describe('Purpose key of the messages, e.g. "marketing_email"; the send gateway derives the lawful basis from it'),
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

// Data governance (data-platform.md §2, §4; security-and-privacy.md §2). One of each per
// workspace; the published version is what ingest, profiles and the send gateway apply.

const PiiClass = z
  .enum(['none', 'personal', 'sensitive'])
  .describe('none: may be stored and shown freely; personal/sensitive: encrypted per person and hidden without profiles:pii');
const PropertyType = z.enum(['string', 'number', 'boolean', 'object', 'array', 'any']);

const trackingPlan = z.object({
  unknownEvents: z.enum(['allow', 'warn', 'block']).default('allow').describe('What happens to events the plan does not list'),
  unknownProperties: z.enum(['allow', 'warn', 'block']).default('allow'),
  events: z
    .array(
      z.object({
        name: z.string().min(1).max(200).describe('Event name as sent, e.g. "Order Completed" or "page"'),
        description: z.string().max(500).optional(),
        properties: z
          .array(
            z.object({
              name: z.string().min(1).max(100),
              type: PropertyType.default('any'),
              required: z.boolean().default(false),
              pii: z.boolean().default(false).describe('Personal data: removed at ingest, never stored with the event'),
            }),
          )
          .default([]),
      }),
    )
    .max(500)
    .default([]),
  traits: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        type: PropertyType.default('any'),
        pii: PiiClass,
        agentVisible: z.boolean().default(false).describe('Whether agents and LLM prompts may see this trait (with profiles:pii)'),
        description: z.string().max(500).optional(),
      }),
    )
    .max(500)
    .default([])
    .describe(
      'Attribute schema for profile traits. Unlisted traits follow `unknownTraits`; Segment reserved traits (email, phone, name …) are personal by default.',
    ),
  unknownTraits: z.enum(['store', 'drop']).default('store').describe('store: keep unlisted traits as non-personal; drop: ignore them'),
});

const LawfulBasis = z.enum(['consent', 'legitimate_interest', 'contract', 'legal_obligation']);
const purposes = z.object({
  purposes: z
    .array(
      z.object({
        key: Key.describe('Used in journeys, messages and consent signals, e.g. "marketing_email"'),
        name: z.string().min(1).max(120),
        description: z.string().max(1000).default(''),
        basis: LawfulBasis,
        channels: z.array(z.enum(['email', 'web', 'sms', 'push', 'webhook'])).default([]),
        requiresDoubleOptIn: z.boolean().default(false),
        lia: z
          .object({ assessment: z.string().min(1).max(5000), owner: z.string().min(1).max(200), reviewBy: z.iso.date() })
          .optional()
          .describe('Legitimate interest assessment; required when basis is legitimate_interest'),
      }),
    )
    .min(1)
    .max(50)
    .superRefine((ps, ctx) => {
      const keys = new Set<string>();
      for (const p of ps) {
        if (keys.has(p.key)) ctx.addIssue({ code: 'custom', message: `Duplicate purpose key "${p.key}"` });
        keys.add(p.key);
        if (p.basis === 'legitimate_interest' && !p.lia)
          ctx.addIssue({ code: 'custom', message: `Purpose "${p.key}" is based on legitimate interest and needs an LIA record (lia)` });
      }
    }),
});
const emailTemplate = z.object({
  purpose: Key.describe(
    'Purpose key, e.g. "marketing_email" or "onboarding"; decides the lawful basis and whether an unsubscribe link is required',
  ),
  subject: z.string().min(1).max(300).describe('Liquid, e.g. "Welcome, {{ profile.firstName | default: \'friend\' }}"'),
  preheader: z.string().max(300).optional().describe('Preview text shown after the subject in inboxes'),
  mjml: z.string().min(1).max(300_000).describe('MJML with Liquid. Variables: profile.*, event.*, unsubscribe_url, preferences_url'),
  text: z.string().max(100_000).optional().describe('Plain-text part (Liquid). Generated from the HTML when omitted'),
  sampleData: z.record(z.string(), z.unknown()).optional().describe('Example variables for previews, e.g. {"profile":{"firstName":"Ada"}}'),
});

// Segment DSL (data-platform.md §6): a JSON condition tree that agents read and write and the
// UI edits. The same definition is evaluated in batch and per person as events arrive.
const Duration = z
  .string()
  .regex(/^P(\d+W|\d+D|T\d+H|T\d+M|\d+DT\d+H)$/, 'ISO 8601 duration such as P7D, P2W, PT6H or PT30M')
  .describe('Look-back window, e.g. "P7D"');
const PropKey = z.string().regex(/^[A-Za-z0-9_]{1,64}$/, 'Letters, digits and _');
const Scalar = z.union([z.string().max(500), z.number(), z.boolean()]);
export type SegmentCondition =
  | { all: SegmentCondition[] }
  | { any: SegmentCondition[] }
  | { not: SegmentCondition }
  | {
      trait: string;
      op: 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'not_exists' | 'contains';
      value?: string | number | boolean | (string | number)[];
    }
  | { event: string; where?: Record<string, string | number | boolean>; count?: { gte?: number; lte?: number }; within?: string }
  | { consent: string }
  | { segment: string };
export const segmentCondition: z.ZodType<SegmentCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(segmentCondition).min(1).max(50) }).strict(),
    z.object({ any: z.array(segmentCondition).min(1).max(50) }).strict(),
    z.object({ not: segmentCondition }).strict(),
    z
      .object({
        trait: PropKey.describe('A non-personal trait, e.g. "city" or "loyaltyTier"'),
        op: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists', 'contains']),
        value: z.union([Scalar, z.array(z.union([z.string().max(500), z.number()])).max(500)]).optional(),
      })
      .strict(),
    z
      .object({
        event: z.string().min(1).max(200).describe('Event name, e.g. "Product Viewed"'),
        where: z.record(PropKey, Scalar).optional().describe('Property equals value, e.g. {"category":"tents"}'),
        count: z
          .object({ gte: z.number().int().min(0).optional(), lte: z.number().int().min(0).optional() })
          .optional()
          .describe('How many times; default at least once'),
        within: Duration.optional(),
      })
      .strict(),
    z
      .object({
        consent: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,63}$/)
          .describe('Purpose the person allows (by its lawful basis)'),
      })
      .strict(),
    z
      .object({
        segment: z
          .string()
          .regex(/^seg_[0-9a-f]{32}$/)
          .describe('Members of another (published) segment'),
      })
      .strict(),
  ]),
);
const segment = z.object({
  description: z.string().max(1000).default(''),
  condition: segmentCondition,
});

export type TrackingPlan = z.output<typeof trackingPlan>;
export type SegmentDefinition = z.output<typeof segment>;
export type EmailTemplate = z.output<typeof emailTemplate>;
export type Purposes = z.output<typeof purposes>['purposes'];

export const artifactTypes = {
  note: { prefix: 'not', label: 'Note', description: 'Free-form note, used to exercise the artifact system.', content: note },
  journey: { prefix: 'jrn', label: 'Journey', description: 'A customer journey graph: trigger, steps and branches.', content: journey },
  email_template: {
    prefix: 'eml',
    label: 'E-mail template',
    description: 'An e-mail as MJML with Liquid placeholders, with subject, preheader and purpose. Preview it with templates.preview.',
    content: emailTemplate,
  },
  segment: {
    prefix: 'seg',
    label: 'Segment',
    description:
      'A group of people defined by traits, events in a time window, consent and other segments. Preview it with segments.preview.',
    content: segment,
  },
  tracking_plan: {
    prefix: 'tpl',
    label: 'Tracking plan',
    description:
      'Which events and properties ingest accepts, which are personal data, and the attribute schema for profile traits. One per workspace.',
    content: trackingPlan,
    singleton: true,
  },
  purposes: {
    prefix: 'pur',
    label: 'Purposes',
    description:
      'Processing purposes with their lawful basis (consent, legitimate interest with LIA, contract, legal obligation). One per workspace.',
    content: purposes,
    singleton: true,
  },
} as const;

/** Purposes that apply until the workspace publishes its own `purposes` artifact. */
export const DEFAULT_PURPOSES: Purposes = [
  {
    key: 'necessary',
    name: 'Strictly necessary',
    description: 'Running the site and service you asked for.',
    basis: 'contract',
    channels: ['web'],
    requiresDoubleOptIn: false,
  },
  {
    key: 'analytics',
    name: 'Analytics',
    description: 'Understanding how the site is used.',
    basis: 'consent',
    channels: ['web'],
    requiresDoubleOptIn: false,
  },
  {
    key: 'web_personalization',
    name: 'Personalization',
    description: 'Tailoring the site to you.',
    basis: 'consent',
    channels: ['web'],
    requiresDoubleOptIn: false,
  },
  {
    key: 'onboarding',
    name: 'Service messages',
    description: 'Messages about your account and orders.',
    basis: 'contract',
    channels: ['email'],
    requiresDoubleOptIn: false,
  },
  {
    key: 'marketing_email',
    name: 'Marketing e-mail',
    description: 'News and offers by e-mail.',
    basis: 'consent',
    channels: ['email'],
    requiresDoubleOptIn: false,
  },
  {
    key: 'ai_processing',
    name: 'AI personalization',
    description: 'Using AI to choose content and timing for you.',
    basis: 'consent',
    channels: [],
    requiresDoubleOptIn: false,
  },
];

export type ArtifactType = keyof typeof artifactTypes;
export const ARTIFACT_TYPES = Object.keys(artifactTypes) as [ArtifactType, ...ArtifactType[]];
export const artifactTypeEnum = z.enum(ARTIFACT_TYPES);

/**
 * Checks beyond the schema that need heavy libraries (e.g. compiling MJML). Packages register
 * them; artifact commands run them on every save so agents get the errors right away.
 */
export type ContentValidator = (content: unknown) => string[];
export const contentValidators = new Map<ArtifactType, ContentValidator>();
