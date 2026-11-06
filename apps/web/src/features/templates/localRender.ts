import { Liquid } from 'liquidjs';

// Local draft rendering for the template editor (Phase 25, #499). It reuses the browser Liquid +
// mjml-browser pipeline the legacy mock screen used, with the same scope and preheader convention
// as packages/email/src/render.ts. It is deliberately not the server renderer: reusable blocks
// cannot be resolved here, and the caller must say so instead of faking a render.

export interface DraftEmailContent {
  subject: string;
  preheader?: string;
  mjml: string;
  text?: string;
  sampleData?: Record<string, unknown>;
}

export interface DraftRender {
  subject: string;
  preheader?: string;
  html: string;
  text: string;
  warnings: string[];
}

const PLACEHOLDER_UNSUBSCRIBE = 'https://example.invalid/unsubscribe';
const PLACEHOLDER_WEB = 'https://example.invalid/web';

const liquid = new Liquid({ strictVariables: false, strictFilters: false });

/** A draft that needs the server's block resolver: never strip the tag or render around it. */
export function draftUsesBlocks(content: Pick<DraftEmailContent, 'mjml' | 'text'>): boolean {
  return /\{%\s*block\b/.test(content.mjml) || !!content.text?.match(/\{%\s*block\b/);
}

/** The same order as the server: sample data, then placeholder links (sample data may override). */
export function draftScope(sampleData?: Record<string, unknown>): Record<string, unknown> {
  return {
    unsubscribe_url: PLACEHOLDER_UNSUBSCRIBE,
    preferences_url: PLACEHOLDER_UNSUBSCRIBE,
    web_url: PLACEHOLDER_WEB,
    ...(sampleData ?? {}),
  };
}

/**
 * Insert the preheader as `mj-preview` unless the template has one, exactly where the server puts
 * it. Returns the MJML unchanged when there is no preheader.
 */
export function withPreheader(mjml: string, preheader: string | undefined): string {
  if (!preheader || /<mj-preview/.test(mjml)) return mjml;
  return mjml.replace(/<mj-head>|<mj-body/, (m: string) =>
    m === '<mj-head>' ? `${m}<mj-preview>${preheader}</mj-preview>` : `<mj-head><mj-preview>${preheader}</mj-preview></mj-head>${m}`,
  );
}

/**
 * Render a draft locally for preview only. Text is rendered only when the template has an explicit
 * text part; the contract forbids inventing a browser HTML-to-text substitute.
 */
export async function renderDraft(content: DraftEmailContent): Promise<DraftRender> {
  if (draftUsesBlocks(content))
    throw new Error('This draft uses a reusable block, which only the server can expand. Save the draft to render it.');
  const scope = draftScope(content.sampleData);
  const [subject, preheader, mjml] = await Promise.all([
    liquid.parseAndRender(content.subject ?? '', scope),
    content.preheader ? liquid.parseAndRender(content.preheader, scope) : Promise.resolve(undefined),
    liquid.parseAndRender(content.mjml ?? '', scope),
  ]);
  const text = content.text ? await liquid.parseAndRender(content.text, scope) : '';
  // Loaded on demand so the visual editor does not carry a second MJML compiler until it previews.
  const { default: mjml2html } = await import('mjml-browser');
  const out = await mjml2html(withPreheader(mjml, preheader), { validationLevel: 'soft' });
  return {
    subject: subject.replace(/\s+/g, ' ').trim(),
    preheader: preheader?.trim() || undefined,
    html: out.html,
    text: text.trim(),
    warnings: out.errors.map((e) => `mjml line ${(e as { line?: number }).line}: ${(e as { message: string }).message}`),
  };
}

/** Whether the editor's local copy differs from the exact saved version it was opened from. */
export function templateContentChanged(
  content: DraftEmailContent & { purpose?: string; topic?: string; utm?: unknown },
  saved: DraftEmailContent & { purpose?: string; topic?: string; utm?: unknown },
  keys: readonly (keyof typeof content)[] = ['purpose', 'topic', 'subject', 'preheader', 'mjml', 'text', 'sampleData', 'utm'],
): boolean {
  const value = (c: typeof content, key: keyof typeof content) => JSON.stringify(c[key] ?? null);
  return keys.some((key) => value(content, key) !== value(saved, key));
}
