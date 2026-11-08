import { Code2, Eye, Paintbrush, Plus, Redo2, SquareDashed, Undo2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, EditorSkeleton, Field, IconButton, Input, Segmented, Select, Textarea } from '../../ui';
import { Identifier } from '../../ui/Identifier';
import type { EditorProps } from '../artifacts/ArtifactDetailPage';
import { JsonEditor } from '../artifacts/JsonEditor';
import { topicsOf } from '../artifacts/PurposesEditor';
import { AssetPicker } from '../assets/AssetPicker';
import { EditorPreview } from './EditorPreview';
import { type InsertElementKind, InsertPalette } from './InsertPalette';
import { imageTag, lostLiquid } from './liquid';
import { templateContentChanged } from './localRender';
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
 * Liquid; images from the asset library (#35); sample data and UTM under Advanced. One toolbar
 * (Visual / MJML and Liquid, Insert, Undo, Redo, Outlines, Preview) replaces the GrapesJS chrome
 * and the separate block panels (Phase 25, #499).
 */
export function TemplateEditor({ artifact, content, onChange, readOnly, errors }: EditorProps<TemplateContent>) {
  const [view, setView] = useState<'visual' | 'code'>('visual');
  // At 1440 the preview cannot sit beside a canvas wide enough for an e-mail. Start it closed
  // there; only a viewport wide enough for both panes opens with the preview showing.
  const [showPreview, setShowPreview] = useState(() => window.innerWidth >= 1536);
  const [inserting, setInserting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pendingInsert, setPendingInsert] = useState<{ kind: InsertElementKind; columns?: 1 | 2 } | null>(null);
  const [visualReady, setVisualReady] = useState(false);
  const [outlines, setOutlines] = useState(false);
  const purposes = useApi(() => api.call('purposes.list', {}), []);
  const purposeOptions = purposes.data?.purposes ?? [];
  const knownPurpose = purposeOptions.some((p) => p.key === content.purpose);
  const topicOptions = topicsOf(purposeOptions, content.purpose);
  const knownTopic = topicOptions.some((t) => t.key === content.topic);
  const visual = useRef<VisualMjmlHandle>(null);
  const code = useRef<HTMLTextAreaElement>(null);
  const insertButton = useRef<HTMLButtonElement>(null);
  const savedContent = artifact.version.content as TemplateContent;
  const saved = savedContent.mjml;
  const dirty = templateContentChanged(content, savedContent);
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

  useEffect(() => {
    if (view !== 'visual') setVisualReady(false);
  }, [view]);

  // An element inserted from code view waits for the visual editor to mount, then lands in the
  // selected column (or the first one) just as if it had been inserted from the canvas.
  useEffect(() => {
    if (!pendingInsert || view !== 'visual' || !visualReady) return;
    visual.current?.insertElement(pendingInsert.kind, pendingInsert.columns);
    setPendingInsert(null);
  }, [pendingInsert, view, visualReady]);

  const insertTag = (tag: string) => {
    const el = view === 'code' ? code.current : null;
    if (!el) {
      setView('code');
      set({ mjml: `${content.mjml}\n${tag}` });
      return;
    }
    const at = el.selectionStart ?? content.mjml.length;
    set({ mjml: content.mjml.slice(0, at) + tag + content.mjml.slice(at) });
  };

  const insertImage = (src: string, alt: string) => {
    if (view === 'visual' && visualReady) {
      visual.current?.insertImage(src, alt);
      return;
    }
    insertTag(imageTag(src, alt));
  };

  const insertElement = (kind: InsertElementKind, columns?: 1 | 2) => {
    setInserting(false);
    insertButton.current?.focus();
    if (kind === 'image') {
      setPicking(true);
      return;
    }
    if (view !== 'visual' || !visualReady) {
      setPendingInsert({ kind, columns });
      setView('visual');
      return;
    }
    visual.current?.insertElement(kind, columns);
  };

  return (
    <div className="min-w-0 space-y-5">
      <section aria-labelledby="template-message" className="space-y-3">
        <h2 id="template-message" className="text-[13px] font-semibold text-fg">
          Message
        </h2>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Field label="Subject" hint="Liquid works here, e.g. {{ profile.firstName | default: 'there' }}." error={errors.subject} required>
            <Input value={content.subject ?? ''} readOnly={readOnly} maxLength={300} onChange={(e) => set({ subject: e.target.value })} />
          </Field>
          <Field label="Preheader" hint="The preview text inboxes show after the subject." error={errors.preheader}>
            <Input
              value={content.preheader ?? ''}
              readOnly={readOnly}
              maxLength={300}
              onChange={(e) => set({ preheader: e.target.value || undefined })}
            />
          </Field>
          <Field label="Purpose" hint="Decides consent and the unsubscribe link." error={errors.purpose} required>
            <Select
              value={content.purpose ?? ''}
              disabled={readOnly || purposes.loading}
              onChange={(e) => {
                const purpose = e.target.value;
                const keys = topicsOf(purposeOptions, purpose).map((t) => t.key);
                set({ purpose, topic: content.topic && keys.includes(content.topic) ? content.topic : undefined });
              }}
            >
              {!content.purpose && <option value="">Choose…</option>}
              {content.purpose && !knownPurpose && (
                <option value={content.purpose}>{purposes.loading ? 'Loading purpose…' : 'Unavailable purpose'}</option>
              )}
              {purposeOptions.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
            {content.purpose && !knownPurpose && purposes.data && (
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] leading-[18px] text-muted">
                The saved purpose is unavailable. Choose a purpose to replace it.
                <Identifier value={content.purpose} label="Purpose ID" />
              </p>
            )}
          </Field>
          <Field label="Topic (optional)" hint="A finer choice under the purpose." error={errors.topic}>
            <Select
              value={content.topic ?? ''}
              disabled={readOnly || purposes.loading || topicOptions.length === 0}
              onChange={(e) => set({ topic: e.target.value || undefined })}
            >
              <option value="">{topicOptions.length ? 'No topic' : 'No topics'}</option>
              {content.topic && !knownTopic && (
                <option value={content.topic}>{purposes.loading ? 'Loading topic…' : 'Unavailable topic'}</option>
              )}
              {topicOptions.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Editor"
          value={view}
          onChange={setView}
          items={[
            { key: 'visual', label: 'Visual', icon: <Paintbrush size={13} aria-hidden /> },
            { key: 'code', label: 'MJML and Liquid', icon: <Code2 size={13} aria-hidden /> },
          ]}
        />
        {!readOnly && (
          <>
            <div className="relative">
              <Button
                ref={insertButton}
                size="sm"
                icon={<Plus size={14} aria-hidden />}
                aria-expanded={inserting}
                aria-haspopup="dialog"
                onClick={() => setInserting((v) => !v)}
              >
                Insert
              </Button>
              {inserting && (
                <InsertPalette
                  onClose={() => {
                    setInserting(false);
                    insertButton.current?.focus();
                  }}
                  onInsertElement={insertElement}
                  onInsertImage={() => {
                    setInserting(false);
                    insertButton.current?.focus();
                    setPicking(true);
                  }}
                  onInsertBlock={(tag) => {
                    setInserting(false);
                    insertButton.current?.focus();
                    insertTag(tag);
                  }}
                />
              )}
            </div>
            <IconButton
              label="Undo"
              size="sm"
              icon={<Undo2 size={15} aria-hidden />}
              disabled={view !== 'visual'}
              onClick={() => visual.current?.undo()}
            />
            <IconButton
              label="Redo"
              size="sm"
              icon={<Redo2 size={15} aria-hidden />}
              disabled={view !== 'visual'}
              onClick={() => visual.current?.redo()}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={outlines}
              disabled={view !== 'visual'}
              icon={<SquareDashed size={14} aria-hidden />}
              onClick={() => {
                setOutlines((v) => !v);
                visual.current?.toggleOutlines();
              }}
            >
              Outlines
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant={showPreview ? 'secondary' : 'ghost'}
          aria-pressed={showPreview}
          icon={<Eye size={14} aria-hidden />}
          onClick={() => setShowPreview((v) => !v)}
        >
          Preview
        </Button>
      </div>
      {lost.length > 0 && (
        <Alert tone="warn" title="Liquid changed in the visual editor">
          These placeholders are gone or changed: {lost.slice(0, 4).join(', ')}. Fix them in “MJML and Liquid” before saving, or discard the
          changes.
        </Alert>
      )}
      {errors.mjml && <Alert tone="bad">{errors.mjml}</Alert>}
      <div className={showPreview ? 'grid gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(320px,480px)]' : undefined}>
        <div className="min-w-0">
          {view === 'visual' ? (
            readOnly ? (
              <Alert tone="info">Your role can read this template but not edit it. The preview shows the saved version.</Alert>
            ) : (
              <div className="h-[calc(100vh-340px)] min-h-[420px] min-w-0 overflow-hidden rounded-lg border border-line md:min-h-[560px]">
                <Suspense fallback={<EditorSkeleton label="Loading the visual editor" />}>
                  <VisualMjml
                    key={visualKey}
                    ref={visual}
                    mjml={content.mjml}
                    onChange={(mjml) => set({ mjml })}
                    onReady={() => setVisualReady(true)}
                  />
                </Suspense>
              </div>
            )
          ) : (
            <Field label="MJML with Liquid" hideLabel>
              <Textarea
                ref={code}
                mono
                rows={26}
                spellCheck={false}
                readOnly={readOnly}
                value={content.mjml}
                onChange={(e) => set({ mjml: e.target.value })}
              />
            </Field>
          )}
        </div>
        {showPreview && (
          <div className="min-w-0 space-y-4 xl:sticky xl:top-16 xl:self-start">
            <EditorPreview artifactId={artifact.id} version={artifact.version.number} content={content} dirty={dirty} readOnly={readOnly} />
            <section aria-label="Before publishing" className="rounded-lg bg-surface-2 p-4">
              <h2 className="mb-1 text-[13px] font-semibold text-fg">Before publishing</h2>
              <p className="text-[12px] leading-[18px] text-fg-2">
                {dirty
                  ? 'This is an unsaved draft preview. Save the draft before sending a test or submitting for review.'
                  : `Showing saved v${artifact.version.number}. Desktop, mobile, dark mail and the text version are view modes, not versions.`}
              </p>
              <p className="mt-2 text-[12px] leading-[18px] text-muted">
                “Send me a test” sends the saved version to your own address, never this local draft.
              </p>
            </section>
          </div>
        )}
      </div>

      <details className="rounded-lg border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer text-[13px] font-medium">Advanced: text version, sample data, UTM</summary>
        <div className="mt-4 space-y-4">
          <Field label="Plain-text version" hint="Leave empty to generate it from the HTML." error={errors.text}>
            <Textarea
              mono
              rows={6}
              value={content.text ?? ''}
              readOnly={readOnly}
              onChange={(e) => set({ text: e.target.value || undefined })}
            />
          </Field>
          <JsonEditor
            label="Sample data for previews"
            hint='Variables used by Preview and tests, e.g. {"profile": {"firstName": "Ada"}}.'
            value={content.sampleData ?? {}}
            onChange={(v) => set({ sampleData: v as Record<string, unknown> })}
            readOnly={readOnly}
            rows={6}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="UTM source" hint="Default newsletter." error={errors['utm.source']}>
              <Input
                value={content.utm?.source ?? ''}
                readOnly={readOnly}
                onChange={(e) => set({ utm: { ...(content.utm ?? {}), source: e.target.value || undefined } })}
              />
            </Field>
            <Field label="UTM medium" hint="Default email." error={errors['utm.medium']}>
              <Input
                value={content.utm?.medium ?? ''}
                readOnly={readOnly}
                onChange={(e) => set({ utm: { ...(content.utm ?? {}), medium: e.target.value || undefined } })}
              />
            </Field>
            <Field label="UTM campaign" hint="e.g. signal-43." error={errors['utm.campaign']}>
              <Input
                value={content.utm?.campaign ?? ''}
                readOnly={readOnly}
                onChange={(e) => set({ utm: { ...(content.utm ?? {}), campaign: e.target.value || undefined } })}
              />
            </Field>
          </div>
        </div>
      </details>
      {picking && (
        <AssetPicker
          title="Insert an image"
          onClose={() => setPicking(false)}
          onPick={(a) => {
            insertImage(a.url, a.altText);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
