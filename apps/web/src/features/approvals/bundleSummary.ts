import type { Out } from '../../app/api';
import { typeLabel } from '../../app/artifactRoutes';

type Detail = Out<'approvals.get'>;

// #498 review: a bundle reviewer needs the consequence of every member before choosing one. This
// is derived only from that member's exact approvals.get response: no preview, dependency or
// audience read, and never a merged total across members.

export interface BundleMemberSummary {
  publishes: string;
  live: string;
  when: string;
  audience?: string;
  consent?: string;
  effect?: string;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function audienceOf(type: string, content: Record<string, unknown>): string | undefined {
  if (type === 'broadcast') {
    const segment = asString(content.segment);
    return segment ? `Audience: segment ${segment}` : 'Audience: no segment set';
  }
  if (type === 'segment') {
    const mode = asString(content.mode) ?? 'dynamic';
    if (mode === 'snapshot') return 'Membership: frozen snapshot of another segment';
    if (mode === 'static') return 'Membership: explicit list, changed by hand';
    return 'Membership: dynamic condition';
  }
  if (type === 'form') return 'New submissions use this form';
  return undefined;
}

function consentOf(type: string, content: Record<string, unknown>): string | undefined {
  if (type === 'email_template' || type === 'sms_template' || type === 'push_template') {
    const purpose = asString(content.purpose);
    return purpose ? `Purpose: ${purpose}` : 'Purpose: not set';
  }
  if (type === 'form') {
    const purposes = asArray(content.purposes)
      .filter((p): p is string => typeof p === 'string')
      .join(', ');
    const doubleOptIn = content.doubleOptIn !== false;
    return `Consent: ${purposes || 'no purpose'} · double opt-in ${doubleOptIn ? 'on' : 'off'}`;
  }
  if (type === 'broadcast') return 'Consent and suppression are checked per person at send time';
  return undefined;
}

function effectOf(type: string): string | undefined {
  if (type === 'email_template') return 'Publishing alone sends nothing.';
  if (type === 'sms_template' || type === 'push_template') return 'Publishing alone sends nothing.';
  if (type === 'journey') return 'Enrollment uses the published journey; publishing does not guarantee a send.';
  if (type === 'segment') return 'Membership is not consent; no eligible-recipient count is implied.';
  if (type === 'broadcast') return 'Sends to the reviewed segment once approved.';
  if (type === 'form') return 'Existing subscribers are not migrated by publishing.';
  return 'This definition becomes live on approval; no recipient estimate applies.';
}

export interface BlockRef {
  publishedVersion: number | null;
  missing?: boolean;
}

export interface BlockPin {
  id: string;
  version?: number;
  bundled: boolean;
  publishedVersion: number | null;
  /** Whether the server's published-only block resolver can reproduce this pin. */
  reproducible: boolean;
}

/**
 * Resolve every block the reviewed template references to its bundle override or its published
 * version. The combined `templates.preview` read always expands the published block, so a bundle
 * override that differs (or a block with nothing published) cannot be reproduced there.
 */
export function resolveBlockPins(
  ids: string[],
  bundleVersions: Record<string, number> | undefined,
  refs: Record<string, BlockRef>,
): BlockPin[] {
  return ids.map((id) => {
    const ref = refs[id];
    const publishedVersion = ref?.publishedVersion ?? null;
    const bundleVersion = bundleVersions?.[id];
    if (bundleVersion != null) {
      return {
        id,
        version: bundleVersion,
        bundled: true,
        publishedVersion,
        reproducible: !ref?.missing && publishedVersion === bundleVersion,
      };
    }
    return {
      id,
      version: publishedVersion ?? undefined,
      bundled: false,
      publishedVersion,
      reproducible: !ref?.missing && publishedVersion != null,
    };
  });
}

/** Compact per-member consequences, from the exact `approvals.get` response only. */
export function bundleMemberSummary(approval: Detail, formatWhen: (iso: string) => string): BundleMemberSummary {
  const content = asObject(approval.content);
  const sendAt = approval.artifactType === 'broadcast' ? asString(content.sendAt) : undefined;
  const summary: BundleMemberSummary = {
    publishes: `${typeLabel(approval.artifactType)} · Saved v${approval.version}`,
    live: approval.publishedVersion != null ? `Replaces Published v${approval.publishedVersion}` : 'Nothing live yet',
    when: sendAt ? formatWhen(sendAt) : 'On approval',
  };
  const audience = audienceOf(approval.artifactType, content);
  const consent = consentOf(approval.artifactType, content);
  const effect = effectOf(approval.artifactType);
  if (audience) summary.audience = audience;
  if (consent) summary.consent = consent;
  if (effect) summary.effect = effect;
  return summary;
}
