import { contentValidators, type EmailTemplate } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { profileForMessage } from '@agentic-marketing/profiles';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { renderTemplate, validateTemplate } from './render';

contentValidators.set('email_template', (c) => validateTemplate(c as EmailTemplate));

export const previewTemplate = defineCommand({
  name: 'templates.preview',
  title: 'Preview an e-mail template',
  description:
    'Render a template version (default: the latest) to subject, HTML and text, with its sample data, data you pass, or a real person (needs profiles:pii). Nothing is sent.',
  input: z.object({
    artifactId: z.string().regex(/^eml_[0-9a-f]{32}$/),
    version: z.number().int().min(1).optional(),
    data: z.record(z.string(), z.unknown()).optional().describe('Variables, merged over the template sample data'),
    profileId: z
      .string()
      .regex(/^prf_[0-9a-f]{32}$/)
      .optional(),
  }),
  output: z.object({
    version: z.number().int(),
    subject: z.string(),
    preheader: z.string().optional(),
    html: z.string(),
    text: z.string(),
    warnings: z.array(z.string()),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const [v] = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.artifactId, input.artifactId),
          input.version ? eq(schema.artifactVersions.number, input.version) : undefined,
        ),
      )
      .orderBy(desc(schema.artifactVersions.number))
      .limit(1);
    if (!v) throw new AppError('not_found', `No template ${input.artifactId}${input.version ? ` version ${input.version}` : ''}.`);
    const t = v.content as EmailTemplate;
    let vars: Record<string, unknown> = { ...(t.sampleData ?? {}), ...(input.data ?? {}) };
    if (input.profileId) {
      if (!ctx.principal.permissions.has('profiles:pii'))
        throw new AppError(
          'forbidden',
          'Previewing with a real person shows their personal data and needs profiles:pii. Use sample data instead.',
        );
      const p = await profileForMessage(ctx.tx, ctx.principal.workspaceId, input.profileId, ctx.services.keyProvider);
      if (!p) throw new AppError('not_found', `No profile ${input.profileId}.`);
      vars = { ...vars, profile: p.vars };
    }
    try {
      return { version: v.number, ...(await renderTemplate(t, vars)) };
    } catch (e) {
      throw new AppError('invalid_input', `The template could not be rendered with this data: ${(e as Error).message.split('\n')[0]}`);
    }
  },
});

export const templateCommands = [previewTemplate] as const;
