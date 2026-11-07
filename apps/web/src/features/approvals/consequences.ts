import { typeLabel } from '../../app/artifactRoutes';
import { referencedIds } from '../artifactCache';

// Consequence derivation for the approval review (#498). Pure functions only: the drawer supplies
// the exact reviewed content and any extra read results (audience, checks, evidence); this module
// turns them into labelled rows. Nothing here fetches, and nothing here treats a missing read as a
// zero, a "no dependencies" or a policy promise.

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ConsequenceArtifact {
  id: string;
  name?: string | null;
  type?: string | null;
  publishedVersion?: number | null;
  latestVersion?: number | null;
  unavailable?: boolean;
}

export type ResolvedDependencies = Record<string, ConsequenceArtifact | undefined>;

export interface PurposeInfo {
  key: string;
  name: string;
  basis: string;
  channels: string[];
  requiresDoubleOptIn?: boolean;
  topics?: { key: string; name: string }[];
}

export interface BroadcastAudience {
  audience: number;
  checked: number;
  wouldSend: number;
  wouldSkip: Record<string, number>;
  /** Client completion time, not a server snapshot timestamp. */
  completedAt: string;
}

export interface ProviderEvidence {
  marketing: boolean;
  transactional: boolean;
  configured: boolean;
  adapter: string | null;
}

export interface DomainEvidence {
  checkedAt: string;
  domains: {
    domain: string;
    ok: boolean;
    spf: { ok: boolean };
    dkim: { selector: string; ok: boolean }[];
    dmarc: { ok: boolean };
    uses: string[];
  }[];
}

export interface TemplateCheck {
  version: number;
  checkedAt: string;
  summary: { blocking: number; warning: number; info: number };
  findings: {
    id: string;
    severity: 'blocking' | 'warning' | 'info';
    category: string;
    message: string;
    location?: string;
    fix?: string;
  }[];
}

export interface ConsequenceRowItem {
  key: string;
  value: string;
  note?: string;
  tone?: 'warn' | 'bad' | 'good';
}

export interface ConsequenceRow {
  key: string;
  label: string;
  value?: string;
  notes?: string[];
  /** Sub-values such as dependencies or variants, one per line. */
  items?: ConsequenceRowItem[];
  /** A segment or targeting condition, rendered by ConditionView. */
  condition?: unknown;
  /** Structured reviewed content, rendered as collapsible JSON. */
  details?: { label: string; value: unknown }[];
  /** Sandboxed HTML from reviewed content (experience variants); scripts never run. */
  html?: { label: string; html: string }[];
  tone?: 'warn' | 'bad' | 'good';
}

export type EvidenceStatus = 'ready' | 'attention' | 'not-checked' | 'not-applicable';

export interface ConsequenceEvidence {
  key: string;
  label: string;
  status: EvidenceStatus;
  value: string;
  detail?: string;
}

export interface ConsequenceAudience {
  label: string;
  value: string;
  notes: string[];
  restricted?: boolean;
  unavailable?: boolean;
}

export interface ConsequenceModel {
  heading: 'If approved' | 'Decision context';
  rows: ConsequenceRow[];
  evidence: ConsequenceEvidence[];
  audience: ConsequenceAudience | null;
  notes: string[];
  sending: boolean;
  templateCheck: TemplateCheck | null;
}

export interface ConsequenceInput {
  artifactId: string;
  type: string;
  name: string;
  version: number;
  publishedVersion: number | null;
  latestVersion?: number | null;
  status: ApprovalStatus;
  content: unknown;
  bundleVersions?: Record<string, number>;
  dependencies?: ResolvedDependencies;
  dependenciesLoading?: boolean;
  dependenciesError?: string | null;
  purposes?: PurposeInfo[] | null;
  purposesError?: string | null;
  templatePurpose?: { purpose: string; topic?: string } | null;
  templatePurposeError?: string | null;
  templatePreview?: { version: number; subject: string; preheader?: string } | null;
  templatePreviewError?: string | null;
  templateCheck?: TemplateCheck | null;
  templateCheckError?: string | null;
  broadcastAudience?: BroadcastAudience | null;
  audienceError?: string | null;
  segmentCount?: { count: number } | null;
  segmentCountRestricted?: boolean;
  segmentCountError?: string | null;
  provider?: ProviderEvidence | null;
  providerError?: string | null;
  domains?: DomainEvidence | null;
  domainsError?: string | null;
  evidenceLoading?: boolean;
  formatWhen?: (iso: string | null | undefined) => string;
}

export interface ConsequenceCapabilities {
  canReadArtifacts: boolean;
  canReadProfiles: boolean;
}

export interface ConsequenceReadPlan {
  /** artifacts.get reads for names and publication pointers, each unique id once. */
  artifacts: string[];
  broadcast?: { artifactId: string; version: number; templateVersion?: number };
  templatePreview?: { artifactId: string; version: number };
  templateCheck?: { artifactId: string; version: number };
  segmentPreview?: { artifactId: string; version: number };
  purposes: boolean;
  provider: boolean;
  domains: boolean;
  /** Every exact read this plan will make, for dedupe tests and stale-response keys. */
  cacheKeys: string[];
}

