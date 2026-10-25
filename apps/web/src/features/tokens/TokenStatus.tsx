import { StatusPill } from '../../ui';

export function tokenStatus(t: { revoked: boolean; expiresAt: string | null }) {
  if (t.revoked) return 'revoked' as const;
  if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) return 'expired' as const;
  return 'active' as const;
}
export function TokenStatus({ t }: { t: { revoked: boolean; expiresAt: string | null } }) {
  const s = tokenStatus(t);
  return s === 'active' ? <StatusPill tone="good">Active</StatusPill> : s === 'expired' ? <StatusPill tone="warn">Expired</StatusPill> : <StatusPill tone="bad">Revoked</StatusPill>;
}
