import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Button, Checkbox, Field, FieldGroup, IconButton, Input, Select, Textarea } from '../../ui';
import type { EditorProps } from './ArtifactDetailPage';
import { JsonEditor } from './JsonEditor';

// A prompt for AI journey steps: decide between options, write text for slots, or classify a text.
// The definition is versioned like any artifact; its test cases stay JSON so they can carry profile
// traits and events. Unknown fields (cache, and anything newer) are kept as they are.

interface PromptOption {
  key: string;
  description: string;
}

interface PromptSlot {
  name: string;
  description: string;
  maxLength: number;
  fallback: string;
}

interface PromptCache {
  segments?: string[];
  ttlHours?: number;
  [key: string]: unknown;
}

interface PromptContent {
  kind?: 'decide' | 'generate' | 'classify';
  instructions?: string;
  model?: 'default' | 'fast';
  temperature?: number;
  maxOutputTokens?: number;
  options?: PromptOption[];
  slots?: PromptSlot[];
  forbidden?: string[];
  tests?: unknown[];
  trait?: string;
  review?: { sampleRate?: number; [key: string]: unknown };
  cache?: PromptCache;
  [key: string]: unknown;
}

const KIND_HINT: Record<NonNullable<PromptContent['kind']>, string> = {
  decide: 'The model chooses one of the options for each person. A journey AI step takes the matching edge.',
  generate: 'The model writes text for each content slot. A journey AI step fills the e-mail or message with it.',
  classify: 'The model labels a text with one of the options, for example sorting an incoming message.',
};

const KIND_LABEL: Record<NonNullable<PromptContent['kind']>, string> = {
  decide: 'Decide: choose one option for a person',
  generate: 'Generate: write text for content slots',
  classify: 'Classify: label a text',
};

/** Number input that lets a person clear or type a partial value without the field jumping to 0. */
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  hint,
  error,
  readOnly,
  placeholder,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  error?: string;
  readOnly?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(String(value));
  // biome-ignore lint/correctness/useExhaustiveDependencies: only follow changes from outside this field, not the local text
  useEffect(() => {
    if (Number(text) !== value) setText(Number.isFinite(value) ? String(value) : '');
  }, [value]);
  return (
    <Field label={label} unit={unit} hint={hint} error={error}>
      <Input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        value={text}
        readOnly={readOnly}
        onBlur={() => setText(Number.isFinite(value) ? String(value) : '')}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (t.trim() === '') return;
          const n = Number(t);
          if (!Number.isFinite(n)) return;
          onChange(Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n)));
        }}
      />
    </Field>
  );
}

