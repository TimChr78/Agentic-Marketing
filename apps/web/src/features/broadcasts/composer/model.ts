import type { Out } from '../../../app/api';
import { resolveConsentTopic } from '../../../lib/consentTopic';
import { formatDateTime } from '../../../ui/time';
import type { PreviewSource } from '../../previews/previewSource';

// The broadcast composer's pure projections (Phase 25, #497). The checklist separates evidence
// (template, provider, DNS, purpose configuration) from consent, and the audience estimate says
// only what the saved check actually measured. Kept free of hooks so the states are unit-tested
// without an API.

export type Channel = 'email' | 'sms' | 'push';
export type Stream = 'marketing' | 'transactional';
export type CheckStatus = 'ready' | 'attention' | 'not-checked' | 'not-applicable';

export interface SubjectTest {
  subjects: string[];
  samplePercent: number;
  metric: 'click' | 'open';
  decideAfter: string;
}

export interface SendWindow {
  start: string;
  end: string;
  days?: string[];
  maxDelay?: string;
}

export interface StagedSend {
  canaryPercent: number;
  wait: string;
  maxBounceRate: number;
  maxComplaintRate: number;
  maxUnsubscribeRate: number;
  minCanary: number;
}

export interface ComposerBroadcastContent {
  template?: string;
  topic?: string;
  segment?: string;
  sendAt?: string;
  description?: string;
  subjectTest?: SubjectTest;
  stagedSend?: StagedSend;
  sendWindow?: SendWindow;
  archive?: { publish?: boolean; slug?: string; summary?: string };
}

export type ComposerPurpose = Out<'purposes.list'>['purposes'][number];
export type ComposerSystemStatus = Out<'system.status'>;
export type ComposerSendingDomains = Out<'sendingDomains.list'>;
export type ComposerEstimate = Out<'broadcasts.preview'>;

export interface CheckRow {
  key: 'template' | 'provider' | 'domain' | 'consent';
  label: string;
  status: CheckStatus;
  statusLabel: string;
  /** The evidence under the label, one line per fact or domain. */
  details: string[];
  /** An existing authorized destination, only for people allowed to open it. */
  link?: { to: string; label: string };
  /** A local retry is available for a failed read. */
  retry?: boolean;
}

const STATUS_LABEL: Record<CheckStatus, string> = {
  ready: 'Ready',
  attention: 'Needs attention',
  'not-checked': 'Not checked',
  'not-applicable': 'Not applicable',
};

export const statusLabel = (status: CheckStatus): string => STATUS_LABEL[status];

export function channelOfTemplate(templateId: string | undefined | null): Channel | null {
  if (!templateId) return null;
  if (templateId.startsWith('eml_')) return 'email';
  if (templateId.startsWith('sms_')) return 'sms';
  if (templateId.startsWith('psh_')) return 'push';
  return null;
}

/** The gateway's existing stream rule: contract and legal obligation go to transactional mail. */
export function streamOfBasis(basis: string | undefined | null): Stream {
  return basis === 'contract' || basis === 'legal_obligation' ? 'transactional' : 'marketing';
}

const permissionFailure = (error: string | null | undefined) => !!error && /forbidden|permission|not allowed|your role|403/i.test(error);

const roleNote = (error: string) => (permissionFailure(error) ? 'Your role cannot check this.' : 'The read failed; retry to check again.');

export interface TemplateCheckInput {
  templateId?: string;
  loading: boolean;
  error: string | null;
  artifact?: { name: string; publishedVersion: number | null } | null;
  exactLoading?: boolean;
  exactError?: string | null;
}

/**
 * Template live: the published pointer is the only evidence. A latest saved version, a draft or
 * `latestState` never counts as live, and an unreadable pointer is never Ready.
 */
export function templateCheck(input: TemplateCheckInput): CheckRow {
  const base = { key: 'template' as const, label: 'Template live' };
  if (!input.templateId)
    return { ...base, status: 'not-checked', statusLabel: statusLabel('not-checked'), details: ['Choose a template first.'] };
  if (input.error)
    return {
      ...base,
      status: 'not-checked',
      statusLabel: statusLabel('not-checked'),
      details: [input.error, permissionFailure(input.error) ? 'Your role cannot check this.' : 'Retry to check the template.'],
      retry: !permissionFailure(input.error),
    };
  if (input.loading || !input.artifact)
    return { ...base, status: 'not-checked', statusLabel: statusLabel('not-checked'), details: ['Checking the template…'] };
  if (input.artifact.publishedVersion == null)
    return {
      ...base,
      status: 'attention',
      statusLabel: statusLabel('attention'),
      details: [input.artifact.name, 'Not live — publish the template first or submit together in an existing bundle.'],
    };
  if (input.exactError)
    return {
      ...base,
      status: 'not-checked',
      statusLabel: statusLabel('not-checked'),
      details: [input.artifact.name, input.exactError, roleNote(input.exactError)],
      retry: !permissionFailure(input.exactError),
    };
  if (input.exactLoading)
    return {
      ...base,
      status: 'not-checked',
      statusLabel: statusLabel('not-checked'),
      details: [input.artifact.name, 'Checking the live template version…'],
    };
  return {
    ...base,
    status: 'ready',
    statusLabel: statusLabel('ready'),
    details: [`${input.artifact.name} · Live v${input.artifact.publishedVersion}`],
  };
}

