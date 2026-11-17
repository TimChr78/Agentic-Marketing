import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { type Db, enqueueOutbox, type Tx } from '@agentic-marketing/db';
import { fingerprintParts, type LinkSigner, sendRequestHash } from '@agentic-marketing/email';
import { type ConsentInput, type ResolvedEvent, recordConsentEvidence, withIdentityLock } from '@agentic-marketing/profiles';
import { CONFIRMED, DOI_DAYS, type DoiToken, publishedForm, SUBMITTED } from './forms';
import { IMPORTED } from './import';

// The consent hook (after identity resolution): turns form submissions, confirmations and imports
// into consent ledger entries, with proof. It trusts only events whose source is a form (frm_) or
// an import batch (imp_): the gateway sets the source id, so a write key cannot forge them.

export interface ConsentHookDeps {
  db: Db;
  links: LinkSigner;
  /** Base URL for the confirmation link (the links URL). */
  linksUrl: string;
  /** The workspace's verified brand links URL, when the install has a registry (#185). */
  linksUrlFor?: (workspaceId: string) => Promise<string>;
}

const purposesOf = async (tx: Tx) => (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;

/**
 * Records the evidence a form or import adds (#936). Every distinct action is evidence, whether
 * or not it changes the current status: keeping a same-status signup means a delayed withdrawal
 * with an older action time cannot win. Only an exact duplicate or a redelivered event is folded.
 */
async function recordChanges(tx: Tx, ws: string, profileId: string, records: ConsentInput[]) {
  if (!records.length) return 0;
  return recordConsentEvidence(tx, ws, profileId, await purposesOf(tx), records);
}

/** What a double opt-in confirmation needs, prepared before the consent transaction (#978 part 2). */
interface DoiSend {
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/**
 * The send intent for a double opt-in submission, prepared outside the write transaction: the
 * published form version, the brand link host and the signed confirmation link are all read or
 * built here. The transaction only writes the intent, so no key-provider or link-host call runs
 * under the locks the consent batch takes.
 */
async function prepareDoi(workspaceId: string, { event: e, profileId }: ResolvedEvent, deps: ConsentHookDeps): Promise<DoiSend | null> {
  const p = e.properties as Record<string, unknown>;
  if (!e.sourceId.startsWith('frm_') || e.name !== SUBMITTED || !p.double_opt_in) return null;
  const form = await deps.db.withWorkspace(workspaceId, (tx) => publishedForm(tx, String(p.form_id), Number(p.form_version)));
  if (!form?.def.confirmationTemplate) return null;
  const token: DoiToken = {
    k: 'doi',
    w: workspaceId,
    f: String(p.form_id),
    v: Number(p.form_version),
    a: e.anonymousId,
    s: e.timestamp,
    x: Date.now() + DOI_DAYS * 86_400_000,
  };
  const linksUrl = (await deps.linksUrlFor?.(workspaceId)) ?? deps.linksUrl;
  const idempotencyKey = `doi:${e.messageId}`;
  return {
    idempotencyKey,
    payload: {
      profileId,
      templateId: form.def.confirmationTemplate,
      idempotencyKey,
      // Stable identifiers only: a redelivery of the same submission replays the confirmation,
      // including after a profile merge (the resolved profile id is deliberately absent).
      requestHash: sendRequestHash(
        'email',
        fingerprintParts.doi({
          submission: e.messageId,
          // The values the form wrote into the event, unchanged: only the hash's field names moved.
          form: p.form_id as string,
          formVersion: p.form_version as number,
          template: form.def.confirmationTemplate,
        }),
      ),
      data: { confirm_url: `${linksUrl}/f/confirm/${deps.links.sign(token)}` },
    },
  };
}

async function handle(tx: Tx, ws: string, { event: e, profileId }: ResolvedEvent, doi?: DoiSend | null) {
  const p = e.properties as Record<string, unknown>;
  const purposes = Array.isArray(p.purposes) ? (p.purposes as string[]) : [];
  // The action time, never the worker's processing time (#928). Form and confirmation events set
  // their timestamp server-side, and `correctedTimestamp` clamps it to the receive time, so a
  // submitter cannot post-date a signup past a withdrawal that happened later.
  const recordedAt = new Date(e.timestamp);
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
        purposes.map((purpose) => ({
          purpose,
          status: 'granted' as const,
          source: 'form' as const,
          proof,
          messageId: e.messageId,
          recordedAt,
        })),
      );
    // The confirmation send is a durable intent in this transaction (#978 part 2): the dispatcher
    // calls `requestEmail` after commit and keeps the `doi:<message>` idempotency key, so a
    // redelivery or a retried batch never sends twice.
    if (!doi) return;
    await enqueueOutbox(tx, ws, {
      kind: 'doi_send',
      operationKey: doi.idempotencyKey,
      payload: doi.payload,
    });
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
        recordedAt,
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
    // The import's own (server-assigned) time is the ceiling: a historical timestamp is kept as
    // given, but a future-dated grant cannot outrank a withdrawal that happens after the import.
    const importedAt = new Date(e.timestamp);
    return recordChanges(
      tx,
      ws,
      profileId,
      consent.map((c) => {
        const given = c.recordedAt ? new Date(c.recordedAt) : importedAt;
        return {
          purpose: c.purpose,
          status: c.status,
          source: 'import' as const,
          messageId: e.messageId,
          recordedAt: given.getTime() > importedAt.getTime() ? importedAt : given,
          recordedBy: typeof p.imported_by === 'string' ? p.imported_by : undefined,
          proof: { ...(c.proof ?? {}), import_batch: e.sourceId, import_label: p.label },
        };
      }),
    );
  }
}

export function consentHook(deps: ConsentHookDeps) {
  return async (workspaceId: string, resolved: ResolvedEvent[]) => {
    const ours = resolved.filter((r) => r.event.sourceId.startsWith('frm_') || r.event.sourceId.startsWith('imp_'));
    if (!ours.length) return;
    // DOI send intents are prepared outside the write transaction (#978 part 2). A read failure
    // here leaves the submission recorded with no confirmation, which is what a form with no
    // published confirmation template does; the next redelivery prepares it again.
    const doi = new Map<string, DoiSend>();
    for (const r of ours) {
      const plan = await prepareDoi(workspaceId, r, deps);
      if (plan) doi.set(`${r.event.sourceId}:${r.event.messageId}`, plan);
    }
    await deps.db.withWorkspace(workspaceId, async (tx) => {
      // The lock comes before the batch: a form, confirmation or import event resolves the person
      // and appends evidence in the same serialised order as a merge. The double opt-in send intent
      // was prepared outside this transaction (#978 part 2), so no provider call runs under it.
      await withIdentityLock(tx, workspaceId, async () => {
        for (const r of ours) await handle(tx, workspaceId, r, doi.get(`${r.event.sourceId}:${r.event.messageId}`));
      });
    });
  };
}
