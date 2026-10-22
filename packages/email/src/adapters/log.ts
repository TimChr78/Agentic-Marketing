import { z } from 'zod';
import { defineAdapter, type OutgoingEmail } from './types';

/** Keeps messages in memory instead of sending them: development, demos and tests. */
export const outbox: OutgoingEmail[] = [];

export const logAdapter = defineAdapter({
  id: 'log',
  label: 'Development outbox (sends nothing)',
  config: z.object({}),
  secrets: z.object({}),
  create: () => ({
    async send(msg) {
      outbox.push(msg);
      if (outbox.length > 1000) outbox.shift();
      return { providerMessageId: `log-${msg.messageId}` };
    },
  }),
});
