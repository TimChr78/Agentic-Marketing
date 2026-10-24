import { createTransport } from 'nodemailer';
import { z } from 'zod';
import { parseBrevoWebhook } from './brevo';
import { parsePostmarkWebhook } from './postmark';
import { sesWebhook } from './ses';
import { defineAdapter } from './types';

// SMTP through Nodemailer: any relay, Postfix, or Mailpit in development. SMTP itself reports
// no delivery events, so `events` names the relay whose webhooks report them (ADR-0011).

export const smtpAdapter = defineAdapter({
  id: 'smtp',
  label: 'SMTP relay',
  docsUrl: 'https://nodemailer.com/smtp/',
  tracking: 'none',
  trackingNote: 'SMTP adds no tracking itself; whether the relay rewrites links or adds pixels depends entirely on the relay.',
  config: z.object({
    host: z.string().min(1).describe('Relay host name, e.g. smtp.example.com'),
    port: z.number().int().min(1).max(65535).default(587).describe('Usually 587 (STARTTLS) or 465 (TLS)'),
    secure: z.boolean().default(false).describe('TLS from the start (port 465); otherwise STARTTLS when offered'),
    requireTls: z.boolean().default(true).describe('Refuse to send without STARTTLS'),
    user: z.string().optional().describe('User name for the relay, if it needs one'),
    events: z
      .enum(['none', 'ses', 'postmark', 'brevo'])
      .default('none')
      .describe('Whose webhooks report deliveries and bounces for this relay'),
  }),
  secrets: z.object({ password: z.string().optional().describe('Password for the relay user') }),
  create: (config, secrets, deps) => {
    const transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTls && !config.secure,
      auth: config.user ? { user: config.user, pass: secrets.password ?? '' } : undefined,
      pool: true,
      maxConnections: 5,
    });
    const events =
      config.events === 'ses'
        ? sesWebhook(deps)
        : config.events === 'postmark'
          ? { parseWebhook: parsePostmarkWebhook }
          : config.events === 'brevo'
            ? { parseWebhook: parseBrevoWebhook }
            : {};
    return {
      async send(m) {
        const info = await transport.sendMail({
          from: m.from.name ? { name: m.from.name, address: m.from.email } : m.from.email,
          to: m.to,
          replyTo: m.replyTo,
          subject: m.subject,
          html: m.html,
          text: m.text,
          headers: {
            ...m.headers,
            // Relays that tag messages from headers: Brevo echoes X-Mailin-custom, Postmark metadata.
            'X-Mailin-custom': `am:${m.messageId}`,
            'X-PM-Metadata-am_message_id': m.messageId,
          },
        });
        if (info.rejected.length) throw new Error(`The SMTP relay rejected the recipient: ${String(info.response)}`);
        return { providerMessageId: info.messageId ?? null };
      },
      ...events,
      async close() {
        transport.close();
      },
    };
  },
});