export interface ProviderCheckInput {
  templateId?: string;
  channel: Channel | null;
  templateLoading: boolean;
  templateError: string | null;
  purposesLoading: boolean;
  purposesError: string | null;
  purpose: ComposerPurpose | undefined;
  /** The exact live template content is still being read, so the purpose is not known yet. */
  purposeLoading?: boolean;
  purposeError?: string | null;
  status: ComposerSystemStatus | undefined;
  statusLoading: boolean;
  statusError: string | null;
  canAdmin: boolean;
}

const ADAPTER_LABEL: Record<string, string> = {
  ses: 'SES',
  smtp: 'SMTP',
  postmark: 'Postmark',
  brevo: 'Brevo',
  cloudflare: 'Cloudflare',
  log: 'Log',
};

export function providerCheck(input: ProviderCheckInput): CheckRow {
  const base = { key: 'provider' as const, label: 'Provider' };
  const notChecked = (details: string[], retry = false): CheckRow => ({
    ...base,
    status: 'not-checked',
    statusLabel: statusLabel('not-checked'),
    details,
    ...(retry ? { retry: true } : {}),
  });
  if (!input.templateId) return notChecked(['Choose a template first.']);
  if (input.templateLoading) return notChecked(['Checking the template…']);
  if (input.templateError) return notChecked([input.templateError, roleNote(input.templateError)]);
  if (input.channel && input.channel !== 'email')
    return {
      ...base,
      status: 'not-applicable',
      statusLabel: statusLabel('not-applicable'),
      details: ['The provider check is for e-mail; SMS and push providers are not checked here.'],
    };
  if (input.purposeError) return notChecked([input.purposeError, roleNote(input.purposeError)]);
  if (input.purposesError) return notChecked([input.purposesError, roleNote(input.purposesError)]);
  if (input.purposesLoading || input.purposeLoading) return notChecked(['Checking the template purpose…']);
  if (!input.purpose) return notChecked(['The template purpose is not configured, so the delivery stream is unknown.']);
  const stream = streamOfBasis(input.purpose.basis);
  if (input.statusError) return notChecked([input.statusError, roleNote(input.statusError)], !permissionFailure(input.statusError));
  if (input.statusLoading || !input.status) return notChecked(['Checking the provider…']);
  const configured = input.status.emailProvider[stream];
  const link = input.canAdmin ? { to: '/settings/providers', label: 'Providers' } : undefined;
  if (!configured)
    return {
      ...base,
      status: 'attention',
      statusLabel: statusLabel('attention'),
      details: [
        `No ${stream} provider configured.`,
        ...(input.canAdmin ? [] : ['Ask a workspace admin to add one in Settings → Providers.']),
      ],
      ...(link ? { link } : {}),
    };
  if (input.status.emailProvider.adapter === 'log')
    return {
      ...base,
      status: 'attention',
      statusLabel: statusLabel('attention'),
      details: ['Log adapter — no external delivery.', 'Configure a real provider before sending.'],
      ...(link ? { link } : {}),
    };
  const adapter = input.status.emailProvider.adapter;
  return {
    ...base,
    status: 'ready',
    statusLabel: statusLabel('ready'),
    details: [
      `${stream === 'marketing' ? 'Marketing' : 'Transactional'} provider configured${adapter ? ` · ${ADAPTER_LABEL[adapter] ?? adapter}` : ''}.`,
    ],
  };
}

export interface DomainCheckInput {
  templateId?: string;
  channel: Channel | null;
  stream: Stream | null;
  data: ComposerSendingDomains | undefined;
  loading: boolean;
  error: string | null;
  canAdmin: boolean;
}

function domainLine(domain: ComposerSendingDomains['domains'][number], checkedAt: string): string {
  const dkim =
    domain.dkim.length === 0
      ? 'DKIM not checked — selectors required'
      : domain.dkim.every((d) => d.ok)
        ? `DKIM ${domain.dkim.length === 1 ? 'selector' : 'selectors'} found`
        : 'DKIM failed';
  return `${domain.domain} · SPF ${domain.spf.ok ? 'found' : 'missing'} · DMARC ${domain.dmarc.ok ? 'found' : 'missing'} · ${dkim} · checked ${formatDateTime(checkedAt, { zone: true })}`;
}

