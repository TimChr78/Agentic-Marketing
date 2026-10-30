// What each scope lets an API token do, in plain words (#44). Tokens act as agents, so scopes that
// only people can use are marked: granting them gives the token nothing.

export const SCOPES = [
  'artifacts:read',
  'artifacts:write',
  'artifacts:publish',
  'messages:send',
  'audit:read',
  'profiles:read',
  'profiles:pii',
  'profiles:write',
  'secrets:read',
  'artifacts:approve',
  'profiles:erase',
  'secrets:write',
  'workspace:admin',
] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_TEXT: Record<Scope, { label: string; does: string; peopleOnly?: boolean; risky?: boolean }> = {
  'artifacts:read': { label: 'Read artifacts', does: 'read journeys, templates, segments, forms and broadcasts' },
  'artifacts:write': { label: 'Draft and edit', does: 'create and edit drafts (never live versions)' },
  'artifacts:publish': { label: 'Submit for review', does: 'submit drafts; the approval policy decides whether a person must approve' },
  'messages:send': {
    label: 'Send messages',
    does: 'send e-mail and other messages to people (consent and unsubscribes still apply)',
    risky: true,
  },
  'audit:read': { label: 'Read the audit log', does: 'read who did what' },
  'profiles:read': { label: 'Read profiles', does: 'read profiles and events, without personal data' },
  'profiles:pii': { label: 'See personal data', does: 'see e-mail addresses and other personal data', risky: true },
  'profiles:write': { label: 'Update profiles', does: 'record consent and set traits', risky: true },
  'secrets:read': { label: 'Use secret names', does: 'see the names of stored secrets (never their values)' },
  'artifacts:approve': { label: 'Approve', does: 'nothing: only people can approve', peopleOnly: true },
  'profiles:erase': { label: 'Erase people', does: 'nothing: only people can erase', peopleOnly: true },
  'secrets:write': { label: 'Change secrets', does: 'nothing: only people can change secrets', peopleOnly: true },
  'workspace:admin': {
    label: 'Workspace settings',
    does: 'nothing that changes settings: only people can; it can read provider and connection lists',
    peopleOnly: true,
  },
};

export function scopeSentence(scopes: string[]): string {
  const parts = scopes.map((s) => SCOPE_TEXT[s as Scope]?.does ?? s);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join('; ')}; and ${parts.at(-1)}`;
}
