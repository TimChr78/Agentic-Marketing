import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import type { Db, Tx } from '@agentic-marketing/db';
import { type LinkSigner, requestEmail } from '@agentic-marketing/email';
import type { EventStore } from '@agentic-marketing/events';
import { type ConsentInput, consentStateOf, currentConsent, type ResolvedEvent, recordConsent } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { CONFIRMED, DOI_DAYS, type DoiToken, publishedForm, SUBMITTED } from './forms';
import { IMPORTED } from './import';

// The consent hook (after identity resolution): turns form submissions, confirmations and imports
// into consent ledger entries, with proof. It trusts only events whose source is a form (frm_) or
// an import batch (imp_): the gateway sets the source id, so a write key cannot forge them.

export interface ConsentHookDeps {
  db: Db;
  kp: KeyProvider;
  events: EventStore;
  links: LinkSigner;
  /** Base URL for the confirmation link (the links URL). */
  linksUrl: string;
}

const purposesOf = async (tx: Tx) => (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;

/** Records only what changes the person's current state (a repeated signup is not a new consent). */
async function recordChanges(tx: Tx, ws: string, profileId: string, records: ConsentInput[]) {
  // Compared with the current status, so signing up again after an unsubscribe is a new consent.
  const state = await consentStateOf(tx, ws, profileId);
  const changed = records.filter((r) => currentConsent(state, r.purpose)?.status !== r.status);
  if (changed.length) await recordConsent(tx, ws, profileId, await purposesOf(tx), changed);
}

async function handle(tx: Tx, ws: string, { event: e, profileId }: ResolvedEvent, deps: ConsentHookDeps) {
  const p = e.properties as Record<string, unknown>;
  const purposes = Array.isArray(p.purposes) ? (p.purposes as string[]) : [];
  if (e.sourceId.startsWith('frm_') && e.name === SUBMITTED) {
    const proof = {
      form_id: p.form_id,
      form_version: p.form_version,
      consent_text: p.consent_text,
      page: p.page,
      submitted_at: e.timestamp,
      message_id: e.messageId,
    };
    if (!p.double_opt_in)
      return recordChanges(
        tx,
        ws,
        profileId,
        purposes.map((purpose) => ({ purpose, status: 'granted' as const, source: 'form' as const, proof, messageId: e.messageId })),
      );
    const form = await publishedForm(tx, String(p.form_id), Number(p.form_version));
    if (!form?.def.confirmationTemplate) return;
    const token: DoiToken = {
      k: 'doi',
      w: ws,
      f: String(p.form_id),
      v: Number(p.form_version),
      a: e.anonymousId,
      s: e.timestamp,
      x: Date.now() + DOI_DAYS * 86_400_000,
    };
    const d = await requestEmail(tx, ws, deps.kp, deps.events, {
      profileId,
      templateId: form.def.confirmationTemplate,
      idempotencyKey: `doi:${e.messageId}`,
      data: { confirm_url: `${deps.linksUrl}/f/confirm/${deps.links.sign(token)}` },
    });
    if (d.status !== 'queued') logger.warn({ form: p.form_id, status: d.status, reason: d.reason }, 'confirmation e-mail not queued');
    return;
  }
  if (e.sourceId.startsWith('frm_') && e.name === CONFIRMED)
    return recordChanges(
      tx,
      ws,
      profileId,
      purposes.map((purpose) => ({
        purpose,
        status: 'granted' as const,
        source: 'form' as const,
        messageId: e.messageId,
        proof: {
          form_id: p.form_id,
          form_version: p.form_version,
          consent_text: p.consent_text,
          double_opt_in: true,
          submitted_at: p.submitted_at,
          confirmed_at: e.timestamp,
        },
      })),
    );
  if (e.sourceId.startsWith('imp_') && e.name === IMPORTED) {
    const consent = Array.isArray(p.consent)
      ? (p.consent as { purpose: string; status: ConsentInput['status']; recordedAt?: string; proof?: object }[])
      : [];
    return recordChanges(
      tx,
      ws,
      profileId,
      consent.map((c) => ({
        purpose: c.purpose,
        status: c.status,
        source: 'import' as const,
        messageId: e.messageId,
        recordedAt: c.recordedAt ? new Date(c.recordedAt) : new Date(e.timestamp),
        recordedBy: typeof p.imported_by === 'string' ? p.imported_by : undefined,
        proof: { ...(c.proof ?? {}), import_batch: e.sourceId, import_label: p.label },
      })),
    );
  }
}

export function consentHook(deps: ConsentHookDeps) {
  return async (workspaceId: string, resolved: ResolvedEvent[]) => {
    const ours = resolved.filter((r) => r.event.sourceId.startsWith('frm_') || r.event.sourceId.startsWith('imp_'));
    if (!ours.length) return;
    await deps.db.withWorkspace(workspaceId, async (tx) => {
      for (const r of ours) await handle(tx, workspaceId, r, deps);
    });
  };
}
