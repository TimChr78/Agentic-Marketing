import type { Out } from '../../app/api';

// Role labels and plain-language meanings, shared by Users and Preferences. The server's role key
// for a builder is `marketer`; the UI says "Builder" everywhere.

export type Role = Out<'members.list'>['members'][number]['role'];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  marketer: 'Builder',
  approver: 'Approver',
  viewer: 'Viewer',
};

/** What each role may do, in plain words. */
export const ROLE_MEANING: Record<Role, string> = {
  owner: 'Everything, including settings and who else is an owner.',
  admin: 'Everything, including settings, people and secrets.',
  marketer: 'Creates and edits content, submits it for review and sends.',
  approver: 'Reviews and approves other people’s changes.',
  viewer: 'Read only.',
};

/** Highest first. Used to spot a role change that lowers someone's access. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 4,
  admin: 3,
  marketer: 2,
  approver: 2,
  viewer: 1,
};

export const ROLES: Role[] = ['owner', 'admin', 'marketer', 'approver', 'viewer'];

/** A role key as it should read in the UI, including keys this build does not know. */
export function roleLabel(role: string): string {
  return ROLE_LABEL[role as Role] ?? role.replace(/_/g, ' ');
}

/** True when moving from `from` to `to` takes away admin access. */
export function lowersAdmin(from: Role, to: Role): boolean {
  return (from === 'owner' || from === 'admin') && to !== from && ROLE_RANK[to] < ROLE_RANK[from];
}
