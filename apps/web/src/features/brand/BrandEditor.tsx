import { ImageIcon, X } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Checkbox, Field, FieldGroup, Input, Select, Textarea } from '../../ui';
import type { EditorProps } from '../artifacts/ArtifactDetailPage';
import { AssetPicker } from '../assets/AssetPicker';
import { COLOR_LABEL, COPY_GROUPS, type ColorKey, contrast, DEFAULT_COLORS, DEFAULT_COPY, DEFAULT_FONT, FONT_PRESETS } from './defaults';
import { HostedPreview } from './HostedPreview';

export interface BrandContent {
  siteName?: string;
  siteUrl?: string;
  logoUrl?: string;
  logoAlt?: string;
  logoHeight?: number;
  colors?: Partial<Record<ColorKey, string>>;
  fontStack?: string;
  radius?: number;
  language?: string;
  copy?: Partial<Record<keyof typeof DEFAULT_COPY, string>>;
  archive?: {
    enabled?: boolean;
    title?: string;
    description?: string;
    slug?: string;
    subscribeUrl?: string;
  };
}

const prune = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;

/**
 * Brand fields with a live preview of the hosted pages (#37). Works for the workspace brand and,
 * with `override`, for a form's partial override (empty fields fall back to the workspace brand).
 */
export function BrandFields({ value, onChange, readOnly, errors, prefix = '', override }: { value: BrandContent; onChange: (v: BrandContent) => void; readOnly: boolean; errors: Record<string, string>; prefix?: string; override?: boolean }) {
  const [picking, setPicking] = useState(false);
  const set = (p: Partial<BrandContent>) => onChange(prune({ ...value, ...p }));
  const colors = { ...DEFAULT_COLORS, ...(value.colors ?? {}) };
  const setColor = (k: ColorKey, v: string) => set({ colors: prune({ ...(value.colors ?? {}), [k]: v || undefined }) });
  const err = (k: string) => errors[`${prefix}${k}`];
  const checks = [
    { label: 'Text on page background', ratio: contrast(colors.text, colors.background) },
    { label: 'Text on card', ratio: contrast(colors.text, colors.surface) },
    { label: 'Button text on the accent colour', ratio: contrast(colors.accentText, colors.accent) },
    { label: 'Secondary text on card', ratio: contrast(colors.muted, colors.surface) },
  ].filter((c) => c.ratio !== null && c.ratio < 4.5);
  const fontPreset = FONT_PRESETS.find((f) => f.value === (value.fontStack ?? DEFAULT_FONT));

  return (
    <div className="space-y-6">
      <FieldGroup legend="Site">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Site name" hint="Shown at the top when there is no logo, and in “Back to …”." error={err('siteName')}>
            <Input value={value.siteName ?? ''} readOnly={readOnly} maxLength={120} onChange={(e) => set({ siteName: e.target.value })} />
          </Field>
          <Field label="Site address" hint="Where “Back to …” goes. https://…" error={err('siteUrl')}>
            <Input type="url" value={value.siteUrl ?? ''} readOnly={readOnly} placeholder="https://example.com" onChange={(e) => set({ siteUrl: e.target.value })} />
          </Field>
        </div>
        <Field label="Language" hint="Page language for screen readers and browsers, e.g. en, da or pt-BR." error={err('language')} className="max-w-[240px]">
          <Input value={value.language ?? ''} readOnly={readOnly} placeholder={override ? 'Workspace brand' : 'en'} maxLength={35} onChange={(e) => set({ language: e.target.value })} />
        </Field>
      </FieldGroup>

      {!override && (
      <FieldGroup
        legend="Newsletter archive"
        hint="A public archive of sent issues on your links address (/n/<slug>/), with RSS and a sitemap. Published issues use the template version that was sent, without any reader's personal data."
      >
        <Checkbox
          label="Publish a newsletter archive"
          hint="Only sent broadcasts that are also marked “Publish to the archive” appear."
          checked={value.archive?.enabled ?? false}
          disabled={readOnly}
          onChange={(e) => set({ archive: { ...(value.archive ?? {}), enabled: e.target.checked } })}
        />
        {value.archive?.enabled && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Archive title" hint="Shown on the index and in the feed." error={err('archive.title')}>
                <Input
                  value={value.archive?.title ?? ''}
                  readOnly={readOnly}
                  maxLength={120}
                  placeholder={value.siteName || 'Newsletter archive'}
                  onChange={(e) => set({ archive: { ...(value.archive ?? {}), title: e.target.value } })}
                />
              </Field>
              <Field label="Archive address" hint="Lowercase letters, digits and hyphens; unique on this install." error={err('archive.slug')} required>
                <Input
                  value={value.archive?.slug ?? ''}
                  readOnly={readOnly}
                  maxLength={41}
                  placeholder="newsletter"
                  onChange={(e) => set({ archive: { ...(value.archive ?? {}), slug: e.target.value.toLowerCase() } })}
                />
              </Field>
            </div>
            <Field label="Description" hint="A sentence for the index and the feed." error={err('archive.description')}>
              <Textarea
                rows={2}
                value={value.archive?.description ?? ''}
                readOnly={readOnly}
                maxLength={500}
                onChange={(e) => set({ archive: { ...(value.archive ?? {}), description: e.target.value } })}
              />
            </Field>
            <Field label="Subscribe link" hint="Optional. Shown as the archive's subscribe button, e.g. your signup form." error={err('archive.subscribeUrl')}>
              <Input
                type="url"
                value={value.archive?.subscribeUrl ?? ''}
                readOnly={readOnly}
                placeholder="https://example.com/#signup"
                onChange={(e) => set({ archive: { ...(value.archive ?? {}), subscribeUrl: e.target.value } })}
              />
            </Field>
          </>
        )}
      </FieldGroup>
      )}

      <FieldGroup legend="Logo">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-16 w-[200px] items-center justify-center rounded-md border border-line bg-surface-2 p-2">
            {value.logoUrl ? <img src={value.logoUrl} alt={value.logoAlt ?? ''} className="max-h-full max-w-full object-contain" /> : <span className="text-[12px] text-muted">No logo</span>}
          </div>
          {!readOnly && (
            <>
              <Button icon={<ImageIcon size={14} />} onClick={() => setPicking(true)}>
                {value.logoUrl ? 'Change logo' : 'Choose logo'}
              </Button>
              {value.logoUrl && (
                <Button variant="ghost" icon={<X size={14} />} onClick={() => set({ logoUrl: undefined, logoAlt: undefined })}>
                  Remove
                </Button>
              )}
            </>
          )}
        </div>
        {err('logoUrl') && <p className="text-[12px] text-bad">{err('logoUrl')}</p>}
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <Field label="Logo alt text" hint="Defaults to the site name." error={err('logoAlt')}>
            <Input value={value.logoAlt ?? ''} readOnly={readOnly} maxLength={200} onChange={(e) => set({ logoAlt: e.target.value })} />
          </Field>
          <Field label="Logo height" unit="px" hint="16 to 96." error={err('logoHeight')}>
            <Input type="number" min={16} max={96} value={value.logoHeight ?? ''} placeholder="32" readOnly={readOnly} onChange={(e) => set({ logoHeight: e.target.value ? Number(e.target.value) : undefined })} className="pr-9" />
          </Field>
        </div>
      </FieldGroup>

      <FieldGroup legend="Colours" hint={override ? 'Empty colours use the workspace brand.' : 'Checked against WCAG AA (4.5:1) as you change them.'}>
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(DEFAULT_COLORS) as ColorKey[]).map((k) => (
            <Field key={k} label={COLOR_LABEL[k]} error={err(`colors.${k}`)}>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={`${COLOR_LABEL[k]} colour picker`}
                  value={/^#[0-9a-f]{6}$/i.test(colors[k]) ? colors[k] : '#000000'}
                  disabled={readOnly}
                  onChange={(e) => setColor(k, e.target.value)}
                  className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-control bg-surface p-0.5 disabled:cursor-not-allowed"
                />
                <Input value={value.colors?.[k] ?? ''} placeholder={override ? 'Workspace brand' : DEFAULT_COLORS[k]} readOnly={readOnly} maxLength={7} onChange={(e) => setColor(k, e.target.value)} className="font-mono" />
              </div>
            </Field>
          ))}
        </div>
        {checks.length > 0 && (
          <Alert tone="warn" title="Low contrast">
            <ul className="list-disc pl-4">
              {checks.map((c) => (
                <li key={c.label}>
                  {c.label}: {c.ratio!.toFixed(1)}:1 (needs 4.5:1)
                </li>
              ))}
            </ul>
          </Alert>
        )}
      </FieldGroup>

      <FieldGroup legend="Type and shape">
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <Field label="Font" hint="System fonts load instantly and need no third party." error={err('fontStack')}>
            <Select value={fontPreset ? fontPreset.value : '__custom'} disabled={readOnly} onChange={(e) => set({ fontStack: e.target.value === '__custom' ? (value.fontStack ?? '') : e.target.value === DEFAULT_FONT && !override ? undefined : e.target.value })}>
              {FONT_PRESETS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
              <option value="__custom">Custom font stack…</option>
            </Select>
          </Field>
          <Field label="Corner radius" unit="px" hint="0 to 24." error={err('radius')}>
            <Input type="number" min={0} max={24} value={value.radius ?? ''} placeholder="8" readOnly={readOnly} onChange={(e) => set({ radius: e.target.value ? Number(e.target.value) : undefined })} className="pr-9" />
          </Field>
        </div>
        {!fontPreset && (
          <Field label="Custom font stack" hint={'CSS font-family, e.g. "Inter", system-ui, sans-serif. The font must be installed on the reader’s device.'} error={err('fontStack')}>
            <Input value={value.fontStack ?? ''} readOnly={readOnly} maxLength={200} onChange={(e) => set({ fontStack: e.target.value })} className="font-mono" />
          </Field>
        )}
      </FieldGroup>

      <details className="group">
        <summary className="cursor-pointer text-[13px] font-medium text-fg-2 hover:text-fg">Text on the pages ({Object.keys(value.copy ?? {}).length} changed)</summary>
        <div className="mt-3 space-y-5">
          {COPY_GROUPS.map((g) => (
            <FieldGroup key={g.page} legend={g.page}>
              {g.keys.map((k) => (
                <Field key={k} label={k.replace(/([A-Z])/g, ' $1').replace(/^\w/, (c) => c.toUpperCase()).replace(/ (\w)/g, (m) => m.toLowerCase())} hint={`Default: “${DEFAULT_COPY[k]}”${k === 'backToSite' ? ' ({site} becomes the site name)' : ''}`} error={err(`copy.${k}`)}>
                  <Textarea rows={k.endsWith('Body') ? 2 : 1} value={value.copy?.[k] ?? ''} placeholder={DEFAULT_COPY[k]} readOnly={readOnly} maxLength={500} onChange={(e) => set({ copy: prune({ ...(value.copy ?? {}), [k]: e.target.value || undefined }) })} />
                </Field>
              ))}
            </FieldGroup>
          ))}
        </div>
      </details>
      {picking && (
        <AssetPicker
          title="Choose a logo"
          onClose={() => setPicking(false)}
          onPick={(a) => {
            set({ logoUrl: a.url, logoAlt: value.logoAlt || a.altText || undefined });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** The workspace brand artifact's editor: fields left, live hosted-page preview right. */
export function BrandEditor({ content, onChange, readOnly, errors }: EditorProps<BrandContent>) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <BrandFields value={content} onChange={onChange} readOnly={readOnly} errors={errors} />
      <div className="xl:sticky xl:top-16 xl:self-start">
        <p className="mb-2 text-[12px] text-muted">Live preview of your unsaved changes</p>
        <HostedPreview brand={content} />
      </div>
    </div>
  );
}
