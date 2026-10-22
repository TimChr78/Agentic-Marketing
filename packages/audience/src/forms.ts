import { createHash, randomUUID } from 'node:crypto';
import { artifactTypes, DEFAULT_PURPOSES, type FormDefinition, publishedSingleton, publishValidators } from '@agentic-marketing/artifacts';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { LinkSigner } from '@agentic-marketing/email';
import type { EventBus } from '@agentic-marketing/events';
import { acceptItems, sourceLookups } from '@agentic-marketing/ingest';
import { type EgressPolicy, safeRequest } from '@agentic-marketing/integrations';
import { type KeyProvider, readSecret } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, isNotNull } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

// Public signup forms (newsletter and the like). A plain HTML form posts to /f/<form id>, so it
// works without JavaScript and behind a strict CSP; JSON works too. The submission becomes an
// identify and a "Form Submitted" event on the bus, from the form as a trusted source; the consent
// hook then records the consent, or sends the double opt-in confirmation first.

export const SUBMITTED = 'Form Submitted';
export const CONFIRMED = 'Subscription Confirmed';
export const DOI_DAYS = 7;

/** The signed payload of a confirmation link. */
export interface DoiToken {
  k: 'doi';
  w: string; // workspace
  f: string; // form id
  v: number; // form version
  a: string; // anonymous id the submission used
  s: string; // submitted at
  x: number; // expires (epoch ms)
}

export const consentTextHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Publishing a form needs a published confirmation template whose purpose does not itself need consent. */
publishValidators.set('form', async (content, tx: Tx) => {
  const f = content as FormDefinition;
  const problems: string[] = [];
  const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  for (const p of f.purposes) if (!purposes.some((x) => x.key === p)) problems.push(`"${p}" is not a configured purpose`);
  if (f.confirmationTemplate) {
    const [row] = await tx
      .select({ content: schema.artifactVersions.content })
      .from(schema.artifacts)
      .innerJoin(
        schema.artifactVersions,
        and(
          eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
          eq(schema.artifactVersions.artifactId, schema.artifacts.id),
          eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
        ),
      )
      .where(and(eq(schema.artifacts.id, f.confirmationTemplate), isNotNull(schema.artifacts.publishedVersion)));
    const tpl = row?.content as { purpose: string; mjml: string } | undefined;
    if (!tpl) problems.push(`${f.confirmationTemplate} is not a published e-mail template`);
    else {
      const basis = purposes.find((p) => p.key === tpl.purpose)?.basis ?? 'consent';
      if (basis === 'consent')
        problems.push(
          `the confirmation template's purpose "${tpl.purpose}" needs consent, which the person has not given yet; use a contract purpose such as "onboarding"`,
        );
      if (!tpl.mjml.includes('confirm_url')) problems.push('the confirmation template does not use {{ confirm_url }}');
    }
  }
  return problems;
});

export async function publishedForm(tx: Tx, formId: string, version?: number) {
  const [a] = await tx
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, formId), eq(schema.artifacts.type, 'form')));
  const number = version ?? a?.publishedVersion;
  if (!a || !number) return null;
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, formId), eq(schema.artifactVersions.number, number)));
  return v ? { version: number, def: artifactTypes.form.content.parse(v.content) as FormDefinition } : null;
}

/** Token bucket per key: `rate` per minute with bursts up to `burst`. */
function limiter(rate: number, burst: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 60_000) * rate);
    b.at = now;
    if (buckets.size > 50_000) buckets.clear();
    buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

export interface FormsDeps {
  db: Db;
  bus: EventBus;
  kp: KeyProvider;
  links: LinkSigner;
  egress: EgressPolicy;
  /** Header with the client IP set by the proxy in front (e.g. cf-connecting-ip). */
  clientIpHeader?: string;
  /** Submissions per minute per IP and form; bursts up to 3×. */
  ratePerMinute?: number;
}

