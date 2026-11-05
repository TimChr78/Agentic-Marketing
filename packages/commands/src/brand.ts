import { z } from 'zod';

// The small brand context the admin shell needs (#190): the name and logo a person sees in the
// switcher, plus the primary domain as secondary text. `siteName` falls back to the workspace
// name and `logoUrl` is null when no published brand artifact has a logo, so callers never need a
// condition; only a published brand artifact counts (a draft is not public yet).

export const BrandSummarySchema = z.object({
  siteName: z.string().describe('Display name: the published brand artifact’s siteName, else the workspace name'),
  logoUrl: z.string().nullable().describe('Logo from the published brand artifact, or null'),
  primaryDomain: z.string().nullable().describe('Primary domain hostname, or null when the brand has none'),
});

export type BrandSummary = z.output<typeof BrandSummarySchema>;
