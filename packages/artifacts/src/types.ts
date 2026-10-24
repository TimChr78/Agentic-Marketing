import { isoDateTime } from '@agentic-marketing/core';
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
  'sms',
  'push',
  'webhook',
  'action',
  'transform',
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
const PromptRef = z.string().regex(/^prm_[0-9a-f]{32}$/, 'A prompt id (prm_…)');

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
  sms: z.object({ template: z.string().regex(/^sms_[0-9a-f]{32}$/, 'An SMS template id (sms_…)') }),
  push: z.object({ template: z.string().regex(/^psh_[0-9a-f]{32}$/, 'A push template id (psh_…)') }),
  updateProfile: z.object({
    trait: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
    value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
  }),
  webhook: z.object({
    endpoint: z.string().regex(/^whk_[0-9a-f]{32}$/, 'A webhook endpoint id (whk_…)'),
    data: z
      .string()
      .max(5000)
      .optional()
      .describe(
        "JSONata over {profile, event, vars, content, results} for the payload's data; default: the profile (id, non-personal traits) and the trigger event",
      ),
  }),
  action: z.object({
    connection: z.string().regex(/^con_[0-9a-f]{32}$/, 'A connection id (con_…)'),
    action: z.string().min(1).max(64).describe('e.g. "postMessage" (Slack) or "request" (HTTP API)'),
    input: z
      .union([z.record(z.string(), z.unknown()), z.string().max(5000)])
      .default({})
      .describe('The action input: a JSON object, or a JSONata expression over {profile, event, vars, content, results} that returns one'),
    timeout: Iso.default('PT10M').describe('How long the step waits for the action before taking the error edge'),
  }),
  transform: z.object({
    set: z
      .string()
      .regex(/^[a-z][A-Za-z0-9_]{0,31}$/)
      .describe('Stores the result as vars.<set>'),
    expression: z
      .string()
      .min(1)
      .max(5000)
      .describe('JSONata over {profile, event, vars, content, results}, e.g. $sum(event.properties.products.price)'),
  }),
  aiDecide: z.object({
    prompt: PromptRef.describe('A decide prompt (prm_…); its published version is used'),
    options: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/))
      .min(2)
      .max(6)
      .describe("The prompt's option keys in the order of this node's edges"),
    fallback: z.string().describe('Option taken when the AI cannot decide (no consent, budget, timeout, error, invalid answer)'),
    timeout: Iso.default('PT5M').describe('How long the step may wait for the model before taking the fallback'),
  }),
  aiGenerate: z.object({
    prompt: PromptRef.describe("A generate prompt (prm_…); its slots fill `content.<slot>` for later e-mails, or the slot's fallback text"),
    timeout: Iso.default('PT5M'),
  }),
  exit: z.object({}),
} as const;

const journeyBase = {
  purpose: Key.describe('Purpose key of the messages, e.g. "marketing_email"; the send gateway derives the lawful basis from it'),
  goal: z.string().max(200).optional(),
  nodes: z.array(journeyNode).min(1).max(200),
};

