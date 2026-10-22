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
    .record(z.string(), z.unknown())
    .default({})
    .describe('Settings for the kind; see journeyNodeConfigs, e.g. wait: {"duration":"P2D"}'),
  next: z
    .array(z.object({ to: z.string(), label: z.string().max(40).optional() }))
    .optional()
    .describe(
      'Steps this one continues to, in order (waitEvent/goal: [matched, timeout]; branch: [yes, no]; split: one per weight). Omit to continue with the following node.',
    ),
  position: z.object({ x: z.number(), y: z.number() }).optional().describe('Canvas position; no effect on behaviour'),
});

const Iso = z.string().regex(/^P(\d+W|\d+D|T\d+H|T\d+M|\d+DT\d+H)$/, 'ISO 8601 duration such as P2D, PT6H, P1W');
const SegmentRef = z.string().regex(/^seg_[0-9a-f]{32}$/);

/** Settings per node kind (validated on save). Kinds without one cannot be published yet. */
export const journeyNodeConfigs = {
  trigger: z
    .object({
      event: z.string().min(1).max(200).optional().describe('Enter when this event happens, e.g. "Signed Up"'),
      segment: SegmentRef.optional().describe('Enter when the person enters this segment'),
      reentry: z
        .enum(['once', 'after_exit', 'always'])
        .default('once')
        .describe('once: never again; after_exit: when not in the journey; always: every time'),
    })
    .refine((c) => !!c.event !== !!c.segment, 'Set exactly one of event or segment'),
  wait: z.object({ duration: Iso }),
  waitEvent: z.object({ event: z.string().min(1).max(200), timeout: Iso }),
  goal: z.object({ event: z.string().min(1).max(200), within: Iso }),
  branch: z
    .object({ segment: SegmentRef.optional(), condition: z.unknown().optional().describe('A segment condition, evaluated for the person') })
    .refine((c) => !!c.segment !== (c.condition !== undefined), 'Set exactly one of segment or condition'),
  split: z.object({ weights: z.array(z.number().int().min(0).max(100)).min(2).max(5).describe('Relative weights, one per outgoing edge') }),
  email: z.object({ template: z.string().regex(/^eml_[0-9a-f]{32}$/, 'An e-mail template id (eml_…)') }),
  updateProfile: z.object({
    trait: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
    value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
  }),
  exit: z.object({}),
} as const;

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
      for (const n of nodes) {
        const schema = journeyNodeConfigs[n.kind as keyof typeof journeyNodeConfigs] as z.ZodType | undefined;
        if (schema) {
          const r = schema.safeParse(n.config);
          if (!r.success)
            for (const i of r.error.issues)
              ctx.addIssue({ code: 'custom', message: `Node "${n.id}" (${n.kind}): ${[...i.path, ''].join('.')}${i.message}` });
        }
        const edges = n.next?.length ?? 0;
        if (n.kind === 'branch' && edges !== 2) ctx.addIssue({ code: 'custom', message: `Branch "${n.id}" needs two edges: [yes, no]` });
        if ((n.kind === 'waitEvent' || n.kind === 'goal') && edges > 2)
          ctx.addIssue({ code: 'custom', message: `"${n.id}" has at most two edges: [matched, timeout]` });
        const weights = (n.config as { weights?: unknown[] }).weights;
        if (n.kind === 'split' && Array.isArray(weights) && weights.length !== edges)
          ctx.addIssue({ code: 'custom', message: `Split "${n.id}" needs one edge per weight (${weights.length})` });
      }
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

// Web experiences (channels-and-personalization.md §3). Targeting is evaluated on every page
// request from hot state only, so it is a smaller language than segments: profile traits and
// segment memberships (from the snapshot), session counters, and the page itself.
export type DecideCondition =
  | { all: DecideCondition[] }
  | { any: DecideCondition[] }
  | { not: DecideCondition }
  | {
      trait: string;
      op: 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';
      value?: string | number | boolean | (string | number)[];
    }
  | { segment: string }
  | { session: string; count?: { gte?: number; lte?: number } }
  | { newVisitor: boolean }
  | { page: { path?: string; pathPrefix?: string; urlContains?: string } }
  | { referrer: { contains: string } }
  | { utmSource: string }
  | { device: 'mobile' | 'desktop' };