const SENDING = new Set(['broadcast', 'email_template', 'sms_template', 'push_template', 'journey', 'form', 'experience']);
const PURPOSE_TYPES = new Set(['broadcast', 'email_template', 'sms_template', 'push_template', 'journey', 'form']);
const BLOCK_TAG = /\{%\s*block\s+['"](blk_[0-9a-f]{32})['"]/g;
const ARTIFACT_ID = /^(blk|bct|cmp|cpb|brf|cvm|dlp|eml|exp|frm|jrn|mnd|prm|psh|pur|seg|skl|sms|tpl|aud|brd|bcx)_[0-9a-f]{32}$/;

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export const isEmailTemplateId = (id: string | undefined) => !!id && id.startsWith('eml_');

/** The canonical source of dependency references: reviewed content, never the live version. */
export function blockIdsIn(source: string): string[] {
  const ids = new Set<string>();
  for (const match of source.matchAll(BLOCK_TAG)) ids.add(match[1]);
  return [...ids];
}

export function dependencyRefs(
  type: string,
  content: unknown,
  bundleVersions: Record<string, number> = {},
): { id: string; role: string; bundleVersion?: number }[] {
  const c = asObject(content);
  const out = new Map<string, { id: string; role: string; bundleVersion?: number }>();
  const add = (id: string | undefined, role: string, generic = false) => {
    if (!id || !ARTIFACT_ID.test(id)) return;
    const current = out.get(id);
    if (current) {
      // A generic reference must not clutter a role the type already explained ("Template").
      if (!generic && !current.role.split(' · ').includes(role)) current.role = `${current.role} · ${role}`;
      return;
    }
    out.set(id, { id, role, ...(bundleVersions[id] != null ? { bundleVersion: bundleVersions[id] } : {}) });
  };

  if (type === 'broadcast') {
    add(asString(c.template), 'Template');
    add(asString(c.segment), 'Segment');
  } else if (type === 'email_template') {
    for (const id of blockIdsIn(asString(c.mjml) ?? '')) add(id, 'Reusable block');
  } else if (type === 'form') {
    add(asString(c.confirmationTemplate), 'Confirmation e-mail');
  } else if (type === 'segment') {
    add(asString(c.sourceSegment), 'Source segment');
  } else if (type === 'journey') {
    for (const node of asArray(c.nodes)) {
      const n = asObject(node);
      const label = asString(n.label) ?? asString(n.id) ?? 'Step';
      const kind = asString(n.kind) ?? 'step';
      const config = asObject(n.config);
      add(asString(config.template), `${label} · ${kind} template`);
      add(asString(config.segment), `${label} · segment condition`);
    }
  } else if (type === 'campaign') {
    for (const id of asArray(c.members)) add(asString(id), 'Campaign member');
  }

  // Existing reference extraction covers every other direct reference (targeting segments,
  // prompt ids and so on). It never replaces a role already learned above.
  for (const id of referencedIds(content)) add(id, 'Referenced artifact', true);
  return [...out.values()];
}

/**
 * What one open review reads. Each unique artifact/version appears once; restricted reads are not
 * planned at all. The component runs this once per review and keys responses by these values.
 */
export function buildReadPlan({
  artifactId,
  type,
  content,
  version,
  bundleVersions = {},
  capabilities,
}: {
  artifactId: string;
  type: string;
  content: unknown;
  version: number;
  bundleVersions?: Record<string, number>;
  capabilities: ConsequenceCapabilities;
}): ConsequenceReadPlan {
  const empty: ConsequenceReadPlan = { artifacts: [], purposes: false, provider: false, domains: false, cacheKeys: [] };
  if (!capabilities.canReadArtifacts) return empty;
  const c = asObject(content);
  const refs = dependencyRefs(type, content, bundleVersions);
  const artifacts = [...new Set(refs.map((r) => r.id))].sort();
  const plan: ConsequenceReadPlan = { ...empty, artifacts, purposes: PURPOSE_TYPES.has(type) };
  const keys = artifacts.map((id) => `artifact:${id}`);

  if (type === 'broadcast') {
    const template = asString(c.template);
    plan.broadcast = {
      artifactId,
      version,
      ...(bundleVersions[template ?? ''] != null ? { templateVersion: bundleVersions[template ?? ''] } : {}),
    };
    keys.push(`broadcast:${artifactId}@${version}:${plan.broadcast.templateVersion ?? 'live'}`);
    if (isEmailTemplateId(template)) {
      plan.provider = true;
      plan.domains = true;
      keys.push('provider', 'domains');
    }
  } else if (type === 'email_template') {
    plan.templatePreview = { artifactId, version };
    plan.templateCheck = { artifactId, version };
    plan.provider = true;
    plan.domains = true;
    keys.push(`template:${artifactId}@${version}`, 'provider', 'domains');
  } else if (type === 'segment' && capabilities.canReadProfiles) {
    plan.segmentPreview = { artifactId, version };
    keys.push(`segment:${artifactId}@${version}`);
  }

  if (plan.purposes) keys.push('purposes');
  plan.cacheKeys = [...new Set(keys)];
  return plan;
}

export function consequenceHeading(status: ApprovalStatus): 'If approved' | 'Decision context' {
  return status === 'pending' ? 'If approved' : 'Decision context';
}

/** "P1D" → "1 day", "PT2H" → "2 hours"; unknown durations stay as they are. */
export function humanDuration(iso: string | undefined): string {
  if (!iso) return '—';
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso);
  if (!match) return iso;
  const [weeks, days, hours, minutes] = match.slice(1).map((n) => Number(n ?? 0));
  const totalDays = (weeks ?? 0) * 7 + (days ?? 0);
  if (totalDays) return totalDays === 1 ? '1 day' : `${totalDays} days`;
  if (hours) return hours === 1 ? '1 hour' : `${hours} hours`;
  if (minutes) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  return iso;
}

const percent = (value: number | undefined) => (value == null ? '—' : `${Math.round(value * 1000) / 10}%`);

const skipLabels: Record<string, string> = {
  no_consent: 'No consent for the purpose',
  suppressed: 'Suppressed (bounced or complained)',
  unsubscribed: 'Unsubscribed',
  no_email: 'No e-mail address',
  frequency_cap: 'Over the frequency cap',
  outside_send_window: 'Beyond the send window',
  holdout: 'Held out for measurement',
};

function dependencyRow(input: ConsequenceInput): ConsequenceRow {
  const refs = dependencyRefs(input.type, input.content, input.bundleVersions);
  if (!refs.length)
    return {
      key: 'dependencies',
      label: 'Dependencies',
      value: 'None: this definition references no other artifact.',
    };
  const items = refs.map((ref): ConsequenceRowItem => {
    const dependency = input.dependencies?.[ref.id];
    if (input.dependenciesLoading) return { key: ref.id, value: dependency?.name ?? ref.id, note: `${ref.role} · Loading…` };
    if (!dependency || dependency.unavailable) return { key: ref.id, value: ref.id, note: `${ref.role} · Unavailable`, tone: 'bad' };
    const required =
      ref.bundleVersion != null
        ? `Saved v${ref.bundleVersion}`
        : dependency.publishedVersion != null
          ? `Published v${dependency.publishedVersion}`
          : 'Not published';
    const live =
      dependency.publishedVersion != null
        ? `Live v${dependency.publishedVersion}`
        : ref.bundleVersion != null
          ? 'Not live yet'
          : 'Not live';
    const note = [ref.role, required, ref.bundleVersion != null ? 'In this bundle' : live, ref.id].filter(Boolean).join(' · ');
    return {
      key: ref.id,
      value: dependency.name ? `${dependency.name}` : ref.id,
      note,
      tone: ref.bundleVersion == null && dependency.publishedVersion == null ? 'warn' : undefined,
    };
  });
  return { key: 'dependencies', label: 'Dependencies', items };
}

function purposeLabel(purposeKey: string | undefined, purposes: PurposeInfo[] | null | undefined, topic?: string) {
  if (!purposeKey) return 'Not set';
  const purpose = purposes?.find((p) => p.key === purposeKey);
  if (!purpose) return `${purposeKey} · Not configured`;
  const topicName = topic ? purpose.topics?.find((t) => t.key === topic)?.name : undefined;
  return `${purpose.name} · ${purpose.basis}${topic ? ` · ${topicName ?? topic}` : ''}`;
}

function audienceFromBroadcast(input: ConsequenceInput): ConsequenceAudience {
  if (input.audienceError)
    return {
      label: 'Eligible in current check',
      value: 'Unavailable',
      notes: [input.audienceError],
      unavailable: true,
    };
  if (!input.broadcastAudience) return { label: 'Eligible in current check', value: 'Checking…', notes: [] };
  const a = input.broadcastAudience;
  const notes: string[] = [];
  const skip = Object.entries(a.wouldSkip).sort(([x], [y]) => x.localeCompare(y));
  if (a.checked === 0) {
    notes.push(`Estimate · 0 of ${a.audience.toLocaleString()} members checked`);
  } else if (a.checked < a.audience) {
    notes.push(`Estimate · ${a.checked.toLocaleString()} of ${a.audience.toLocaleString()} members checked`);
  } else {
    notes.push(`Current check · all ${a.audience.toLocaleString()} members checked`);
  }
  notes.push(`As of ${input.formatWhen ? input.formatWhen(a.completedAt) : a.completedAt}`);
  for (const [reason, count] of skip) notes.push(`${skipLabels[reason] ?? reason.replace(/_/g, ' ')}: ${count.toLocaleString()}`);
  const value =
    a.checked === 0
      ? 'No members checked'
      : a.wouldSend === 0
        ? 'No eligible recipients in this check'
        : `${a.wouldSend.toLocaleString()} in current check`;
  return { label: 'Eligible in current check', value, notes };
}

function audienceFromSegment(input: ConsequenceInput): ConsequenceAudience {
  if (input.segmentCountRestricted)
    return {
      label: 'Estimated members now',
      value: 'Membership count restricted',
      notes: ['Your role cannot read profiles, so the count is not shown.'],
      restricted: true,
    };
  if (input.segmentCountError)
    return { label: 'Estimated members now', value: 'Unavailable', notes: [input.segmentCountError], unavailable: true };
  if (!input.segmentCount) return { label: 'Estimated members now', value: 'Checking…', notes: [] };
  return {
    label: 'Estimated members now',
    value: `${input.segmentCount.count.toLocaleString()} people`,
    notes: ['Membership is not consent, and this is not an eligible-recipient count.'],
  };
}

function typeRows(
  input: ConsequenceInput,
  c: Record<string, unknown>,
  formatWhen: (iso: string | null | undefined) => string,
): ConsequenceRow[] {
  const rows: ConsequenceRow[] = [];
  const type = input.type;
  const map: Record<string, number> = input.bundleVersions ?? {};

  if (type === 'broadcast') {
    const template = asString(c.template);
    const segment = asString(c.segment);
    const templateDep = template ? input.dependencies?.[template] : undefined;
    const segmentDep = segment ? input.dependencies?.[segment] : undefined;
    rows.push({
      key: 'template',
      label: 'Template',
      value: template ? (templateDep?.name ?? template) : 'Not set',
      notes: template
        ? [
            map[template] != null
              ? `Saved v${map[template]} · In this bundle`
              : templateDep?.publishedVersion != null
                ? `Published v${templateDep.publishedVersion}`
                : 'Not published',
          ]
        : ['Choose a template before submitting.'],
    });
    rows.push({
      key: 'segment',
      label: 'Segment',
      value: segment ? (segmentDep?.name ?? segment) : 'Not set',
      notes: [
        segment
          ? map[segment] != null
            ? `Saved v${map[segment]} · In this bundle`
            : segmentDep?.publishedVersion != null
              ? `Published v${segmentDep.publishedVersion}`
              : 'Not published'
          : 'Choose a segment before submitting.',
        ...(segment && map[segment] != null ? ['Check uses current membership; this bundle may change it.'] : []),
      ],
    });
    rows.push({
      key: 'purpose',
      label: 'Purpose',
      value: purposeLabel(input.templatePurpose?.purpose, input.purposes, asString(c.topic) ?? input.templatePurpose?.topic),
      notes: ['Membership is not consent. Eligibility is checked again at send time.'],
    });
    const sendWindow = asObject(c.sendWindow);
    if (Object.keys(sendWindow).length)
      rows.push({
        key: 'send-window',
        label: 'Send window',
        value: `${asString(sendWindow.start) ?? 'Not set'}–${asString(sendWindow.end) ?? 'Not set'} in each reader’s time zone`,
        notes: [
          `${asArray(sendWindow.days).length ? asArray(sendWindow.days).join(', ') : 'Every day'} · maximum wait ${humanDuration(asString(sendWindow.maxDelay))}`,
          'Readers without a valid zone use the delivery-policy zone. Held messages wait for the next opening; later ones are skipped.',
        ],
      });
    const subjectTest = asObject(c.subjectTest);
    if (Object.keys(subjectTest).length) {
      const subjects = asArray(subjectTest.subjects).map((s) => asString(s) ?? '');
      rows.push({
        key: 'subject-test',
        label: 'Subject test',
        value: `${subjects.length} subjects on ${asNumber(subjectTest.samplePercent) ?? 20}% of the audience`,
        notes: [
          `Winner by ${asString(subjectTest.metric) ?? 'click'} after ${humanDuration(asString(subjectTest.decideAfter))}; the winning subject goes to the rest.`,
          ...subjects.map((subject, i) => `${String.fromCharCode(65 + i)}: ${subject}`),
        ],
      });
    }
    const staged = asObject(c.stagedSend);
    if (Object.keys(staged).length)
      rows.push({
        key: 'staged-send',
        label: 'Staged send',
        value: `Canary ${asNumber(staged.canaryPercent) ?? 10}%, checked after ${humanDuration(asString(staged.wait))}`,
        notes: [
          `Stops above ${percent(asNumber(staged.maxBounceRate))} bounce, ${percent(asNumber(staged.maxComplaintRate))} complaint or ${percent(asNumber(staged.maxUnsubscribeRate))} unsubscribe, with at least ${asNumber(staged.minCanary) ?? 50} canary recipients.`,
        ],
      });
    const archive = asObject(c.archive);
    if (Object.keys(archive).length)
      rows.push({
        key: 'archive',
        label: 'Archive',
        value:
          archive.publish === true
            ? `Publish to the newsletter archive${asString(archive.slug) ? ` at /n/${asString(archive.slug)}/` : ''}`
            : 'Not archived',
        notes: archive.publish === true && asString(archive.summary) ? [asString(archive.summary)!] : undefined,
      });
    if (asString(c.description)) rows.push({ key: 'description', label: 'Description', value: asString(c.description)! });
  } else if (type === 'email_template') {
    const utm = asObject(c.utm);
    rows.push({ key: 'purpose', label: 'Purpose', value: purposeLabel(asString(c.purpose), input.purposes, asString(c.topic)) });
    if (asString(c.topic)) rows.push({ key: 'topic', label: 'Topic', value: asString(c.topic)! });
    rows.push({ key: 'subject', label: 'Subject', value: asString(c.subject) ?? 'Not set' });
    if (asString(c.preheader)) rows.push({ key: 'preheader', label: 'Preheader', value: asString(c.preheader)! });
    if (Object.keys(utm).length)
      rows.push({
        key: 'link-tagging',
        label: 'Link tagging',
        value: `source ${asString(utm.source) ?? 'newsletter'} · medium ${asString(utm.medium) ?? 'email'}${asString(utm.campaign) ? ` · campaign ${asString(utm.campaign)}` : ''}`,
        notes: asArray(utm.domains).length ? [`Only links to ${asArray(utm.domains).join(', ')}`] : undefined,
      });
    const raw = asString(c.subject) ?? '';
    if (input.templatePreview && input.templatePreview.subject !== raw)
      rows.push({
        key: 'rendered-subject',
        label: 'Rendered subject',
        value: input.templatePreview.subject,
        notes: ['With the template’s sample data; the raw subject above may contain Liquid.'],
      });
    rows.push({ key: 'sends', label: 'Sends', value: 'Nothing: publishing a template alone sends nothing.' });
  } else if (type === 'sms_template' || type === 'push_template') {
    rows.push({ key: 'purpose', label: 'Purpose', value: purposeLabel(asString(c.purpose), input.purposes, asString(c.topic)) });
    if (asString(c.topic)) rows.push({ key: 'topic', label: 'Topic', value: asString(c.topic)! });
    if (type === 'sms_template') {
      rows.push({ key: 'body', label: 'SMS body', value: asString(c.body) ?? 'Not set' });
    } else {
      rows.push({ key: 'title', label: 'Title', value: asString(c.title) ?? 'Not set' });
      rows.push({ key: 'body', label: 'Body', value: asString(c.body) ?? 'Not set' });
      if (asString(c.url)) rows.push({ key: 'url', label: 'Opens', value: asString(c.url)! });
      rows.push({
        key: 'delivery',
        label: 'Push options',
        value: `TTL ${asNumber(c.ttlHours) ?? 24} hours · ${asString(c.urgency) ?? 'normal'} urgency`,
        notes: [asString(c.icon) ? `Icon: ${asString(c.icon)}` : 'No icon', asString(c.image) ? `Image: ${asString(c.image)}` : 'No image'],
      });
    }
    rows.push({ key: 'sends', label: 'Sends', value: 'Nothing: publishing a template alone sends nothing.' });
  } else if (type === 'journey') {
    const nodes = asArray(c.nodes).map(asObject);
    const trigger = nodes.find((n) => asString(n.kind) === 'trigger');
    const control = asObject(c.controlGroup);
    rows.push({ key: 'purpose', label: 'Purpose', value: purposeLabel(asString(c.purpose), input.purposes) });
    if (asString(c.goal)) rows.push({ key: 'goal', label: 'Goal', value: asString(c.goal)! });
    rows.push({
      key: 'control-group',
      label: 'Control group',
      value: Object.keys(control).length ? `${asNumber(control.percent) ?? 0}% held out` : 'None',
      notes: Object.keys(control).length
        ? [`Both arms need at least ${asNumber(control.minSampleSize) ?? 200} people before a verdict.`]
        : ['Every entrant follows the journey.'],
    });
    rows.push({
      key: 'trigger',
      label: 'Trigger',
      value: trigger ? (asString(trigger.kind) ?? 'trigger') : 'Not set',
      details: trigger ? [{ label: 'Trigger configuration', value: asObject(trigger.config) }] : undefined,
    });
    rows.push({ key: 'nodes', label: 'Steps', value: `${nodes.length} nodes` });
    rows.push({
      key: 'sends',
      label: 'Enrollment',
      value: 'Uses the published journey; publishing does not guarantee a send.',
    });
  } else if (type === 'segment') {
    const mode = asString(c.mode) ?? 'dynamic';
    rows.push({ key: 'mode', label: 'Mode', value: mode === 'dynamic' ? 'Dynamic' : mode === 'static' ? 'Static' : 'Snapshot' });
    if (asString(c.description)) rows.push({ key: 'description', label: 'Description', value: asString(c.description)! });
    if (mode === 'dynamic') {
      rows.push({ key: 'membership', label: 'Membership', value: 'Recomputed from this condition.', condition: c.condition });
    } else if (mode === 'static') {
      rows.push({ key: 'membership', label: 'Membership', value: 'Explicit membership list, changed by hand, CSV or API.' });
    } else {
      rows.push({
        key: 'membership',
        label: 'Membership',
        value: `Frozen snapshot of ${asString(c.sourceSegment) ?? 'another segment'}${asNumber(c.snapshotVersion) ? ` at v${asNumber(c.snapshotVersion)}` : ''}`,
        notes: [
          asString(c.snapshotAt) ? `Taken ${formatWhen(asString(c.snapshotAt))}` : 'Snapshot time not set',
          'Its members stay fixed until refreshed.',
        ],
      });
    }
    rows.push({
      key: 'sends',
      label: 'Effect',
      value: 'Publishing changes membership selection; it does not itself send.',
      notes: ['Membership is not consent.'],
    });
  } else if (type === 'form') {
    const purposes = asArray(c.purposes).map((p) => asString(p) ?? '');
    const resolved = purposes.map((p) => input.purposes?.find((x) => x.key === p)?.name ?? `${p} · Not configured`);
    rows.push({
      key: 'purposes',
      label: 'Purposes',
      value: resolved.length ? resolved.join(', ') : 'Not set',
    });
    rows.push({
      key: 'double-opt-in',
      label: 'Double opt-in',
      value: c.doubleOptIn === false ? 'Off: consent counts at once' : 'On: consent counts after confirmation',
    });
    rows.push({
      key: 'confirmation',
      label: 'Confirmation e-mail',
      value: asString(c.confirmationTemplate) ?? 'Not set',
    });
    if (asString(c.consentText)) rows.push({ key: 'consent', label: 'Consent text', value: asString(c.consentText)! });
    rows.push({
      key: 'traits',
      label: 'Fields',
      value: asArray(c.traits).length ? asArray(c.traits).join(', ') : 'E-mail only',
    });
    rows.push({
      key: 'redirects',
      label: 'Redirects',
      value: `After submit: ${asString(c.successUrl) ?? 'Not set'} · after confirming: ${asString(c.confirmedUrl) ?? 'Branded page'} · on error: ${asString(c.errorUrl) ?? 'Not set'}`,
    });
    rows.push({
      key: 'allowed-origins',
      label: 'Allowed sites',
      value: asArray(c.allowedOrigins).length ? asArray(c.allowedOrigins).join(', ') : 'Any site',
    });
    rows.push({ key: 'bot-check', label: 'Bot check', value: c.turnstile === true ? 'Cloudflare Turnstile required' : 'None' });
    rows.push({
      key: 'hosted-pages',
      label: 'Hosted pages',
      value: Object.keys(asObject(c.hostedPages)).length ? 'Overrides the workspace brand on this form' : 'Workspace brand',
    });
    rows.push({
      key: 'sends',
      label: 'Effect',
      value: 'New submissions use this form; the confirmation e-mail follows its double opt-in settings.',
      notes: ['Existing subscribers are not migrated by publishing.'],
    });
  } else if (type === 'experience') {
    const variants = asArray(c.variants).map(asObject);
    const rollout = asObject(c.rollout);
    const goal = asObject(c.goal);
    const analysis = asObject(c.analysis);
    rows.push({ key: 'placement', label: 'Placement', value: asString(c.placement) ?? 'Not set' });
    rows.push({ key: 'priority', label: 'Priority', value: String(asNumber(c.priority) ?? 100) });
    rows.push({
      key: 'targeting',
      label: 'Targeting',
      value: Object.keys(asObject(c.targeting)).length ? 'Targeted visitors' : 'All eligible visitors',
      condition: c.targeting,
    });
    rows.push({
      key: 'variants',
      label: 'Variants',
      items: variants.map((v, i) => ({
        key: asString(v.id) ?? `variant-${i}`,
        value: `${asString(v.name) ?? 'Variant'} · ${asNumber(v.weight) ?? 0}%`,
      })),
      details: variants.map((v) => ({ label: `${asString(v.name) ?? 'Variant'} content`, value: asObject(v.content) })),
      html: variants.flatMap((v, i) => {
        const content = asObject(v.content);
        return typeof content.html === 'string' ? [{ label: `${asString(v.name) ?? `Variant ${i + 1}`} HTML`, html: content.html }] : [];
      }),
    });
    rows.push({ key: 'holdout', label: 'Holdout', value: `${asNumber(c.holdoutPercent) ?? 0}% see nothing` });
    if (Object.keys(rollout).length)
      rows.push({
        key: 'rollout',
        label: 'Rollout',
        value: `${asArray(rollout.steps).join('% → ')}% · ${asNumber(rollout.stepHours) ?? 0} hours per step`,
        notes: Object.keys(asObject(rollout.guardrail)).length
          ? [
              `Pauses when ${asString(asObject(rollout.guardrail).measure) ?? 'the guardrail'} drops ${asNumber(asObject(rollout.guardrail).maxDropPercent) ?? 0}%`,
            ]
          : undefined,
      });
    if (asString(goal.event)) rows.push({ key: 'goal', label: 'Goal event', value: asString(goal.event)! });
    if (Object.keys(analysis).length)
      rows.push({
        key: 'analysis',
        label: 'Analysis',
        value: `${asString(analysis.method) ?? 'sequential'} · alpha ${asNumber(analysis.alpha) ?? 0.05}${asString(analysis.method) === 'bayesian' ? ` · ${asNumber(analysis.threshold) ?? 0.95} probability` : ''}`,
      });
    rows.push({
      key: 'sends',
      label: 'Effect',
      value: 'Served when the SDK evaluates this placement; visitor consent still applies.',
    });
  } else {
    rows.push({
      key: 'effect',
      label: 'Effect',
      value: 'This definition becomes live on approval; no recipient estimate applies.',
    });
  }

  return rows;
}

function emailEvidence(input: ConsequenceInput, c: Record<string, unknown>, channel: 'email'): ConsequenceEvidence[] {
  const evidence: ConsequenceEvidence[] = [];
  const template = asString(c.template);
  if (input.type === 'broadcast') {
    const dep = template ? input.dependencies?.[template] : undefined;
    const bundleVersion = template ? input.bundleVersions?.[template] : undefined;
    if (input.dependenciesLoading)
      evidence.push({ key: 'template-live', label: 'Template live', status: 'not-checked', value: 'Checking…' });
    else if (bundleVersion != null)
      evidence.push({
        key: 'template-live',
        label: 'Template live',
        status: 'ready',
        value: `Saved v${bundleVersion} · in this bundle`,
        detail: dep?.publishedVersion != null ? `Published v${dep.publishedVersion} today` : 'Publishes with this review',
      });
    else if (dep?.publishedVersion != null)
      evidence.push({ key: 'template-live', label: 'Template live', status: 'ready', value: `Live v${dep.publishedVersion}` });
    else
      evidence.push({
        key: 'template-live',
        label: 'Template live',
        status: 'attention',
        value: 'Not live',
        detail: 'Publish the template first, or submit it together in a bundle.',
      });
  }

  const purposeKey = input.templatePurpose?.purpose ?? asString(c.purpose);
  const purpose = input.purposes?.find((p) => p.key === purposeKey);
  const stream: 'marketing' | 'transactional' =
    purpose && (purpose.basis === 'contract' || purpose.basis === 'legal_obligation') ? 'transactional' : 'marketing';

  if (input.providerError)
    evidence.push({ key: 'provider', label: 'Provider', status: 'not-checked', value: 'Not checked', detail: input.providerError });
  else if (input.evidenceLoading && !input.provider)
    evidence.push({ key: 'provider', label: 'Provider', status: 'not-checked', value: 'Checking…' });
  else if (!input.provider)
    evidence.push({
      key: 'provider',
      label: 'Provider',
      status: 'not-checked',
      value: 'Not checked',
      detail: 'Your role cannot check the e-mail provider.',
    });
  else if (input.provider.adapter === 'log')
    evidence.push({
      key: 'provider',
      label: 'Provider',
      status: 'attention',
      value: 'Log adapter — no external delivery',
      detail: `${stream === 'marketing' ? 'Marketing' : 'Transactional'} provider is enabled.`,
    });
  else if (stream === 'marketing' && !input.provider.marketing)
    evidence.push({ key: 'provider', label: 'Provider', status: 'attention', value: 'No marketing provider configured' });
  else if (stream === 'transactional' && !input.provider.transactional)
    evidence.push({ key: 'provider', label: 'Provider', status: 'attention', value: 'No transactional provider configured' });
  else
    evidence.push({
      key: 'provider',
      label: 'Provider',
      status: 'ready',
      value: `${stream === 'marketing' ? 'Marketing' : 'Transactional'} provider configured`,
    });

  if (input.domainsError)
    evidence.push({ key: 'domains', label: 'Sending domain', status: 'not-checked', value: 'Not checked', detail: input.domainsError });
  else if (input.evidenceLoading && !input.domains)
    evidence.push({ key: 'domains', label: 'Sending domain', status: 'not-checked', value: 'Checking…' });
  else if (!input.domains) {
    evidence.push({
      key: 'domains',
      label: 'Sending domain',
      status: 'not-checked',
      value: 'Not checked',
      detail: 'Your role cannot check sending domains.',
    });
  } else {
    const matching = input.domains.domains.filter((d) => d.uses.includes(stream));
    if (!matching.length)
      evidence.push({
        key: 'domains',
        label: 'Sending domain',
        status: 'attention',
        value: `No sending domain for ${stream} mail`,
      });
    for (const domain of matching) {
      const status: EvidenceStatus =
        domain.dkim.length === 0
          ? 'not-checked'
          : domain.ok && domain.dkim.every((d) => d.ok) && domain.spf.ok && domain.dmarc.ok
            ? 'ready'
            : 'attention';
      evidence.push({
        key: `domain:${domain.domain}`,
        label: 'Sending domain',
        status,
        value:
          status === 'ready'
            ? `${domain.domain}: SPF, DKIM and DMARC pass`
            : domain.dkim.length === 0
              ? `${domain.domain}: DKIM not checked — selectors required`
              : `${domain.domain}: SPF, DKIM or DMARC needs attention`,
        detail:
          status === 'ready'
            ? `Checked ${input.formatWhen ? input.formatWhen(input.domains.checkedAt) : input.domains.checkedAt}`
            : 'SPF, DKIM and DMARC are checked from the admin configuration.',
      });
    }
  }

  if (input.purposesError)
    evidence.push({
      key: 'consent-purpose',
      label: 'Consent purpose',
      status: 'not-checked',
      value: 'Not checked',
      detail: input.purposesError,
    });
  else if (!input.purposes) evidence.push({ key: 'consent-purpose', label: 'Consent purpose', status: 'not-checked', value: 'Checking…' });
  else if (!purposeKey) evidence.push({ key: 'consent-purpose', label: 'Consent purpose', status: 'attention', value: 'No purpose set' });
  else if (!purpose)
    evidence.push({
      key: 'consent-purpose',
      label: 'Consent purpose',
      status: 'attention',
      value: `Purpose ${purposeKey} is not configured`,
    });
  else {
    const topic = input.templatePurpose?.topic ?? asString(c.topic);
    const channelOk = purpose.channels.includes(channel);
    const topicOk = !topic || !purpose.topics?.length || purpose.topics.some((t) => t.key === topic);
    evidence.push({
      key: 'consent-purpose',
      label: 'Consent purpose',
      status: channelOk && topicOk ? 'ready' : 'attention',
      value: !channelOk
        ? `${purpose.name} is not allowed on ${channel}`
        : !topicOk
          ? `Topic ${topic} is not under ${purpose.name}`
          : `Purpose configured · ${purpose.name} · ${purpose.basis}`,
      detail:
        channelOk && topicOk
          ? `Per-person consent, topic preferences and suppression are checked at send time.${purpose.requiresDoubleOptIn ? ' This purpose requires double opt-in.' : ''}`
          : undefined,
    });
  }
  return evidence;
}

export function deriveConsequences(input: ConsequenceInput): ConsequenceModel {
  const formatWhen = input.formatWhen ?? ((iso) => iso ?? '—');
  const c = asObject(input.content);
  const rows: ConsequenceRow[] = [];
  const notes: string[] = [];
  const type = input.type;

  rows.push({
    key: 'publishes',
    label: 'Publishes',
    value: `${input.name} · ${typeLabel(type)} · Saved v${input.version}`,
    notes: [input.publishedVersion != null ? `Replaces Published v${input.publishedVersion}` : 'Nothing live yet'],
  });

  if (type === 'broadcast') {
    const sendAt = asString(c.sendAt);
    rows.push({
      key: 'when',
      label: 'When',
      value: sendAt ? formatWhen(sendAt) : 'On publication',
      notes: [asString(c.sendWindow) ? 'Inside each reader’s local send window.' : 'Arrival time varies by reader.'],
    });
  } else {
    rows.push({ key: 'when', label: 'When', value: 'On approval' });
  }

  rows.push(...typeRows(input, c, formatWhen));
  rows.push(dependencyRow(input));

  let audience: ConsequenceAudience | null = null;
  if (type === 'broadcast') audience = audienceFromBroadcast(input);
  else if (type === 'segment') audience = audienceFromSegment(input);
  else notes.push('No recipient estimate applies: publishing alone sends nothing.');

  const template = asString(c.template) ?? (type === 'email_template' ? input.artifactId : undefined);
  // SMS and push have no e-mail provider or DNS evidence, so those checks are not shown at all.
  const evidence: ConsequenceEvidence[] =
    type === 'email_template' || (type === 'broadcast' && isEmailTemplateId(template))
      ? emailEvidence(input, { ...c, ...(type === 'email_template' ? { purpose: asString(c.purpose) } : {}) }, 'email')
      : [];

  if (type === 'email_template') {
    notes.push('Used when a sending artifact references it; publishing alone sends nothing.');
    const bundledUnpublished = dependencyRefs(type, input.content, input.bundleVersions).some(
      (r) => r.bundleVersion != null && input.dependencies?.[r.id]?.publishedVersion == null,
    );
    if (bundledUnpublished) notes.push('Bundled block render unavailable before publication.');
  }
  if (type === 'segment') notes.push('Membership is not consent, and it is never an eligible-recipient count.');
  if (type === 'journey') notes.push('No inferred eligible audience or completion ETA.');
  if (type === 'experience') notes.push('No new SDK simulation or audience estimate.');
  if (
    type === 'broadcast' &&
    input.bundleVersions &&
    dependencyRefs('broadcast', input.content, input.bundleVersions).some(
      (r) => input.bundleVersions?.[r.id] != null && r.id.startsWith('seg_'),
    )
  )
    notes.push('Pre-publication audience checks do not simulate future bundled segment membership.');

  return {
    heading: consequenceHeading(input.status),
    rows,
    evidence,
    audience,
    notes: [...new Set(notes)],
    sending: SENDING.has(type),
    templateCheck: input.templateCheck ?? null,
  };
}

/** Workspace proposals are not versioned artifacts and use their own read (#106, #498). */
export function deriveProposalConsequences(proposal: {
  changes: { name?: { from: string; to: string }; timeZone?: { from: string; to: string } };
  note: string;
}): ConsequenceModel {
  const rows: ConsequenceRow[] = [
    { key: 'effect', label: 'Effect', value: 'Applies workspace settings immediately on approval.' },
    {
      key: 'settings',
      label: 'Settings',
      items: [
        ...(proposal.changes.name
          ? [{ key: 'name', value: 'Name', note: `${proposal.changes.name.from} → ${proposal.changes.name.to}` }]
          : []),
        ...(proposal.changes.timeZone
          ? [{ key: 'time-zone', value: 'Time zone', note: `${proposal.changes.timeZone.from} → ${proposal.changes.timeZone.to}` }]
          : []),
      ],
    },
    { key: 'when', label: 'When', value: 'Immediately on approval.' },
  ];
  if (proposal.changes.timeZone)
    rows.push({
      key: 'time-zone-note',
      label: 'Time zone',
      value: 'Changes display time zone; stored send instants stay the same.',
    });
  return {
    heading: 'If approved',
    rows,
    evidence: [],
    audience: null,
    notes: [proposal.note].filter(Boolean),
    sending: false,
    templateCheck: null,
  };
}
