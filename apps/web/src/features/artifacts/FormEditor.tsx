import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { TextLink } from '../../app/links';
import { useApi } from '../../app/useApi';
import { Alert, Button, Checkbox, Field, FieldGroup, IconButton, Input, LoadingBlock, Switch, Textarea } from '../../ui';
import { FormPreview } from '../previews/FormPreview';
import type { EditorProps } from './ArtifactDetailPage';
import { ArtifactSelect } from './ArtifactSelect';

// Signup form (#37): who agrees to what, which traits are kept, where the browser goes, and
// optionally a brand override for this form's hosted confirm and expired pages.

interface BrandCopy {
  confirmTitle?: string;
  confirmBody?: string;
  confirmButton?: string;
  expiredTitle?: string;
  expiredBody?: string;
  [key: string]: unknown;
}

interface BrandColors {
  accent?: string;
  [key: string]: unknown;
}

interface FormBrand {
  siteName?: string;
  siteUrl?: string;
  logoUrl?: string;
  colors?: BrandColors;
  copy?: BrandCopy;
  [key: string]: unknown;
}

interface FormContent {
  purposes?: string[];
  doubleOptIn?: boolean;
  confirmationTemplate?: string;
  consentText?: string;
  traits?: string[];
  successUrl?: string;
  confirmedUrl?: string;
  errorUrl?: string;
  allowedOrigins?: string[];
  turnstile?: boolean;
  hostedPages?: FormBrand;
  [key: string]: unknown;
}

const TRAIT_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const URL_OR_PATH_RE = /^(https?:\/\/|\/)/;

const COPY_DEFAULTS: { key: keyof BrandCopy; label: string; hint: string; rows: number }[] = [
  { key: 'confirmTitle', label: 'Confirm page title', hint: 'Default: Confirm your subscription', rows: 2 },
  { key: 'confirmBody', label: 'Confirm page body', hint: 'Default: One click and you are in.', rows: 3 },
  { key: 'confirmButton', label: 'Confirm button', hint: 'Default: Yes, subscribe me', rows: 2 },
  { key: 'expiredTitle', label: 'Expired page title', hint: 'Default: Link expired', rows: 2 },
  {
    key: 'expiredBody',
    label: 'Expired page body',
    hint: 'Default: This link has expired. Please sign up again; we will send you a new link.',
    rows: 3,
  },
];