export const decideCondition: z.ZodType<DecideCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(decideCondition).min(1).max(20) }).strict(),
    z.object({ any: z.array(decideCondition).min(1).max(20) }).strict(),
    z.object({ not: decideCondition }).strict(),
    z
      .object({
        trait: PropKey,
        op: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'exists']),
        value: z.union([Scalar, z.array(z.union([z.string().max(500), z.number()])).max(200)]).optional(),
      })
      .strict(),
    z.object({ segment: z.string().regex(/^seg_[0-9a-f]{32}$/) }).strict(),
    z
      .object({
        session: z.string().min(1).max(200).describe('Event name counted in the current session, e.g. "Product Viewed" or "page"'),
        count: z.object({ gte: z.number().int().min(0).optional(), lte: z.number().int().min(0).optional() }).optional(),
      })
      .strict(),
    z.object({ newVisitor: z.boolean() }).strict(),
    z
      .object({
        page: z
          .object({
            path: z.string().max(500).optional(),
            pathPrefix: z.string().max(500).optional(),
            urlContains: z.string().max(500).optional(),
          })
          .strict(),
      })
      .strict(),
    z.object({ referrer: z.object({ contains: z.string().min(1).max(200) }).strict() }).strict(),
    z.object({ utmSource: z.string().min(1).max(200) }).strict(),
    z.object({ device: z.enum(['mobile', 'desktop']) }).strict(),
  ]),
);
const experience = z
  .object({
    placement: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .describe('Where it shows: the page element with data-am-placement="<placement>"'),
    description: z.string().max(1000).default(''),
    priority: z.number().int().min(0).max(1000).default(100).describe('Higher wins when several experiences target the same placement'),
    targeting: decideCondition
      .optional()
      .describe(
        'Who sees it. Traits, segments and session conditions need the visitor to allow web_personalization; page, referrer, UTM and device do not',
      ),
    variants: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9_]{1,32}$/),
          name: z.string().min(1).max(120),
          weight: z.number().int().min(0).max(100).default(50),
          content: z
            .object({
              html: z.string().max(50_000).optional().describe('HTML for the placement; scripts and event handlers are removed by the SDK'),
              json: z.record(z.string(), z.unknown()).optional().describe('Data for a site that renders the placement itself'),
            })
            .refine((c) => c.html !== undefined || c.json !== undefined, 'A variant needs html or json content'),
        }),
      )
      .min(1)
      .max(5),
    holdoutPercent: z.number().int().min(0).max(50).default(0).describe('Share of eligible visitors who see nothing (control group)'),
    goal: z
      .object({ event: z.string().min(1).max(200) })
      .optional()
      .describe('Conversion event for results'),
    trigger: z
      .object({ type: z.enum(['immediate', 'exit_intent', 'scroll', 'time_on_page']), value: z.number().min(0).max(3600).optional() })
      .default({ type: 'immediate' })
      .describe('When the SDK shows it: at once, on exit intent, after scrolling value % or after value seconds'),
  })
  .superRefine((e, ctx) => {
    const ids = new Set<string>();
    for (const v of e.variants) {
      if (ids.has(v.id)) ctx.addIssue({ code: 'custom', message: `Duplicate variant id "${v.id}"` });
      ids.add(v.id);
    }
    if (e.variants.every((v) => v.weight === 0)) ctx.addIssue({ code: 'custom', message: 'At least one variant needs a weight above 0' });
  });

export type TrackingPlan = z.output<typeof trackingPlan>;
export type ExperienceDefinition = z.output<typeof experience>;
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
  experience: {
    prefix: 'exp',
    label: 'Web experience',
    description:
      'Personalized content for a placement on the website, with targeting, variants (A/B/n), a holdout and a goal. Served by the decision API.',
    content: experience,
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
/** Checks that only apply to publishing (a draft may be unfinished), e.g. referenced templates exist. */
export type PublishValidator = (content: unknown, tx: import('@agentic-marketing/db').Tx) => Promise<string[]>;
export const publishValidators = new Map<ArtifactType, PublishValidator>();
export type JourneyDefinition = z.output<typeof journey>;
