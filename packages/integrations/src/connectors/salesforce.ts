import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineConnector, type InboundItem } from '../sdk';
import { verifyHmac } from '../signing';

// Salesforce (REST API), connected with OAuth through your connected app (or External Client
// App). Journeys can upsert contacts, create leads and tasks, and read with SOQL; a Flow or Apex
// callout can send records here (signed with a shared secret), which become identify and track
// events of `salesforce:<record id>`.

const Id = z.string().regex(/^[a-zA-Z0-9]{15,18}$/, 'A Salesforce record id');
const Fields = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/), z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]))
  .default({})
  .describe('Other fields by API name, e.g. {"LeadSource": "Web", "Newsletter__c": true}');

/** SOQL string literal: backslashes and single quotes escaped. */
export const soqlString = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const settings = z.object({
  instanceUrl: z
    .url()
    .regex(/^https?:\/\//)
    .describe('Your org, e.g. https://acme.my.salesforce.com'),
  loginUrl: z.url().default('https://login.salesforce.com').describe('https://test.salesforce.com for sandboxes, or your My Domain'),
  apiVersion: z
    .string()
    .regex(/^v\d{2}\.0$/)
    .default('v64.0'),
});
type Settings = z.output<typeof settings>;
type Request = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; body: string; headers: Record<string, string> }>;

