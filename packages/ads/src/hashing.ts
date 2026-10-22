import { createHash } from 'node:crypto';

// Identifiers leave only hashed (SHA-256, hex), normalised the way each platform matches them.

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Meta: trimmed, lower case. */
export const metaEmail = (e: string) => sha256(e.trim().toLowerCase());
/** Meta: digits only with the country code, no "+" or leading zeros. */
export const metaPhone = (p: string) => sha256(p.replace(/\D/g, '').replace(/^0+/, ''));

/** Google: trimmed, lower case, and no dots before @ for gmail.com and googlemail.com. */
export function googleEmail(e: string) {
  const [local, domain] = e.trim().toLowerCase().split('@');
  const l = domain === 'gmail.com' || domain === 'googlemail.com' ? local.replace(/\./g, '') : local;
  return sha256(`${l}@${domain}`);
}
/** Google: E.164 with "+". */
export const googlePhone = (p: string) => sha256(`+${p.replace(/\D/g, '').replace(/^0+/, '')}`);
