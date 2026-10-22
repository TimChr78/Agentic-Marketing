import { brevoAdapter } from './brevo';
import { cloudflareAdapter } from './cloudflare';
import { logAdapter } from './log';
import { postmarkAdapter } from './postmark';
import { sesAdapter } from './ses';
import { smtpAdapter } from './smtp';
import type { EmailAdapter } from './types';

export { parseBrevoWebhook } from './brevo';
export { outbox } from './log';
export { parsePostmarkWebhook } from './postmark';
export { sesEvents, verifySnsMessage } from './ses';
export * from './types';

export const adapters: Record<EmailAdapter['id'], EmailAdapter> = {
  smtp: smtpAdapter as unknown as EmailAdapter,
  ses: sesAdapter as unknown as EmailAdapter,
  postmark: postmarkAdapter as unknown as EmailAdapter,
  brevo: brevoAdapter as unknown as EmailAdapter,
  cloudflare: cloudflareAdapter as unknown as EmailAdapter,
  log: logAdapter as unknown as EmailAdapter,
};