/** Path-aware messages keep validation issues attached to the node they came from. */
function pathText(path: PropertyKey[]): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`;
    return text ? `${text}.${String(part)}` : String(part);
  }, '');
}

/** Graph shape shared by drafts and publishing: ids, edges and the one trigger. */
function checkJourneyStructure(nodes: z.output<typeof journeyNode>[], ctx: z.RefinementCtx) {
  const ids = new Set<string>();
  nodes.forEach((n, index) => {
    if (ids.has(n.id)) ctx.addIssue({ code: 'custom', path: ['nodes', index], message: `Duplicate node id "${n.id}"` });
    ids.add(n.id);
  });
  nodes.forEach((n, index) => {
    for (const e of n.next ?? [])
      if (!ids.has(e.to))
        ctx.addIssue({ code: 'custom', path: ['nodes', index, 'next'], message: `Node "${n.id}" continues to unknown node "${e.to}"` });
    const edges = n.next?.length ?? 0;
    if (n.kind === 'branch' && edges !== 2)
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'next'], message: `Branch "${n.id}" needs two edges: [yes, no]` });
    if (n.kind === 'action' && edges > 2)
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'next'], message: `Action "${n.id}" has at most two edges: [ok, error]` });
    if ((n.kind === 'waitEvent' || n.kind === 'goal') && edges > 2)
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'next'], message: `"${n.id}" has at most two edges: [matched, timeout]` });
  });
  const triggers = nodes.filter((n) => n.kind === 'trigger').length;
  if (triggers !== 1) ctx.addIssue({ code: 'custom', message: `A journey needs exactly one trigger node, found ${triggers}` });
}

/** A draft may be unfinished: only the graph shape must be right, so steps can be filled in later. */
export const journeyDraft = z.object(journeyBase).superRefine((d, ctx) => checkJourneyStructure(d.nodes, ctx));

/** A published journey must be runnable: every step's settings are checked too. */
export const journey = z.object(journeyBase).superRefine((d, ctx) => {
  checkJourneyStructure(d.nodes, ctx);
  d.nodes.forEach((n, index) => {
    const schema = journeyNodeConfigs[n.kind as keyof typeof journeyNodeConfigs] as z.ZodType | undefined;
    if (schema) {
      const r = schema.safeParse(n.config);
      if (!r.success)
        for (const issue of r.error.issues) {
          const field = pathText(['config', ...issue.path]);
          ctx.addIssue({
            code: 'custom',
            path: ['nodes', index, 'config', ...issue.path],
            message: `Node "${n.id}" (${n.kind}): ${field}: ${issue.message}`,
          });
        }
    }
    const edges = n.next?.length ?? 0;
    const weights = (n.config as { weights?: unknown[] }).weights;
    const options = (n.config as { options?: unknown[]; fallback?: unknown }).options;
    if (n.kind === 'aiDecide' && Array.isArray(options)) {
      if (options.length !== edges)
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'config', 'options'],
          message: `AI decision "${n.id}" needs one edge per option (${options.length})`,
        });
      if (!options.includes((n.config as { fallback?: unknown }).fallback))
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'config', 'fallback'],
          message: `AI decision "${n.id}": fallback must be one of its options`,
        });
    }
    if (n.kind === 'split' && Array.isArray(weights) && weights.length !== edges)
      ctx.addIssue({
        code: 'custom',
        path: ['nodes', index, 'config', 'weights'],
        message: `Split "${n.id}" needs one edge per weight (${weights.length})`,
      });
  });
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
  utm: z
    .object({
      source: z.string().min(1).max(100).default('newsletter'),
      medium: z.string().min(1).max(100).default('email'),
      campaign: z.string().max(200).optional().describe('e.g. "signal-43"'),
      domains: z.array(z.string().max(253)).max(20).optional().describe('Only tag links to these sites, e.g. ["martechsignal.com"]'),
    })
    .optional()
    .describe("Add UTM parameters to links, so the site's analytics attributes visits from this e-mail"),
});

const smsTemplate = z.object({
  purpose: Key.describe('Purpose key, e.g. "marketing_sms" or "service_sms"; decides the lawful basis'),
  body: z
    .string()
    .min(1)
    .max(1600)
    .describe(
      'Liquid, e.g. "Hi {{ profile.firstName }}, your order shipped." Marketing texts get " Reply STOP to opt out." added unless the body mentions STOP',
    ),
  sampleData: z.record(z.string(), z.unknown()).optional().describe('Example variables for previews, e.g. {"profile":{"firstName":"Ada"}}'),
});

const pushTemplate = z.object({
  purpose: Key.describe('Purpose key, e.g. "marketing_push" or "service_push"; decides the lawful basis'),
  title: z
    .string()
    .min(1)
    .max(200)
    .describe('Liquid, e.g. "{{ profile.firstName }}, your order shipped"; keep it under about 50 characters'),
  body: z.string().min(1).max(1000).describe('Liquid; shown under the title, cut by most devices after about 150 characters'),
  url: z.string().max(2000).optional().describe('Opened on click (Liquid allowed); clicks are counted'),
  icon: z.url().optional().describe('Web push: a square image, e.g. your logo'),
  image: z.url().optional().describe('A larger picture, where the device shows one'),
  ttlHours: z.number().int().min(0).max(672).default(24).describe('How long push services keep it for an offline device'),
  urgency: z.enum(['normal', 'high']).default('normal').describe('high wakes the device; for time-critical service messages'),
  sampleData: z.record(z.string(), z.unknown()).optional().describe('Example variables for previews'),
});

// Delivery policy (Phase 7): limits that apply to every message, whoever sends it.
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');
const Zone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'An IANA time zone such as Europe/Copenhagen');
const deliveryPolicy = z.object({
  timezone: Zone.default('UTC').describe('Used for quiet hours when a person has no "timezone" trait'),
  frequencyCaps: z
    .array(
      z.object({
        channel: z.enum(['email', 'sms', 'push']),
        purposes: z.array(Key).max(20).default([]).describe('Empty: every purpose not based on contract or legal obligation'),
        max: z.number().int().min(1).max(1000),
        days: z.number().int().min(1).max(90),
      }),
    )
    .max(20)
    .default([])
    .describe('e.g. at most 2 marketing e-mails in 7 days per person; messages over the cap are not sent'),
  quietHours: z
    .array(z.object({ channel: z.enum(['email', 'sms', 'push']), start: Clock, end: Clock }))
    .max(4)
    .default([{ channel: 'sms', start: '21:00', end: '08:00' }])
    .describe("Marketing messages wait until the quiet hours end, in the person's local time"),
  health: z
    .object({
      autoPause: z.boolean().default(true).describe('Hold marketing messages while a stop threshold is exceeded'),
      windowDays: z.number().int().min(1).max(30).default(7),
      minVolume: z.number().int().min(1).default(200).describe('Rates count only after this many messages in the window'),
      complaintWarn: z.number().min(0).max(1).default(0.001),
      complaintStop: z.number().min(0).max(1).default(0.003),
      bounceStop: z.number().min(0).max(1).default(0.05),
    })
    .prefault({}),
});

// Conversion map (Phase 9): which of our events are conversions on which ad platform.
const ConnectionRef = z.string().regex(/^con_[0-9a-f]{32}$/, 'A connection id (con_…)');
const PropPath = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64}){0,3}$/)
  .describe('A property of the event, e.g. "total" or "order.total"');
const conversionMap = z.object({
  rules: z
    .array(
      z.object({
        event: z.string().min(1).max(200).describe('Our event name, e.g. "Order Completed" or "Subscription Confirmed"'),
        value: PropPath.optional().describe('Where the conversion value is'),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional()
          .describe('Fixed currency, e.g. "DKK"; or set currencyProperty'),
        currencyProperty: PropPath.optional(),
        meta: z
          .object({ connection: ConnectionRef, eventName: z.string().min(1).max(100).describe('e.g. "Purchase" or "Lead"') })
          .optional(),
        google: z
          .object({
            connection: ConnectionRef,
            conversionAction: z.string().regex(/^\d{1,20}$/, 'The numeric conversion action id'),
          })
          .optional(),
        microsoft: z
          .object({
            connection: ConnectionRef,
            conversionName: z.string().min(1).max(100).describe('The offline conversion goal name in Microsoft Advertising'),
          })
          .optional(),
        linkedin: z
          .object({ connection: ConnectionRef, conversionId: z.string().regex(/^\d{1,20}$/, 'The numeric conversion rule id') })
          .optional(),
        tiktok: z
          .object({
            connection: ConnectionRef,
            event: z.string().min(1).max(100).describe('A TikTok standard event, e.g. "CompletePayment" or "SubmitForm"'),
          })
          .optional(),
        pinterest: z
          .object({
            connection: ConnectionRef,
            eventName: z
              .enum(['checkout', 'add_to_cart', 'page_visit', 'signup', 'lead', 'search', 'view_category', 'watch_video', 'custom'])
              .describe('A Pinterest event name'),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(50),
});

// Audience sync (Phase 9): a segment kept in sync with ad platform audiences.
const audienceSync = z
  .object({
    segment: z.string().regex(/^seg_[0-9a-f]{32}$/, 'A segment id (seg_…)'),
    meta: z.object({ connection: ConnectionRef, audienceId: z.string().regex(/^\d{5,25}$/, 'The custom audience id') }).optional(),
    google: z
      .object({ connection: ConnectionRef, userListId: z.string().regex(/^\d{1,20}$/, 'The Customer Match user list id') })
      .optional(),
    identifiers: z
      .array(z.enum(['email', 'phone']))
      .min(1)
      .default(['email', 'phone'])
      .describe('Which identifiers may leave (hashed)'),
    removals: z.boolean().default(true).describe('Remove people who leave the segment or withdraw ad_targeting'),
  })
  .refine((a) => !!a.meta || !!a.google, 'Sync to meta and/or google');

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
    analysis: z
      .object({
        method: z
          .enum(['sequential', 'bayesian', 'fixed'])
          .default('sequential')
          .describe(
            'sequential: always-valid p-values, check any time; bayesian: probability to beat the control; fixed: z-test at a planned sample size',
          ),
        alpha: z.number().min(0.001).max(0.2).default(0.05),
        threshold: z.number().min(0.5).max(0.999).default(0.95).describe('bayesian: probability needed to call a winner'),
      })
      .default({ method: 'sequential', alpha: 0.05, threshold: 0.95 }),
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

// Prompts for AI steps (agents-and-mcp.md §5): versioned like everything else, with test cases
// that run against the configured model before a change is approved.
const OptionKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const promptTest = z.object({
  name: z.string().min(1).max(120),
  text: z.string().max(8000).optional().describe('classify: the text to classify'),
  traits: z.record(z.string(), z.unknown()).default({}).describe('Profile traits of the sample person (as the model sees them)'),
  events: z
    .array(z.object({ name: z.string().min(1).max(200), properties: z.record(z.string(), z.unknown()).default({}) }))
    .max(50)
    .default([])
    .describe('Recent events of the sample person, newest last'),
  expect: z
    .object({
      options: z.array(OptionKey).optional().describe('decide, classify: the answer must be one of these'),
      contains: z.array(z.string().max(200)).optional().describe('generate: every slot together must contain these (case-insensitive)'),
      notContains: z.array(z.string().max(200)).optional(),
    })
    .default({}),
});
const prompt = z
  .object({
    kind: z
      .enum(['decide', 'generate', 'classify'])
      .describe('decide: choose one option for a person; generate: write text for content slots; classify: label a text (ai.classify)'),
    instructions: z
      .string()
      .min(1)
      .max(8000)
      .describe('What the model should do. The person (traits, recent events, trigger) is appended as delimited data.'),
    model: z.enum(['default', 'fast']).default('default').describe("Which of the provider's models to use"),
    temperature: z.number().min(0).max(1).default(0.2),
    maxOutputTokens: z.number().int().min(16).max(4000).default(400),
    options: z
      .array(z.object({ key: OptionKey, description: z.string().min(1).max(500) }))
      .max(20)
      .default([])
      .describe(
        'decide: the choices, e.g. {"key":"discount","description":"Price-sensitive: offer 10% off"}; classify: the labels, e.g. {"key":"complaint","description":"Unhappy about an order"}',
      ),
    slots: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
          description: z.string().min(1).max(500),
          maxLength: z.number().int().min(1).max(2000).default(200),
          fallback: z.string().max(2000).describe('Used when generation fails or the text does not pass the checks'),
        }),
      )
      .max(10)
      .default([])
      .describe('generate: the content slots; templates use them as {{ content.<name> }}'),
    forbidden: z
      .array(z.string().min(1).max(200))
      .max(100)
      .default([])
      .describe('generate: phrases the text must never contain (claims, words)'),
    tests: z.array(promptTest).max(50).default([]),
    trait: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
      .optional()
      .describe('classify: store the label in this profile trait when ai.classify is given a person'),
    cache: z
      .object({
        segments: z
          .array(z.string().regex(/^seg_[0-9a-f]{32}$/))
          .min(1)
          .max(10)
          .describe('Text is written once per combination of these segments, from the segment names alone (no personal data)'),
        ttlHours: z.number().int().min(1).max(720).default(24),
      })
      .optional()
      .describe('generate: reuse generated text for everyone in the same segments instead of writing it per person'),
    review: z
      .object({ sampleRate: z.number().min(0).max(1).describe('Share of answered calls set aside for a person to review, e.g. 0.05') })
      .optional()
      .describe('Sample answers for human review (ai.reviews)'),
  })
  .superRefine((p, ctx) => {
    if ((p.kind === 'decide' || p.kind === 'classify') && p.options.length < 2)
      ctx.addIssue({ code: 'custom', message: `A ${p.kind} prompt needs at least two options` });
    if (p.kind === 'decide' && p.options.length > 6) ctx.addIssue({ code: 'custom', message: 'A decide prompt has at most six options' });
    if (p.cache && p.kind !== 'generate') ctx.addIssue({ code: 'custom', message: 'Only generate prompts can cache text' });
    if (p.trait && p.kind !== 'classify') ctx.addIssue({ code: 'custom', message: 'Only classify prompts store a trait' });
    if (p.kind === 'classify')
      for (const t of p.tests) if (!t.text) ctx.addIssue({ code: 'custom', message: `Test "${t.name}" of a classify prompt needs a text` });
    if (p.kind === 'generate' && !p.slots.length) ctx.addIssue({ code: 'custom', message: 'A generate prompt needs at least one slot' });
    const keys = new Set(p.options.map((o) => o.key));
    if (keys.size !== p.options.length) ctx.addIssue({ code: 'custom', message: 'Option keys must be unique' });
    for (const t of p.tests)
      for (const o of t.expect.options ?? [])
        if (!keys.has(o)) ctx.addIssue({ code: 'custom', message: `Test "${t.name}" expects unknown option "${o}"` });
  });

// Audience building (pilot for content sites): signup forms with double opt-in, and broadcasts
// (one-off sends such as a weekly newsletter) to a segment.
const UrlOrPath = z
  .string()
  .max(2000)
  .regex(/^(https?:\/\/|\/)/, 'An absolute URL or a path starting with /');
const form = z
  .object({
    purposes: z.array(Key).min(1).max(10).describe('Purposes the person agrees to, e.g. ["marketing_email"]'),
    doubleOptIn: z.boolean().default(true).describe('Consent counts only after the person clicks the confirmation link'),
    confirmationTemplate: z
      .string()
      .regex(/^eml_[0-9a-f]{32}$/)
      .optional()
      .describe('Confirmation e-mail (with {{ confirm_url }}); its purpose must not need consent, e.g. "onboarding"'),
    consentText: z.string().min(1).max(2000).describe('The text shown next to the form; stored with the consent as proof'),
    traits: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/))
      .max(20)
      .default(['firstName'])
      .describe('Form fields kept as traits besides email'),
    successUrl: UrlOrPath.describe('Where the browser goes after submitting'),
    confirmedUrl: UrlOrPath.describe('Where the browser goes after confirming'),
    errorUrl: UrlOrPath.optional().describe('Where the browser goes when the submission is refused (?error=… is added)'),
    allowedOrigins: z
      .array(z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i))
      .max(20)
      .default([])
      .describe('Sites the form may be posted from; empty: any'),
    turnstile: z.boolean().default(false).describe('Require a Cloudflare Turnstile token (secret in secrets as "turnstile.secret_key")'),
  })
  .refine((f) => !f.doubleOptIn || !!f.confirmationTemplate, 'Double opt-in needs a confirmationTemplate');

const broadcast = z.object({
  template: z
    .string()
    .regex(/^(eml|sms|psh)_[0-9a-f]{32}$/, 'An e-mail, SMS or push template id (eml_…, sms_… or psh_…)')
    .describe(
      'An e-mail, SMS or push template id (eml_…, sms_… or psh_…). For a newsletter, use one template per issue (copy the previous issue as a starting point): broadcasts carry no per-send data, so a shared layout cannot be filled per issue. The template must be published before the broadcast can be.',
    ),
  segment: z.string().regex(/^seg_[0-9a-f]{32}$/, 'A segment id (seg_…)'),
  sendAt: isoDateTime('sendAt').optional().describe('When to start sending; default: as soon as it is published'),
  description: z.string().max(500).optional(),
});

export type FormDefinition = z.output<typeof form>;
export type ConversionMap = z.output<typeof conversionMap>;
export type AudienceSync = z.output<typeof audienceSync>;
export type SmsTemplate = z.output<typeof smsTemplate>;
export type PushTemplate = z.output<typeof pushTemplate>;
export type DeliveryPolicy = z.output<typeof deliveryPolicy>;
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = deliveryPolicy.parse({});
export type BroadcastDefinition = z.output<typeof broadcast>;
export type TrackingPlan = z.output<typeof trackingPlan>;
export type PromptDefinition = z.output<typeof prompt>;
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
  sms_template: {
    prefix: 'sms',
    label: 'SMS template',
    description: 'A text message with Liquid placeholders and a purpose. Preview it (segments, cost) with smsTemplates.preview.',
    content: smsTemplate,
  },
  push_template: {
    prefix: 'psh',
    label: 'Push template',
    description:
      'A push notification (title, body, link, image) with Liquid placeholders and a purpose, for browsers (web push) and apps (FCM, APNs). Preview it with pushTemplates.preview.',
    content: pushTemplate,
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
  prompt: {
    prefix: 'prm',
    label: 'AI prompt',
    description:
      'Instructions for an AI journey step (decide between options, or write text for content slots), with test cases. Run them with prompts.test.',
    content: prompt,
  },
  form: {
    prefix: 'frm',
    label: 'Signup form',
    description:
      'A public signup form (e.g. a newsletter): which purposes the person agrees to, double opt-in with a confirmation e-mail, redirects. Post to <links URL>/f/<id>.',
    content: form,
  },
  broadcast: {
    prefix: 'bct',
    label: 'Broadcast',
    description:
      'A one-off send of an e-mail template to a segment at a set time, e.g. a weekly newsletter. Use the template-per-issue pattern: each issue is its own e-mail template (copy the previous issue as a starting point), and the broadcast references it. Broadcasts carry no per-send data. The template must be published before the broadcast can be, so an issue takes two approvals: template, then broadcast. Check it with broadcasts.preview.',
    content: broadcast,
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
  conversion_map: {
    prefix: 'cvm',
    label: 'Conversion map',
    description:
      'Which events are conversions on which ad platform (Meta Conversions API, Google Data Manager), with value and currency. Sent only for people who allowed ad_measurement. One per workspace.',
    content: conversionMap,
    singleton: true,
  },
  audience_sync: {
    prefix: 'aud',
    label: 'Audience sync',
    description:
      'A segment kept in sync with a Meta custom audience and/or a Google Customer Match list: hashed e-mail and phone of members who allowed ad_targeting, added and removed as the segment changes. Check it with ads.audiences.',
    content: audienceSync,
  },
  delivery_policy: {
    prefix: 'dlp',
    label: 'Delivery policy',
    description:
      'Frequency caps, quiet hours and the bounce and complaint thresholds that pause marketing messages. One per workspace; defaults apply until one is published.',
    content: deliveryPolicy,
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
    key: 'marketing_sms',
    name: 'Marketing SMS',
    description: 'News and offers by text message.',
    basis: 'consent',
    channels: ['sms'],
    requiresDoubleOptIn: false,
  },
  {
    key: 'service_sms',
    name: 'Service texts',
    description: 'Texts about your account and orders, e.g. delivery updates.',
    basis: 'contract',
    channels: ['sms'],
    requiresDoubleOptIn: false,
  },
  {
    key: 'marketing_push',
    name: 'Marketing notifications',
    description: 'News and offers as notifications in your browser or our app.',
    basis: 'consent',
    channels: ['push'],
    requiresDoubleOptIn: false,
  },
  {
    key: 'service_push',
    name: 'Service notifications',
    description: 'Notifications about your account and orders, e.g. delivery updates.',
    basis: 'contract',
    channels: ['push'],
    requiresDoubleOptIn: false,
  },
  {
    key: 'ad_measurement',
    name: 'Ad measurement',
    description: 'Telling ad platforms which ad clicks led to a signup or purchase.',
    basis: 'consent',
    channels: ['web'],
    requiresDoubleOptIn: false,
  },
  {
    key: 'ad_targeting',
    name: 'Ad personalization',
    description: 'Showing you, or leaving you out of, ads on other sites based on what you did here.',
    basis: 'consent',
    channels: ['web'],
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
 * Looser schemas for saving drafts: a draft may be unfinished (e.g. a journey step with no
 * template yet). Types without an entry use their normal content schema. Publishing always
 * validates the full schema in artifactTypes.
 */
export const draftContentSchemas = new Map<ArtifactType, z.ZodType>();
draftContentSchemas.set('journey', journeyDraft);

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
