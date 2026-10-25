import type { ConsentStatus } from '@agentic-marketing/db';
import type { ConsentRow } from '../src/consent';

// Shared by the unit test of currentConsent and the server test that checks segment SQL agrees.

export const P = 'marketing_email';
export const row = (channel: string, status: ConsentStatus, minute: number, purpose = P): ConsentRow => ({
  purpose,
  channel,
  status,
  updatedAt: new Date(Date.UTC(2026, 9, 24, 12, minute)),
});

export const CASES: { name: string; rows: ConsentRow[]; any: ConsentStatus | undefined; email: ConsentStatus | undefined }[] = [
  { name: 'form consent only', rows: [row('', 'granted', 1)], any: 'granted', email: 'granted' },
  {
    name: 'form consent, then unsubscribe (#103)',
    rows: [row('', 'granted', 1), row('email', 'withdrawn', 2)],
    any: 'withdrawn',
    email: 'withdrawn',
  },
  {
    name: 'unsubscribe, then a new form consent',
    rows: [row('email', 'withdrawn', 1), row('', 'granted', 2)],
    any: 'granted',
    email: 'granted',
  },
  {
    name: 'a newer withdrawal on another channel',
    rows: [row('', 'granted', 1), row('sms', 'withdrawn', 2)],
    any: 'withdrawn',
    email: 'granted',
  },
  {
    name: 'an older channel grant under a refusal',
    rows: [row('email', 'granted', 1), row('', 'withdrawn', 2)],
    any: 'withdrawn',
    email: 'withdrawn',
  },
  {
    name: 'a newer channel grant over a refusal',
    rows: [row('', 'withdrawn', 1), row('email', 'granted', 2)],
    any: 'withdrawn',
    email: 'granted',
  },
  { name: 'a channel grant only', rows: [row('email', 'granted', 1)], any: 'granted', email: 'granted' },
  { name: 'nothing recorded', rows: [], any: undefined, email: undefined },
  {
    name: 'same instant: the refusal wins',
    rows: [row('', 'granted', 1), row('email', 'withdrawn', 1)],
    any: 'withdrawn',
    email: 'withdrawn',
  },
  {
    name: 'a newer channel grant over an older channel refusal',
    rows: [row('', 'granted', 1), row('email', 'withdrawn', 2), row('sms', 'granted', 3)],
    any: 'withdrawn',
    email: 'withdrawn',
  },
  {
    name: 'other purposes do not count',
    rows: [row('', 'granted', 1), row('email', 'withdrawn', 2, 'marketing_sms')],
    any: 'granted',
    email: 'granted',
  },
];