export function PromptEditor({ content, onChange, readOnly, errors }: EditorProps<PromptContent>) {
  const set = (patch: Partial<PromptContent>) => onChange({ ...content, ...patch });
  const remove = (key: keyof PromptContent) => {
    const next = { ...content };
    delete next[key];
    onChange(next);
  };
  const kind = content.kind ?? 'decide';
  const options = content.options ?? [];
  const slots = content.slots ?? [];
  const forbidden = content.forbidden ?? [];
  const segments = useApi(() => api.call('artifacts.list', { type: 'segment' as never, limit: 200 }), []);
  const cacheSegments = content.cache?.segments ?? [];
  const [forbiddenText, setForbiddenText] = useState(forbidden.join('\n'));
  // biome-ignore lint/correctness/useExhaustiveDependencies: only follow changes from outside this field, not the local text
  useEffect(() => {
    const parsed = forbiddenText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    if (parsed.join('\n') !== forbidden.join('\n')) setForbiddenText(forbidden.join('\n'));
  }, [forbidden]);

  const setKind = (next: PromptContent['kind']) => {
    const patch: Partial<PromptContent> = { ...content, kind: next };
    if (next !== 'classify') delete patch.trait;
    if (next !== 'generate') delete patch.cache;
    onChange(patch);
  };

  return (
    <div className="max-w-[760px] space-y-6">
      <FieldGroup legend="What it does">
        <Field label="Kind" hint={KIND_HINT[kind]} error={errors.kind}>
          <Select value={kind} disabled={readOnly} onChange={(e) => setKind(e.target.value as PromptContent['kind'])}>
            {(Object.keys(KIND_LABEL) as NonNullable<PromptContent['kind']>[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Instructions"
          hint={`What the model should do. The person (traits, recent events, trigger) is appended as delimited data. ${(content.instructions ?? '').length} of 8000 characters.`}
          error={errors.instructions}
          required
        >
          <Textarea
            rows={6}
            value={content.instructions ?? ''}
            maxLength={8000}
            readOnly={readOnly}
            onChange={(e) => set({ instructions: e.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Model" hint="Default is the provider's main model; fast is its cheaper one." error={errors.model}>
            <Select
              value={content.model ?? 'default'}
              disabled={readOnly}
              onChange={(e) => set({ model: e.target.value as PromptContent['model'] })}
            >
              <option value="default">Default model</option>
              <option value="fast">Fast model</option>
            </Select>
          </Field>
          <NumberField
            label="Temperature"
            value={content.temperature ?? 0.2}
            min={0}
            max={1}
            step={0.1}
            hint="0 is steady, 1 is varied."
            error={errors.temperature}
            readOnly={readOnly}
            onChange={(n) => set({ temperature: n })}
          />
          <NumberField
            label="Max output tokens"
            value={content.maxOutputTokens ?? 400}
            min={16}
            max={4000}
            step={1}
            unit="tokens"
            hint="Upper limit for one answer."
            error={errors.maxOutputTokens}
            readOnly={readOnly}
            onChange={(n) => set({ maxOutputTokens: Math.round(n) })}
          />
        </div>
      </FieldGroup>

      {(kind === 'decide' || kind === 'classify') && (
        <FieldGroup
          legend={kind === 'decide' ? 'Options' : 'Labels'}
          hint={kind === 'decide' ? 'One per choice; a journey step maps each key to an edge.' : 'One per label the model may return.'}
        >
          <div className="space-y-2">
            {options.map((o, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: options are editable rows whose key field is being typed, so position is the only stable identity
              <div key={i} className="grid gap-2 sm:grid-cols-[minmax(140px,200px)_minmax(0,1fr)_auto] sm:items-start">
                <Field
                  label="Key"
                  hideLabel={i > 0}
                  hint={i === 0 ? 'Lowercase letters, digits and underscore; starts with a letter.' : undefined}
                  error={errors[`options.${i}.key`]}
                >
                  <Input
                    value={o.key}
                    readOnly={readOnly}
                    maxLength={32}
                    placeholder="vip"
                    onChange={(e) => set({ options: options.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
                  />
                </Field>
                <Field label="Description" hideLabel={i > 0} error={errors[`options.${i}.description`]}>
                  <Input
                    value={o.description}
                    readOnly={readOnly}
                    maxLength={500}
                    placeholder="Loyal, high-value customer: early access, no discount"
                    onChange={(e) => set({ options: options.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })}
                  />
                </Field>
                {!readOnly && (
                  <div className="pt-5 sm:pt-[22px]">
                    <IconButton
                      label={`Remove option ${o.key || i + 1}`}
                      icon={<Trash2 size={14} />}
                      variant="danger"
                      onClick={() => set({ options: options.filter((_, j) => j !== i) })}
                    />
                  </div>
                )}
              </div>
            ))}
            {!options.length && <p className="text-[12px] text-muted">At least two options are needed.</p>}
            {!readOnly && options.length < (kind === 'decide' ? 6 : 20) && (
              <Button
                variant="secondary"
                icon={<Plus size={14} />}
                onClick={() => set({ options: [...options, { key: '', description: '' }] })}
              >
                Add option
              </Button>
            )}
          </div>
        </FieldGroup>
      )}

      {kind === 'generate' && (
        <>
          <FieldGroup legend="Slots" hint="Templates use them as {{ content.<name> }}. If generation fails, the fallback text is used.">
            <p className="text-[12px] text-muted">At least one slot is needed.</p>
            <div className="space-y-3">
              {slots.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: slots are editable rows whose name field is being typed, so position is the only stable identity
                <div key={i} className="space-y-2 rounded-md border border-line p-3">
                  <div className="grid gap-2 sm:grid-cols-[minmax(140px,200px)_minmax(0,1fr)_minmax(120px,150px)_auto] sm:items-start">
                    <Field label="Name" error={errors[`slots.${i}.name`]}>
                      <Input
                        value={s.name}
                        readOnly={readOnly}
                        maxLength={32}
                        placeholder="headline"
                        onChange={(e) => set({ slots: slots.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                      />
                    </Field>
                    <Field label="Description" error={errors[`slots.${i}.description`]}>
                      <Input
                        value={s.description}
                        readOnly={readOnly}
                        maxLength={500}
                        placeholder="A short, warm subject line"
                        onChange={(e) => set({ slots: slots.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })}
                      />
                    </Field>
                    <Field label="Max length" unit="chars" error={errors[`slots.${i}.maxLength`]}>
                      <Input
                        type="number"
                        min={1}
                        max={2000}
                        value={s.maxLength}
                        readOnly={readOnly}
                        onChange={(e) =>
                          set({ slots: slots.map((x, j) => (j === i ? { ...x, maxLength: Number(e.target.value) || 1 } : x)) })
                        }
                      />
                    </Field>
                    {!readOnly && (
                      <div className="pt-5">
                        <IconButton
                          label={`Remove slot ${s.name || i + 1}`}
                          icon={<Trash2 size={14} />}
                          variant="danger"
                          onClick={() => set({ slots: slots.filter((_, j) => j !== i) })}
                        />
                      </div>
                    )}
                  </div>
                  <Field
                    label="Fallback"
                    hint="Used when generation fails or the text does not pass the checks."
                    error={errors[`slots.${i}.fallback`]}
                  >
                    <Textarea
                      rows={2}
                      value={s.fallback}
                      maxLength={2000}
                      readOnly={readOnly}
                      onChange={(e) => set({ slots: slots.map((x, j) => (j === i ? { ...x, fallback: e.target.value } : x)) })}
                    />
                  </Field>
                </div>
              ))}
              {!readOnly && slots.length < 10 && (
                <Button
                  variant="secondary"
                  icon={<Plus size={14} />}
                  onClick={() => set({ slots: [...slots, { name: '', description: '', maxLength: 200, fallback: '' }] })}
                >
                  Add slot
                </Button>
              )}
            </div>
          </FieldGroup>

          <Field
            label="Forbidden phrases"
            hint="One per line. The generated text may never contain them (claims, words)."
            error={errors.forbidden}
          >
            <Textarea
              rows={4}
              value={forbiddenText}
              readOnly={readOnly}
              onChange={(e) => {
                const t = e.target.value;
                setForbiddenText(t);
                set({
                  forbidden: t
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .slice(0, 100),
                });
              }}
            />
          </Field>

          <FieldGroup
            legend="Cache"
            hint="Reuse one generated text for everyone in the same segments, from the segment names alone (no personal data)."
          >
            <Checkbox
              checked={!!content.cache}
              disabled={readOnly}
              label="Reuse generated text per segment"
              hint="Each combination of the segments below gets its own text until the cache expires."
              onChange={(e) => (e.target.checked ? set({ cache: { segments: [], ttlHours: 24 } }) : remove('cache'))}
            />
            {content.cache && (
              <>
                <div>
                  <p className="mb-1 text-[12px] font-medium text-fg-2">Segments</p>
                  <p className="text-[12px] text-muted">
                    Choose at least one. Text is written once per combination, so people in the same segments see the same words.
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {segments.loading && <p className="text-[12px] text-muted">Loading segments…</p>}
                    {segments.error && <p className="text-[12px] text-bad">Couldn't load the segments: {segments.error}</p>}
                    {segments.data?.artifacts.map((a) => (
                      <Checkbox
                        key={a.id}
                        checked={cacheSegments.includes(a.id)}
                        disabled={readOnly}
                        label={
                          <>
                            {a.name}{' '}
                            {a.publishedVersion ? (
                              <span className="text-muted">· live v{a.publishedVersion}</span>
                            ) : (
                              <span className="text-muted">· not live yet</span>
                            )}
                          </>
                        }
                        onChange={(e) =>
                          set({
                            cache: {
                              ...content.cache,
                              segments: e.target.checked ? [...cacheSegments, a.id] : cacheSegments.filter((id) => id !== a.id),
                            },
                          })
                        }
                      />
                    ))}
                    {!segments.loading && !segments.error && !segments.data?.artifacts.length && (
                      <p className="text-[12px] text-muted">This workspace has no segments yet. Create one under Build → Segments.</p>
                    )}
                  </div>
                  {errors['cache.segments'] && <p className="mt-1 text-[12px] text-bad">{errors['cache.segments']}</p>}
                </div>
                <NumberField
                  label="Keep cached text for"
                  value={content.cache.ttlHours ?? 24}
                  min={1}
                  max={720}
                  step={1}
                  unit="hours"
                  hint="After this, the next person in those segments gets fresh text."
                  error={errors['cache.ttlHours']}
                  readOnly={readOnly}
                  onChange={(n) => set({ cache: { ...content.cache, ttlHours: Math.round(n) } })}
                />
              </>
            )}
          </FieldGroup>
        </>
      )}

      {kind === 'classify' && (
        <Field label="Trait" hint="When ai.classify is given a person, store the label in this profile trait." error={errors.trait}>
          <Input
            value={content.trait ?? ''}
            readOnly={readOnly}
            maxLength={64}
            placeholder="intent"
            onChange={(e) => {
              const v = e.target.value.trim();
              if (v) set({ trait: v });
              else remove('trait');
            }}
          />
        </Field>
      )}

      <FieldGroup legend="Review">
        <Checkbox
          checked={!!content.review}
          disabled={readOnly}
          label="Set answers aside for a person to review"
          hint="Samples appear under AI reviews and do not change what the model did."
          onChange={(e) =>
            e.target.checked
              ? set({ review: { ...(content.review ?? {}), sampleRate: content.review?.sampleRate ?? 0.05 } })
              : remove('review')
          }
        />
        {content.review && (
          <NumberField
            label="Sample rate"
            value={Math.round((content.review.sampleRate ?? 0.05) * 10000) / 100}
            min={0}
            max={100}
            step={1}
            unit="%"
            hint="Share of answered calls set aside for review."
            error={errors['review.sampleRate']}
            readOnly={readOnly}
            onChange={(n) => set({ review: { ...content.review, sampleRate: n / 100 } })}
          />
        )}
      </FieldGroup>

      <JsonEditor
        label="Test cases (JSON)"
        hint="Each case can carry profile traits, recent events and what the answer must contain. Run them on the Tests tab."
        rows={16}
        value={content.tests ?? []}
        readOnly={readOnly}
        onChange={(v) => set({ tests: v as unknown[] })}
      />
    </div>
  );
}
