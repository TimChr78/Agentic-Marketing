import { Code2, ImageIcon, Paintbrush } from 'lucide-react';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, Field, Input, LoadingBlock, Segmented, Select, Textarea } from '../../ui';
import type { EditorProps } from '../artifacts/ArtifactDetailPage';
import { JsonEditor } from '../artifacts/JsonEditor';
import { topicsOf } from '../artifacts/PurposesEditor';
import { AssetPicker } from '../assets/AssetPicker';
import { imageTag, lostLiquid } from './liquid';
import type { VisualMjmlHandle } from './VisualMjml';

const VisualMjml = lazy(() => import('./VisualMjml'));

export interface TemplateContent {
  purpose: string;
  topic?: string;
  subject: string;
  preheader?: string;
  mjml: string;
  text?: string;
  sampleData?: Record<string, unknown>;
  utm?: { source?: string; medium?: string; campaign?: string; domains?: string[] };
}

/**
 * E-mail template editor: subject, preheader and purpose; the body in GrapesJS or as MJML with
 * Liquid; images from the asset library (#35); sample data and UTM under Advanced.
 */
export function TemplateEditor({ artifact, content, onChange, readOnly, errors }: EditorProps<TemplateContent>) {
  const [mode, setMode] = useState<'visual' | 'code'>('visual');
  const [picking, setPicking] = useState(false);
  const purposes = useApi(() => api.call('purposes.list', {}), []);
  const visual = useRef<VisualMjmlHandle>(null);
  const code = useRef<HTMLTextAreaElement>(null);
  const saved = (artifact.version.content as TemplateContent).mjml;
  const lost = useMemo(() => lostLiquid(saved, content.mjml), [saved, content.mjml]);
  const set = (p: Partial<TemplateContent>) => onChange({ ...content, ...p });
  // Remount the visual editor when the content goes back to the saved one (discard) or the saved
  // version changes (save, reload); not while someone is editing in it.
  const resets = useRef(0);
  const wasDirty = useRef(false);
  const clean = content.mjml === saved;
  if (wasDirty.current && clean) resets.current++;
  wasDirty.current = !clean;
  const visualKey = `${artifact.version.contentHash}-${resets.current}`;

  const insert = (src: string, alt: string) => {
    if (mode === 'visual') return visual.current?.insertImage(src, alt);
    const el = code.current;
    const tag = imageTag(src, alt);
    if (!el) return set({ mjml: `${content.mjml}\n${tag}` });
    const at = el.selectionStart ?? content.mjml.length;
    set({ mjml: content.mjml.slice(0, at) + tag + content.mjml.slice(at) });
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Field label="Subject" hint="Liquid works here, e.g. {{ profile.firstName | default: 'there' }}." error={errors.subject} required>
          <Input value={content.subject ?? ''} readOnly={readOnly} maxLength={300} onChange={(e) => set({ subject: e.target.value })} />
        </Field>
        <Field label="Preheader" hint="The preview text inboxes show after the subject." error={errors.preheader}>
          <Input value={content.preheader ?? ''} readOnly={readOnly} maxLength={300} onChange={(e) => set({ preheader: e.target.value || undefined })} />
        </Field>
        <Field label="Purpose" hint="Decides consent and the unsubscribe link." error={errors.purpose} required>
          <Select
            value={content.purpose ?? ''}
            disabled={readOnly || purposes.loading}
            onChange={(e) => {
              const purpose = e.target.value;
              const keys = topicsOf(purposes.data?.purposes ?? [], purpose).map((t) => t.key);
              set({ purpose, topic: content.topic && keys.includes(content.topic) ? content.topic : undefined });
            }}
          >
            {!purposes.data?.purposes.some((p) => p.key === content.purpose) && <option value={content.purpose}>{content.purpose || 'Choose…'}</option>}
            {purposes.data?.purposes.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} ({p.key})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Topic (optional)" hint="A finer choice under the purpose." error={errors.topic}>
          <Select
            value={content.topic ?? ''}
            disabled={readOnly || purposes.loading || topicsOf(purposes.data?.purposes ?? [], content.purpose).length === 0}
            onChange={(e) => set({ topic: e.target.value || undefined })}
          >
            <option value="">{topicsOf(purposes.data?.purposes ?? [], content.purpose).length ? 'No topic' : 'No topics'}</option>
            {topicsOf(purposes.data?.purposes ?? [], content.purpose).map((t) => (
              <option key={t.key} value={t.key}>
                {t.name} ({t.key})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Editor"
          value={mode}
          onChange={setMode}
          items={[
            { key: 'visual', label: 'Visual', icon: <Paintbrush size={13} aria-hidden /> },
            { key: 'code', label: 'MJML and Liquid', icon: <Code2 size={13} aria-hidden /> },
          ]}
        />
        {!readOnly && (
          <Button size="sm" icon={<ImageIcon size={14} />} onClick={() => setPicking(true)}>
            Insert image
          </Button>
        )}
      </div>
      {lost.length > 0 && (
        <Alert tone="warn" title="Liquid changed in the visual editor">
          These placeholders are gone or changed: {lost.slice(0, 4).join(', ')}. Fix them in “MJML and Liquid” before saving, or discard the changes.
        </Alert>
      )}
      {errors.mjml && <Alert tone="bad">{errors.mjml}</Alert>}
      {mode === 'visual' ? (
        readOnly ? (
          <Alert tone="info">Your role can read this template but not edit it. Open Preview to see it rendered.</Alert>
        ) : (
          <div className="h-[calc(100vh-300px)] min-h-[560px] overflow-hidden rounded-lg border border-line">
            <Suspense fallback={<LoadingBlock lines={8} label="Loading the visual editor" />}>
              <VisualMjml key={visualKey} ref={visual} mjml={content.mjml} onChange={(mjml) => set({ mjml })} />
            </Suspense>
          </div>
        )
      ) : (
        <Field label="MJML with Liquid" hideLabel>
          <Textarea ref={code} mono rows={26} spellCheck={false} readOnly={readOnly} value={content.mjml} onChange={(e) => set({ mjml: e.target.value })} />
        </Field>
      )}

      <details className="rounded-lg border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer text-[13px] font-medium">Advanced: text version, sample data, UTM</summary>
        <div className="mt-4 space-y-4">
          <Field label="Plain-text version" hint="Leave empty to generate it from the HTML." error={errors.text}>
            <Textarea mono rows={6} value={content.text ?? ''} readOnly={readOnly} onChange={(e) => set({ text: e.target.value || undefined })} />
          </Field>
          <JsonEditor label="Sample data for previews" hint='Variables used by Preview and tests, e.g. {"profile": {"firstName": "Ada"}}.' value={content.sampleData ?? {}} onChange={(v) => set({ sampleData: v as Record<string, unknown> })} readOnly={readOnly} rows={6} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="UTM source" hint="Default newsletter." error={errors['utm.source']}>
              <Input value={content.utm?.source ?? ''} readOnly={readOnly} onChange={(e) => set({ utm: { ...(content.utm ?? {}), source: e.target.value || undefined } })} />
            </Field>
            <Field label="UTM medium" hint="Default email." error={errors['utm.medium']}>
              <Input value={content.utm?.medium ?? ''} readOnly={readOnly} onChange={(e) => set({ utm: { ...(content.utm ?? {}), medium: e.target.value || undefined } })} />
            </Field>
            <Field label="UTM campaign" hint="e.g. signal-43." error={errors['utm.campaign']}>
              <Input value={content.utm?.campaign ?? ''} readOnly={readOnly} onChange={(e) => set({ utm: { ...(content.utm ?? {}), campaign: e.target.value || undefined } })} />
            </Field>
          </div>
        </div>
      </details>
      {picking && (
        <AssetPicker
          title="Insert an image"
          onClose={() => setPicking(false)}
          onPick={(a) => {
            insert(a.url, a.altText);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