async function verifyTurnstile(token: string | undefined, secret: string | null, ip: string | undefined, egress: EgressPolicy) {
  if (!token || !secret) return false;
  const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }).toString();
  const res = await safeRequest(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
    egress,
  );
  try {
    return (JSON.parse(res.body) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.6rem 1.2rem;border-radius:6px;border:0;background:#111;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;

export function formsApi(deps: FormsDeps) {
  const { loadPolicy } = sourceLookups(deps.db);
  const allow = limiter(deps.ratePerMinute ?? 5, (deps.ratePerMinute ?? 5) * 3);
  const app = new Hono();

  const formOf = async (formId: string) => {
    if (!/^frm_[0-9a-f]{32}$/.test(formId)) return null;
    const { rows } = await deps.db.admin.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM artifacts WHERE id = $1 AND type = 'form' AND published_version IS NOT NULL",
      [formId],
    );
    if (!rows[0]) return null;
    const ws = rows[0].workspace_id;
    const f = await deps.db.withWorkspace(ws, (tx) => publishedForm(tx, formId));
    return f ? { ws, ...f } : null;
  };
  const ipOf = (c: Context) =>
    c.req
      .header(deps.clientIpHeader ?? 'x-forwarded-for')
      ?.split(',')[0]
      .trim() || undefined;

  app.options('/f/:id', (c) =>
    c.body(null, 204, {
      'access-control-allow-origin': c.req.header('origin') ?? '*',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'origin',
    }),
  );

  app.post('/f/:id', async (c) => {
    const isJson = (c.req.header('content-type') ?? '').includes('application/json');
    const origin = c.req.header('origin');
    const cors: Record<string, string> = origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
    const form = await formOf(c.req.param('id'));
    const done = (ok: boolean, error?: string, status: 400 | 403 | 404 | 429 = 400) => {
      if (isJson || !form)
        return c.json(ok ? { ok: true, doubleOptIn: form?.def.doubleOptIn ?? false } : { ok: false, error }, ok ? 200 : status, cors);
      const target = ok ? form.def.successUrl : (form.def.errorUrl ?? form.def.successUrl);
      return c.redirect(ok ? target : `${target}${target.includes('?') ? '&' : '?'}error=${encodeURIComponent(error ?? 'invalid')}`, 303);
    };
    if (!form) return c.json({ ok: false, error: 'unknown_form' }, 404, cors);
    if (origin && form.def.allowedOrigins.length && !form.def.allowedOrigins.includes(origin.toLowerCase()))
      return done(false, 'origin_not_allowed', 403);

    const raw = (isJson ? await c.req.json().catch(() => ({})) : await c.req.parseBody()) as Record<string, unknown>;
    const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : '');
    // Bots fill every field; people never see this one. Pretend success so they learn nothing.
    if (str('am_hp')) return done(true);
    const ip = ipOf(c);
    if (!allow(`${form.ws}:${c.req.param('id')}:${ip ?? 'unknown'}`)) return done(false, 'rate_limited', 429);
    const email = z.email().max(320).safeParse(str('email'));
    if (!email.success) return done(false, 'invalid_email');
    if (form.def.turnstile) {
      const secret = await deps.db.withWorkspace(form.ws, (tx) => readSecret(tx, form.ws, 'turnstile.secret_key', deps.kp));
      const ok = await verifyTurnstile(str('cf-turnstile-response'), secret, ip, deps.egress).catch(() => false);
      if (!ok) return done(false, 'challenge_failed', 403);
    }

    const traits: Record<string, unknown> = { email: email.data.toLowerCase() };
    for (const t of form.def.traits) if (str(t)) traits[t] = str(t).slice(0, 200);
    const anon = /^[A-Za-z0-9:_-]{8,100}$/.test(str('anonymousId')) ? str('anonymousId') : `form:${randomUUID()}`;
    const submittedAt = new Date().toISOString();
    const items = [
      { type: 'identify', anonymousId: anon, traits, timestamp: submittedAt },
      {
        type: 'track',
        event: SUBMITTED,
        anonymousId: anon,
        timestamp: submittedAt,
        properties: {
          form_id: c.req.param('id'),
          form_version: form.version,
          purposes: form.def.purposes,
          double_opt_in: form.def.doubleOptIn,
          consent_text: consentTextHash(form.def.consentText),
          page: str('page').slice(0, 500) || c.req.header('referer')?.slice(0, 500) || '',
        },
      },
    ];
    // The form is the source: the consent hook only trusts these events from frm_ sources.
    const source = { id: c.req.param('id'), workspaceId: form.ws, kind: 'server' as const, requiredPurpose: null };
    const { accepted, rejected } = acceptItems(items, source, await loadPolicy(form.ws));
    if (rejected.length) {
      logger.warn({ form: c.req.param('id'), rejected }, 'form submission rejected');
      return done(false, 'invalid');
    }
    await deps.bus.publish(accepted);
    return done(true);
  });

  // Confirmation: the link opens a page with a button, so mail scanners that follow links do not
  // confirm on the person's behalf. The POST records the confirmation as an event.
  const verified = (token: string) => {
    const t = deps.links.verify<DoiToken>(token);
    return t?.k === 'doi' && t.x > Date.now() ? t : null;
  };
  app.get('/f/confirm/:token', (c) => {
    if (!verified(c.req.param('token')))
      return c.html(page('Link expired', '<h1>This link has expired</h1><p>Please sign up again; we will send you a new link.</p>'), 410);
    return c.html(
      page(
        'Confirm your subscription',
        `<h1>Confirm your subscription</h1><p>One click and you are in.</p><form method="post"><button type="submit">Yes, subscribe me</button></form>`,
      ),
    );
  });
  app.post('/f/confirm/:token', async (c) => {
    const t = verified(c.req.param('token'));
    if (!t) return c.html(page('Link expired', '<h1>This link has expired</h1><p>Please sign up again.</p>'), 410);
    const form = await deps.db.withWorkspace(t.w, (tx) => publishedForm(tx, t.f, t.v));
    if (!form) return c.html(page('Not available', '<h1>This signup is no longer available</h1>'), 404);
    const item = {
      type: 'track',
      event: CONFIRMED,
      anonymousId: t.a,
      // The same link confirms once, however often it is clicked.
      messageId: `doi:${createHash('sha256').update(c.req.param('token')).digest('hex').slice(0, 32)}`,
      timestamp: new Date().toISOString(),
      properties: {
        form_id: t.f,
        form_version: t.v,
        purposes: form.def.purposes,
        submitted_at: t.s,
        consent_text: consentTextHash(form.def.consentText),
      },
    };
    const { accepted } = acceptItems([item], { id: t.f, workspaceId: t.w, kind: 'server', requiredPurpose: null }, await loadPolicy(t.w));
    await deps.bus.publish(accepted);
    return c.redirect(form.def.confirmedUrl, 303);
  });
  return app;
}