export function FormEditor({ artifact, content, onChange, readOnly, errors }: EditorProps<FormContent>) {
  const set = (patch: Partial<FormContent>) => onChange({ ...content, ...patch });
  const remove = (key: keyof FormContent) => {
    const next = { ...content };
    delete next[key];
    onChange(next);
  };

  const purposes = useApi(() => api.call('purposes.list', {}), []);
  const doubleOptIn = content.doubleOptIn ?? true;
  const selectedPurposes = content.purposes ?? [];
  const purposesError = errors.purposes;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-6">
        <FieldGroup legend="Consent">
          <fieldset className="min-w-0 space-y-2">
            <legend className="mb-1 text-[12px] font-medium text-fg-2">
              Purposes
              <span className="ml-0.5 text-muted" aria-hidden>
                *
              </span>
            </legend>
            <p className="text-[12px] text-muted">At least one. People who submit the form agree to all of these.</p>
            <div className="space-y-2">
              {purposes.loading && <p className="text-[12px] text-muted">Loading purposes…</p>}
              {purposes.error && (
                <Alert tone="bad" title="Couldn't load the purposes" onRetry={purposes.reload}>
                  {purposes.error}
                </Alert>
              )}
              {purposes.data &&
                [
                  ...purposes.data.purposes.map((p) => p.key),
                  ...selectedPurposes.filter((k) => !purposes.data?.purposes.some((p) => p.key === k)),
                ].map((key) => {
                  const p = purposes.data?.purposes.find((x) => x.key === key);
                  return (
                    <Checkbox
                      key={key}
                      checked={selectedPurposes.includes(key)}
                      disabled={readOnly}
                      onChange={(e) =>
                        set({
                          purposes: e.target.checked ? [...selectedPurposes, key] : selectedPurposes.filter((k) => k !== key),
                        })
                      }
                      label={
                        <>
                          {p?.name ?? key} <span className="text-muted">({key})</span>
                        </>
                      }
                      hint={p?.description}
                    />
                  );
                })}
            </div>
            {purposesError && <p className="text-[12px] text-bad">{purposesError}</p>}
          </fieldset>

          <Field
            label="Consent text"
            hint={`Shown next to the form. It is stored with each consent as proof. ${(content.consentText ?? '').length} / 2000 characters.`}
            error={errors.consentText}
            required
          >
            <Textarea
              rows={4}
              maxLength={2000}
              value={content.consentText ?? ''}
              readOnly={readOnly}
              onChange={(e) => set({ consentText: e.target.value })}
            />
          </Field>

          <div>
            <Switch
              checked={doubleOptIn}
              onChange={(v) => set({ doubleOptIn: v })}
              label="Double opt-in: the person confirms by e-mail"
              disabled={readOnly}
            />
            <p className="mt-1 text-[12px] text-muted">
              {doubleOptIn
                ? 'Consent counts only after the person clicks the confirmation link.'
                : 'Consent counts as soon as the form is submitted.'}
            </p>
            {errors.doubleOptIn && <p className="mt-1 text-[12px] text-bad">{errors.doubleOptIn}</p>}
          </div>

          {doubleOptIn && (
            <Field
              label="Confirmation e-mail"
              hint="It must contain {{ confirm_url }} and use a purpose that does not need consent, such as onboarding."
              error={errors.confirmationTemplate}
              required
            >
              <ArtifactSelect
                type="email_template"
                value={content.confirmationTemplate}
                onChange={(v) => set({ confirmationTemplate: v || undefined })}
                disabled={readOnly}
              />
            </Field>
          )}
        </FieldGroup>

        <FieldGroup legend="Fields" hint="The e-mail field is always collected. Add the traits this form also keeps.">
          <TraitsEditor
            value={content.traits ?? ['firstName']}
            onChange={(traits) => set({ traits })}
            readOnly={readOnly}
            error={errors.traits}
          />
        </FieldGroup>

        <FieldGroup legend="After submitting">
          <UrlField
            label="Success page"
            hint="Where the browser goes after submitting, e.g. /thanks."
            required
            value={content.successUrl}
            onChange={(v) => set({ successUrl: v || undefined })}
            readOnly={readOnly}
            error={errors.successUrl}
          />
          <UrlField
            label="Confirmed page"
            hint="Where the browser goes after the person confirms the double opt-in. Leave empty to show the branded confirmation page."
            value={content.confirmedUrl}
            onChange={(v) => set({ confirmedUrl: v || undefined })}
            readOnly={readOnly}
            error={errors.confirmedUrl}
          />
          <UrlField
            label="Error page"
            hint="Where the browser goes when the submission is refused; ?error=… is added. Optional."
            value={content.errorUrl}
            onChange={(v) => set({ errorUrl: v || undefined })}
            readOnly={readOnly}
            error={errors.errorUrl}
          />
        </FieldGroup>

        <FieldGroup legend="Security">
          <OriginsEditor
            value={content.allowedOrigins ?? []}
            onChange={(allowedOrigins) => set({ allowedOrigins })}
            readOnly={readOnly}
            error={errors.allowedOrigins}
          />
          <div>
            <Switch
              checked={content.turnstile ?? false}
              onChange={(v) => set({ turnstile: v })}
              label="Require a Cloudflare Turnstile check"
              disabled={readOnly}
            />
            <p className="mt-1 text-[12px] text-muted">
              The secret is stored under <TextLink to="/settings/secrets">Settings → Secrets</TextLink> as{' '}
              <code className="font-mono text-[12px]">turnstile.secret_key</code>.
            </p>
            {errors.turnstile && <p className="mt-1 text-[12px] text-bad">{errors.turnstile}</p>}
          </div>
        </FieldGroup>

        <FieldGroup legend="Hosted pages" hint="The confirm and expired pages a subscriber sees on the links host.">
          <div>
            <Switch
              checked={!!content.hostedPages}
              onChange={(v) => (v ? set({ hostedPages: content.hostedPages ?? {} }) : remove('hostedPages'))}
              label="Use a different look for this form's confirm pages"
              disabled={readOnly}
            />
            <p className="mt-1 text-[12px] text-muted">
              {content.hostedPages
                ? 'Overrides parts of the workspace brand for this form only.'
                : 'The workspace brand is used on the hosted pages.'}
            </p>
            {errors.hostedPages && <p className="mt-1 text-[12px] text-bad">{errors.hostedPages}</p>}
          </div>

          {content.hostedPages && (
            <HostedPagesEditor
              brand={content.hostedPages}
              onChange={(hostedPages) => set({ hostedPages })}
              readOnly={readOnly}
              errors={errors}
            />
          )}

          <HostedPagePreview formId={artifact.id} savedVersion={artifact.latestVersion} />
        </FieldGroup>
      </div>

      <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start" aria-label="Live preview">
        <p className="mb-2 text-[12px] font-medium text-fg-2">Preview, with your unsaved changes</p>
        <FormPreview content={content} stacked />
      </aside>
    </div>
  );
}