/** Sending domain: every matched domain's records are shown. Empty DKIM is never proof. */
export function domainCheck(input: DomainCheckInput): CheckRow {
  const base = { key: 'domain' as const, label: 'Sending domain' };
  const notChecked = (details: string[], retry = false): CheckRow => ({
    ...base,
    status: 'not-checked',
    statusLabel: statusLabel('not-checked'),
    details,
    ...(retry ? { retry: true } : {}),
  });
  if (!input.templateId) return notChecked(['Choose a template first.']);
  if (input.channel && input.channel !== 'email')
    return {
      ...base,
      status: 'not-applicable',
      statusLabel: statusLabel('not-applicable'),
      details: ['Sending-domain checks apply to e-mail broadcasts only.'],
    };
  if (!input.stream) return notChecked(['The template purpose is not configured, so the delivery stream is unknown.']);
  if (input.error) return notChecked([input.error, roleNote(input.error)], !permissionFailure(input.error));
  if (input.loading || !input.data) return notChecked(['Checking the sending domain…']);
  const matching = input.data.domains.filter((d) => d.uses.includes(input.stream as Stream));
  const link = input.canAdmin ? { to: '/settings/providers', label: 'Providers' } : undefined;
  if (matching.length === 0)
    return {
      ...base,
      status: 'attention',
      statusLabel: statusLabel('attention'),
      details: [
        `No sending domain for ${input.stream} mail.`,
        ...(input.canAdmin ? [] : ['Ask a workspace admin to add one in Settings → Providers.']),
      ],
      ...(link ? { link } : {}),
    };
  const lines = matching.map((d) => domainLine(d, input.data!.checkedAt));
  const failed = matching.some((d) => !d.spf.ok || !d.dmarc.ok || d.dkim.some((selector) => !selector.ok));
  if (failed)
    return {
      ...base,
      status: 'attention',
      statusLabel: statusLabel('attention'),
      details: ['DNS records need attention.', ...lines],
      ...(link ? { link } : {}),
    };
  if (matching.some((d) => d.dkim.length === 0))
    return notChecked(['DKIM not checked — selectors required so an empty result is never treated as proof.', ...lines]);
  return {
    ...base,
    status: 'ready',
    statusLabel: statusLabel('ready'),
    details: ['SPF, DKIM and DMARC found.', ...lines],
  };
}

export interface ConsentCheckInput {
  templateId?: string;
  channel: Channel | null;
  templateLoading: boolean;
  templateError: string | null;
  /** The exact live template content is still being read, so its purpose is not known yet. */
  contentLoading?: boolean;
  contentError?: string | null;
  templatePurpose?: string;
  templateTopic?: string;
  broadcastTopic?: string;
  purposes: ComposerPurpose[] | undefined;
  purposesLoading: boolean;
  purposesError: string | null;
}

const CONSENT_FOOTNOTE = 'Per-person consent, topic preferences and suppression are checked at send time.';

/** Consent purpose evidence: configuration only, never a claim that the audience consented. */
export function consentCheck(input: ConsentCheckInput): CheckRow {
  const base = { key: 'consent' as const, label: 'Consent purpose' };
  const notChecked = (details: string[], retry = false): CheckRow => ({
    ...base,
    status: 'not-checked',
    statusLabel: statusLabel('not-checked'),
    details: [...details, CONSENT_FOOTNOTE],
    ...(retry ? { retry: true } : {}),
  });
  const attention = (details: string[]): CheckRow => ({
    ...base,
    status: 'attention',
    statusLabel: statusLabel('attention'),
    details: [...details, CONSENT_FOOTNOTE],
  });
  if (!input.templateId) return notChecked(['Choose a template first.']);
  if (input.templateLoading) return notChecked(['Checking the template…']);
  if (input.templateError) return notChecked([input.templateError, roleNote(input.templateError)]);
  if (input.contentError) return notChecked([input.contentError, roleNote(input.contentError)]);
  if (input.purposesError) return notChecked([input.purposesError, roleNote(input.purposesError)], !permissionFailure(input.purposesError));
  if (input.contentLoading) return notChecked(['Checking the template purpose…']);
  if (!input.templatePurpose) return attention(['The template has no purpose.', 'Set a purpose on the template before sending.']);
  if (input.purposesLoading || !input.purposes) return notChecked(['Checking the purpose…']);
  const purpose = input.purposes.find((p) => p.key === input.templatePurpose);
  if (!purpose)
    return attention([
      `Purpose “${input.templatePurpose}” is not configured.`,
      'Add it to the purposes artifact or change the template’s purpose.',
    ]);
  if (input.channel && !purpose.channels.includes(input.channel))
    return attention([
      `Purpose “${purpose.name}” does not include the ${input.channel} channel.`,
      'Add the channel to the purpose or change the template’s purpose.',
    ]);
  const topic = resolveConsentTopic(input.broadcastTopic, input.templateTopic);
  if (topic && !purpose.topics.some((t) => t.key === topic))
    return attention([`Topic “${topic}” is not under purpose “${purpose.name}”.`, 'Choose a topic under this purpose or remove it.']);
  return {
    ...base,
    status: 'ready',
    statusLabel: statusLabel('ready'),
    details: [
      `Purpose configured · ${purpose.name} · ${purpose.basis}`,
      ...(purpose.requiresDoubleOptIn ? ['Consent must be a confirmed opt-in.'] : []),
      CONSENT_FOOTNOTE,
    ],
  };
}

