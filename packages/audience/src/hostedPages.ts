import {
  artifactTypes,
  type Brand,
  type BrandOverride,
  HOSTED_PAGE_KINDS,
  publishedSingleton,
  renderHostedPage,
  resolveBrand,
} from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { z } from 'zod';
import { formOrigin, publishedForm } from './forms';

// The admin preview under Design → Hosted pages. It renders the same document the public route
// serves; because there is no real token, primary buttons are disabled and nothing is submitted.

const FormId = z.string().regex(/^frm_[0-9a-f]{32}$/, 'A form id (frm_…)');

export const previewHostedPage = defineCommand({
  name: 'hostedPages.preview',
  title: 'Preview a hosted page',
  description:
    'Render one of the pages subscribers see on the links host (double opt-in confirm, confirmed, expired, unsubscribe or unsubscribed) with the published workspace brand, or a brand draft you pass, and optionally a form’s hostedPages override. Returns the same HTML document the public route serves; the button is disabled and nothing is sent.',
  input: z.object({
    page: z.enum(HOSTED_PAGE_KINDS).describe('Which page to render'),
    brand: artifactTypes.brand.content
      .optional()
      .describe('Brand content to preview instead of the published brand, e.g. the draft being edited'),
    formId: FormId.optional().describe('Apply this form’s hostedPages override and, on the expired page, its origin'),
  }),
  output: z.object({ html: z.string().describe('A complete HTML document') }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.formId,
  handler: async (input, ctx) => {
    const base: Brand | null = input.brand ?? (await publishedSingleton(ctx.tx, 'brand'));
    let override: BrandOverride | undefined;
    let fallbackSiteUrl: string | null = null;
    if (input.formId) {
      const form = await publishedForm(ctx.tx, input.formId);
      if (!form)
        throw new AppError(
          'not_found',
          `No published form ${input.formId}. Publish the form, then preview its hosted pages; drafts do not change live pages.`,
        );
      override = form.def.hostedPages;
      fallbackSiteUrl = formOrigin(form.def);
    }
    return {
      html: renderHostedPage(input.page, resolveBrand(base, override), { fallbackSiteUrl, preview: true }),
    };
  },
});

export const hostedPageCommands = [previewHostedPage] as const;