async function api(s: Settings, token: string | undefined, request: Request, method: string, path: string, body?: unknown) {
  if (!token) throw new Error('not connected: authorize the Salesforce connection');
  const res = await request(`${s.instanceUrl.replace(/\/$/, '')}/services/data/${s.apiVersion}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let out: unknown = null;
  try {
    out = res.body ? JSON.parse(res.body) : null;
  } catch {}
  if (res.status < 200 || res.status >= 300) {
    const errors = Array.isArray(out) ? (out as { errorCode?: string; message?: string }[]) : [];
    throw new Error(`Salesforce ${res.status}: ${errors.map((e) => `${e.errorCode}: ${e.message}`).join('; ') || res.body.slice(0, 200)}`);
  }
  return out as Record<string, unknown> | null;
}

export const salesforceConnector = defineConnector({
  id: 'salesforce',
  label: 'Salesforce',
  description:
    'Salesforce through the REST API, connected with OAuth (a connected app with the api and refresh_token scopes; callback <public URL>/oauth/callback). Journeys can upsert contacts by e-mail, create leads and tasks, and run SOQL queries. A Flow or Apex callout can post records to the inbound URL, signed with HMAC-SHA256 (hex, header x-am-signature).',
  auth: 'oauth2',
  settings,
  secrets: z.object({
    clientId: z.string().min(1).max(500).describe('The consumer key'),
    clientSecret: z.string().min(1).max(500).describe('The consumer secret'),
    signingSecret: z.string().min(16).max(500).optional().describe('Shared secret that signs callouts to the inbound URL'),
  }),
  oauth: (s) => ({
    authorizeUrl: `${s.loginUrl.replace(/\/$/, '')}/services/oauth2/authorize`,
    tokenUrl: `${s.loginUrl.replace(/\/$/, '')}/services/oauth2/token`,
    scopes: ['api', 'refresh_token'],
  }),
  // Salesforce counts API calls per org per day; stay well under the smallest allowance.
  rateLimit: 100,
  inbound: {
    verify({ secrets, headers, body }) {
      if (!secrets.signingSecret) return 'set signingSecret on the connection to receive callouts';
      return verifyHmac(secrets.signingSecret, body, headers['x-am-signature'], 'hex') ? null : 'the signature does not match';
    },
    map(payload) {
      const records = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
      const items: InboundItem[] = [];
      for (const r of records) {
        const id = String(r.recordId ?? r.Id ?? '');
        if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) throw new Error('each record needs a recordId (a Salesforce id)');
        const userId = `salesforce:${id}`;
        const at = typeof r.timestamp === 'string' ? r.timestamp : undefined;
        const traits = { ...((r.traits as Record<string, unknown>) ?? {}), ...(r.email ? { email: r.email } : {}) };
        items.push({
          type: 'identify',
          userId,
          // Without a timestamp, the same record sent twice is one event.
          messageId: `sf:${id}:${at ?? createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16)}`,
          ...(at ? { timestamp: at } : {}),
          traits: { ...traits, salesforce_id: id, ...(r.sobject ? { salesforce_object: String(r.sobject) } : {}) },
        });
        if (typeof r.event === 'string' && r.event)
          items.push({
            type: 'track',
            userId,
            event: r.event,
            messageId: `sf:${id}:${r.event}:${at ?? ''}`,
            ...(at ? { timestamp: at } : {}),
            properties: (r.properties as Record<string, unknown>) ?? {},
          });
      }
      return items;
    },
  },
  actions: {
    upsertContact: {
      label: 'Create or update a contact',
      description: 'Finds the contact with this e-mail and updates it, or creates one. Returns the contact id and whether it was created.',
      input: z.object({
        email: z.email(),
        lastName: z.string().min(1).max(80).describe('Required by Salesforce when the contact is created'),
        firstName: z.string().max(40).optional(),
        fields: Fields,
      }),
      async run(input: { email: string; lastName: string; firstName?: string; fields: Record<string, unknown> }, ctx) {
        const q = await api(
          ctx.settings,
          ctx.accessToken,
          ctx.request,
          'GET',
          `/query?q=${encodeURIComponent(`SELECT Id FROM Contact WHERE Email = ${soqlString(input.email)} ORDER BY LastModifiedDate DESC LIMIT 1`)}`,
        );
        const found = ((q?.records as { Id: string }[] | undefined) ?? [])[0];
        const body = {
          Email: input.email,
          LastName: input.lastName,
          ...(input.firstName ? { FirstName: input.firstName } : {}),
          ...input.fields,
        };
        if (found) {
          await api(ctx.settings, ctx.accessToken, ctx.request, 'PATCH', `/sobjects/Contact/${found.Id}`, body);
          return { id: found.Id, created: false };
        }
        const made = await api(ctx.settings, ctx.accessToken, ctx.request, 'POST', '/sobjects/Contact', body);
        return { id: String(made?.id), created: true };
      },
    },
    createLead: {
      label: 'Create a lead',
      description: 'Creates a lead (LastName and Company are required by Salesforce). Returns its id.',
      input: z.object({
        email: z.email(),
        lastName: z.string().min(1).max(80),
        company: z.string().min(1).max(255),
        firstName: z.string().max(40).optional(),
        fields: Fields,
      }),
      async run(input: { email: string; lastName: string; company: string; firstName?: string; fields: Record<string, unknown> }, ctx) {
        const made = await api(ctx.settings, ctx.accessToken, ctx.request, 'POST', '/sobjects/Lead', {
          Email: input.email,
          LastName: input.lastName,
          Company: input.company,
          ...(input.firstName ? { FirstName: input.firstName } : {}),
          ...input.fields,
        });
        return { id: String(made?.id) };
      },
    },
    createTask: {
      label: 'Create a task',
      description:
        'A task for the record owner, e.g. "Call back: asked for a demo", on a contact or lead (whoId) and/or another record (whatId).',
      input: z.object({
        subject: z.string().min(1).max(255),
        description: z.string().max(32_000).optional(),
        whoId: Id.optional(),
        whatId: Id.optional(),
        dueDate: z.iso.date().optional(),
        priority: z.enum(['High', 'Normal', 'Low']).default('Normal'),
      }),
      async run(
        input: { subject: string; description?: string; whoId?: string; whatId?: string; dueDate?: string; priority: string },
        ctx,
      ) {
        const made = await api(ctx.settings, ctx.accessToken, ctx.request, 'POST', '/sobjects/Task', {
          Subject: input.subject,
          Priority: input.priority,
          Status: 'Not Started',
          ...(input.description ? { Description: input.description } : {}),
          ...(input.whoId ? { WhoId: input.whoId } : {}),
          ...(input.whatId ? { WhatId: input.whatId } : {}),
          ...(input.dueDate ? { ActivityDate: input.dueDate } : {}),
        });
        return { id: String(made?.id) };
      },
    },
    query: {
      label: 'Query (SOQL)',
      description: 'Runs a SOQL SELECT and returns up to 200 records, e.g. to branch on an opportunity stage. Read only.',
      input: z.object({
        soql: z
          .string()
          .min(10)
          .max(4000)
          .regex(/^\s*select\s/i, 'Only SELECT queries'),
      }),
      async run(input: { soql: string }, ctx) {
        const out = await api(ctx.settings, ctx.accessToken, ctx.request, 'GET', `/query?q=${encodeURIComponent(input.soql)}`);
        const records = ((out?.records as Record<string, unknown>[] | undefined) ?? []).slice(0, 200).map(({ attributes: _a, ...r }) => r);
        return { totalSize: out?.totalSize ?? records.length, records };
      },
    },
  },
});
