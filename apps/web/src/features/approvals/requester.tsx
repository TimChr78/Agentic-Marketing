import { Actor } from '../../ui';

export interface Requester {
  kind: 'person' | 'token' | 'oauth_client';
  displayName: string;
  personName: string | null;
  tokenName: string | null;
  clientName: string | null;
}

/** Who asked: a person, an API token (with its owner) or an OAuth client acting for a person. */
export function RequesterView({ r, className }: { r: Requester; className?: string }) {
  if (r.kind === 'person') return <Actor kind="person" name={r.displayName} className={className} />;
  if (r.kind === 'token') return <Actor kind="token" name={r.tokenName ?? r.displayName} detail={r.personName ? `token of ${r.personName}` : undefined} className={className} />;
  return <Actor kind="agent" name={r.clientName ?? r.displayName} detail={r.personName ? `for ${r.personName}` : undefined} className={className} />;
}