function TraitsEditor({
  value,
  onChange,
  readOnly,
  error,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  readOnly: boolean;
  error?: string;
}) {
  const [draft, setDraft] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  const add = () => {
    const trait = draft.trim();
    if (!trait) return;
    if (!TRAIT_RE.test(trait)) {
      setLocal('Use a letter, then letters, digits or underscores (up to 64 characters).');
      return;
    }
    if (value.includes(trait)) {
      setLocal('That trait is already on the form.');
      return;
    }
    if (value.length >= 20) {
      setLocal('A form can keep at most 20 traits.');
      return;
    }
    onChange([...value, trait]);
    setDraft('');
    setLocal(null);
  };

  return (
    <div className="space-y-2">
      <Field label="Traits" hint="Trait names: a letter, then letters, digits or underscores. Up to 20." error={error ?? local}>
        <div className="flex items-start gap-2">
          <Input
            value={draft}
            disabled={readOnly}
            placeholder="firstName"
            onChange={(e) => {
              setDraft(e.target.value);
              setLocal(null);
            }}
            onBlur={() => {
              if (draft.trim() && !TRAIT_RE.test(draft.trim()))
                setLocal('Use a letter, then letters, digits or underscores (up to 64 characters).');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button variant="secondary" icon={<Plus size={14} />} onClick={add} disabled={readOnly || !draft.trim() || value.length >= 20}>
            Add
          </Button>
        </div>
      </Field>
      {value.length === 0 ? (
        <p className="text-[12px] text-muted">Only the e-mail address is collected.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Traits kept by this form">
          {value.map((trait) => (
            <li key={trait} className="inline-flex h-7 items-center gap-1 rounded-sm border border-line bg-surface-2 pl-2 text-[12px]">
              <span className="font-mono">{trait}</span>
              <IconButton
                label={`Remove trait ${trait}`}
                icon={<Trash2 size={13} />}
                size="sm"
                onClick={() => onChange(value.filter((t) => t !== trait))}
                disabled={readOnly}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OriginsEditor({
  value,
  onChange,
  readOnly,
  error,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  readOnly: boolean;
  error?: string;
}) {
  const [text, setText] = useState(() => value.join('\n'));
  const [local, setLocal] = useState<string | null>(null);
  const last = useRef(value.join('\n'));

  // Follow outside changes (reload, discard), but keep the raw text while typing so blank lines
  // and a trailing newline survive.
  useEffect(() => {
    const joined = value.join('\n');
    if (joined !== last.current) {
      setText(joined);
      last.current = joined;
    }
  }, [value]);

  const update = (raw: string) => {
    setText(raw);
    const origins = raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    last.current = origins.join('\n');
    setLocal(null);
    onChange(origins);
  };

  const validate = () => {
    const origins = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (origins.length > 20) return setLocal('At most 20 origins.');
    const invalid = origins.find((o) => !ORIGIN_RE.test(o));
    setLocal(invalid ? `"${invalid}" is not an origin such as https://example.com or https://example.com:8080.` : null);
  };

  return (
    <Field
      label="Allowed sites"
      hint="One origin per line, such as https://example.com. Leave empty to allow any site."
      error={error ?? local}
    >
      <Textarea
        rows={3}
        mono
        spellCheck={false}
        placeholder={'https://example.com\nhttps://www.example.com'}
        value={text}
        readOnly={readOnly}
        onChange={(e) => update(e.target.value)}
        onBlur={validate}
      />
    </Field>
  );
}

function UrlField({
  label,
  hint,
  required,
  value,
  onChange,
  readOnly,
  error,
}: {
  label: string;
  hint: string;
  required?: boolean;
  value?: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  error?: string;
}) {
  const [local, setLocal] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint} required={required} error={error ?? local}>
      <Input
        value={value ?? ''}
        readOnly={readOnly}
        placeholder="/thanks"
        onChange={(e) => {
          setLocal(null);
          onChange(e.target.value);
        }}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (!v) {
            setLocal(required ? 'Enter a URL or a path starting with /.' : null);
          } else if (v.length > 2000 || !URL_OR_PATH_RE.test(v)) {
            setLocal('An absolute URL or a path starting with /');
          } else {
            setLocal(null);
          }
        }}
      />
    </Field>
  );
}

function HostedPagesEditor({
  brand,
  onChange,
  readOnly,
  errors,
}: {
  brand: FormBrand;
  onChange: (v: FormBrand) => void;
  readOnly: boolean;
  errors: Record<string, string>;
}) {
  const setBrand = (patch: Partial<FormBrand>) => onChange({ ...brand, ...patch });
  const setColors = (patch: Partial<BrandColors>) => setBrand({ colors: { ...brand.colors, ...patch } });
  const setCopy = (patch: Partial<BrandCopy>) => setBrand({ copy: { ...brand.copy, ...patch } });

  const accent = brand.colors?.accent;
  const [accentError, setAccentError] = useState<string | null>(null);
  const [siteUrlError, setSiteUrlError] = useState<string | null>(null);
  const [logoUrlError, setLogoUrlError] = useState<string | null>(null);

  return (
    <div className="space-y-4 rounded-lg border border-line p-4">
      <Field label="Site name" hint="Shown at the top when there is no logo, and in “Back to …”." error={errors['hostedPages.siteName']}>
        <Input
          value={brand.siteName ?? ''}
          maxLength={120}
          readOnly={readOnly}
          onChange={(e) => setBrand({ siteName: e.target.value || undefined })}
        />
      </Field>

      <Field
        label="Site URL"
        hint="Where “Back to …” points. Use https, or http on localhost."
        error={errors['hostedPages.siteUrl'] ?? siteUrlError}
      >
        <Input
          value={brand.siteUrl ?? ''}
          readOnly={readOnly}
          placeholder="https://example.com"
          onChange={(e) => {
            setSiteUrlError(null);
            setBrand({ siteUrl: e.target.value || undefined });
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v) return setSiteUrlError(null);
            if (v !== e.target.value || v.length > 2000) return setSiteUrlError('Use an https URL, or http on localhost for development');
            setSiteUrlError(brandUrlError(v, false));
          }}
        />
      </Field>

      <Field
        label="Logo URL"
        hint="An https URL, for example an asset public URL. Optional."
        error={errors['hostedPages.logoUrl'] ?? logoUrlError}
      >
        <Input
          value={brand.logoUrl ?? ''}
          readOnly={readOnly}
          placeholder="https://example.com/logo.svg"
          onChange={(e) => {
            setLogoUrlError(null);
            setBrand({ logoUrl: e.target.value || undefined });
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v) return setLogoUrlError(null);
            if (v !== e.target.value || v.length > 2000)
              return setLogoUrlError('Use an https URL for the logo (http only on localhost, for development)');
            setLogoUrlError(brandUrlError(v, true));
          }}
        />
      </Field>

      <Field
        label="Accent colour"
        hint="The primary button and links, e.g. #1d4ed8."
        error={errors['hostedPages.colors.accent'] ?? accentError}
      >
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Accent colour picker"
            disabled={readOnly}
            value={hexForPicker(accent)}
            onChange={(e) => {
              setAccentError(null);
              setColors({ accent: e.target.value });
            }}
            className="h-8 w-11 shrink-0 cursor-pointer rounded-md border border-control bg-surface p-0.5 disabled:cursor-not-allowed disabled:bg-surface-2"
          />
          <Input
            value={accent ?? ''}
            readOnly={readOnly}
            placeholder="#1d4ed8"
            spellCheck={false}
            onChange={(e) => {
              setAccentError(null);
              setColors({ accent: e.target.value || undefined });
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              setAccentError(!v || HEX_RE.test(v) ? null : 'Use a #rgb or #rrggbb colour such as "#1d4ed8"');
            }}
          />
        </div>
      </Field>

      {COPY_DEFAULTS.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          hint={`Default: ${f.hint.replace(/^Default: /, '')}`}
          error={errors[`hostedPages.copy.${String(f.key)}`]}
        >
          <Textarea
            rows={f.rows}
            maxLength={500}
            placeholder={f.hint.replace(/^Default: /, '')}
            value={(brand.copy?.[f.key] as string | undefined) ?? ''}
            readOnly={readOnly}
            onChange={(e) => setCopy({ [f.key]: e.target.value || undefined })}
          />
        </Field>
      ))}
    </div>
  );
}

function HostedPagePreview({ formId, savedVersion }: { formId: string; savedVersion: number }) {
  const preview = useApi(() => api.call('hostedPages.preview', { page: 'confirm', formId }), [formId, savedVersion]);
  return (
    <div className="space-y-2">
      <p className="text-[12px] font-medium text-fg-2">Confirm page preview</p>
      {preview.loading ? (
        <LoadingBlock lines={5} label="Rendering the confirm page" />
      ) : preview.error ? (
        <Alert tone="bad" title="Couldn't render the confirm page" onRetry={preview.reload}>
          {preview.error}
        </Alert>
      ) : (
        <iframe
          title="Confirm page preview"
          sandbox=""
          srcDoc={preview.data?.html ?? ''}
          className="h-[420px] w-full rounded-md border border-line bg-white"
        />
      )}
      <p className="text-[12px] text-muted">This preview uses the saved version. Save to update it.</p>
    </div>
  );
}

const localHosts = ['localhost', '127.0.0.1', '[::1]', '::1'];

function brandUrlError(value: string, logo: boolean): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return null;
    if (url.protocol === 'http:' && localHosts.includes(url.hostname)) return null;
  } catch {
    // Not a URL at all.
  }
  return logo
    ? 'Use an https URL for the logo (http only on localhost, for development)'
    : 'Use an https URL, or http on localhost for development';
}

function hexForPicker(value?: string): string {
  if (value && HEX_RE.test(value)) {
    if (value.length === 4) return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
    return value;
  }
  return '#1d4ed8';
}
