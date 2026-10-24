// Mirrors packages/artifacts/src/hostedPages.ts (the server is the source of truth; these only
// show defaults in the editor).
export const PAGE_KINDS = [
  { key: 'confirm', label: 'Confirm' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'expired', label: 'Expired link' },
  { key: 'unsubscribe', label: 'Unsubscribe' },
  { key: 'unsubscribed', label: 'Unsubscribed' },
] as const;
export type PageKind = (typeof PAGE_KINDS)[number]['key'];

export const DEFAULT_COLORS = {
  background: '#ffffff',
  surface: '#f6f7f9',
  text: '#111827',
  muted: '#4b5563',
  accent: '#1d4ed8',
  accentText: '#ffffff',
  border: '#d1d5db',
} as const;
export type ColorKey = keyof typeof DEFAULT_COLORS;
export const COLOR_LABEL: Record<ColorKey, string> = {
  background: 'Page background',
  surface: 'Card',
  text: 'Text',
  muted: 'Secondary text',
  accent: 'Button and links',
  accentText: 'Button text',
  border: 'Borders',
};

export const DEFAULT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const FONT_PRESETS = [
  { label: 'System sans-serif (default)', value: DEFAULT_FONT },
  { label: 'Georgia serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Helvetica / Arial', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Monospace', value: 'ui-monospace, Menlo, Consolas, monospace' },
];

export const DEFAULT_COPY = {
  confirmTitle: 'Confirm your subscription',
  confirmBody: 'One click and you are in.',
  confirmButton: 'Yes, subscribe me',
  confirmedTitle: 'You are subscribed',
  confirmedBody: 'Your subscription is confirmed.',
  expiredTitle: 'Link expired',
  expiredBody: 'This link has expired. Please sign up again; we will send you a new link.',
  unsubscribeTitle: 'Unsubscribe',
  unsubscribeBody: 'You will no longer receive these e-mails.',
  unsubscribeButton: 'Unsubscribe',
  unsubscribedTitle: 'Unsubscribed',
  unsubscribedBody: 'You are unsubscribed. It can take a moment before running campaigns notice.',
  backToSite: 'Back to {site}',
} as const;
export type CopyKey = keyof typeof DEFAULT_COPY;
export const COPY_GROUPS: { page: string; keys: CopyKey[] }[] = [
  { page: 'Confirm', keys: ['confirmTitle', 'confirmBody', 'confirmButton'] },
  { page: 'Confirmed', keys: ['confirmedTitle', 'confirmedBody'] },
  { page: 'Expired link', keys: ['expiredTitle', 'expiredBody'] },
  { page: 'Unsubscribe', keys: ['unsubscribeTitle', 'unsubscribeBody', 'unsubscribeButton'] },
  { page: 'Unsubscribed', keys: ['unsubscribedTitle', 'unsubscribedBody'] },
  { page: 'All pages', keys: ['backToSite'] },
];

/** WCAG contrast ratio of two #rgb/#rrggbb colours. */
export function contrast(a: string, b: string): number | null {
  const lum = (hex: string) => {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    const [r, g, bl] = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const la = lum(a);
  const lb = lum(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