export interface EstimateSummary {
  headline: string;
  detail: string;
  skipped: { reason: string; label: string; count: number }[];
}

const SKIP_LABEL: Record<string, string> = {
  no_consent: 'No consent for the purpose',
  no_lawful_basis: 'No lawful basis for the purpose',
  unknown_purpose: 'Purpose not configured',
  suppressed: 'Suppressed (bounced or complained)',
  unsubscribed: 'Unsubscribed',
  no_email: 'No e-mail address',
  no_address: 'No e-mail address',
  no_profile: 'Person not found',
  frequency_cap: 'Over the frequency cap',
};

/**
 * The check's own numbers. `wouldSend` is never scaled to the full audience: `checked` is the
 * evidence, and a skipped reason stays visible even at zero.
 */
export function estimateSummary(data: ComposerEstimate): EstimateSummary {
  const count = (n: number) => n.toLocaleString('en-US');
  const headline =
    data.checked === 0
      ? 'No members checked'
      : data.wouldSend === 0
        ? 'No eligible recipients in this check'
        : `${count(data.wouldSend)} eligible in current check`;
  const detail =
    data.checked === 0
      ? data.audience === 0
        ? 'No members in the segment'
        : `Estimate · 0 of ${count(data.audience)} members checked`
      : data.checked === data.audience
        ? `Current check · all ${count(data.audience)} members checked`
        : `Estimate · ${count(data.checked)} of ${count(data.audience)} members checked`;
  return {
    headline,
    detail,
    skipped: Object.entries(data.wouldSkip).map(([reason, n]) => ({
      reason,
      label: SKIP_LABEL[reason] ?? reason.replace(/_/g, ' '),
      count: n,
    })),
  };
}

const UNITS: [RegExp, string][] = [
  [/^P(\d+)D$/, 'day'],
  [/^PT(\d+)H$/, 'hour'],
  [/^PT(\d+)M$/, 'minute'],
  [/^PT(\d+)S$/, 'second'],
];

/** A short human duration for the window helper; an unfamiliar ISO value is shown unchanged. */
export function humanDuration(iso: string | undefined): string {
  if (!iso) return '1 day';
  for (const [pattern, unit] of UNITS) {
    const m = pattern.exec(iso);
    if (m) {
      const n = Number(m[1]);
      return `${n.toLocaleString('en-US')} ${unit}${n === 1 ? '' : 's'}`;
    }
  }
  return iso;
}

const DAY_LABEL: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export function daysLabel(days: string[] | undefined): string {
  if (!days || days.length === 0 || days.length === 7) return 'every day';
  return days.map((d) => DAY_LABEL[d] ?? d).join(', ');
}

/** "09:00–17:00 in each reader's time zone · every day · maximum wait 1 day". */
export function windowSummary(window: SendWindow): string {
  return `${window.start}–${window.end} in each reader’s time zone · ${daysLabel(window.days)} · maximum wait ${humanDuration(window.maxDelay ?? 'P1D')}`;
}

/** The absolute instant in the workspace zone, or the lack of one. */
export function scheduleSummary(content: ComposerBroadcastContent): string {
  return content.sendAt ? formatDateTime(content.sendAt, { zone: true }) : 'On publication';
}

/**
 * The outer preview label. An unsaved draft is based on the saved version it grew from; a clean
 * render names the exact saved version, and Published only when that version is the live pointer.
 */
export function previewSourceFor(input: { dirty: boolean; version: number; publishedVersion: number | null }): PreviewSource {
  if (input.dirty) return { kind: 'unsaved', baseVersion: input.version };
  if (input.publishedVersion === input.version) return { kind: 'published', version: input.version };
  return { kind: 'saved', version: input.version };
}

/** Whether the whole checklist can refresh: a failed read is retried by its own row. */
export const hasRetry = (rows: CheckRow[]) => rows.some((row) => row.retry);
