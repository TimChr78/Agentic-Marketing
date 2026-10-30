import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Button, Field, FieldGroup, IconButton, Input, Select, Textarea } from '../../ui';
import type { EditorProps } from './ArtifactDetailPage';
import { ArtifactSelect } from './ArtifactSelect';
import { JsonEditor } from './JsonEditor';

// A web experience: where it shows, when, who sees it, the variants and their weights, and the
// holdout. The targeting language is the decision API's smaller one; the JSON tab still edits the
// whole content for agents and for conditions this form does not cover.

type TriggerType = 'immediate' | 'exit_intent' | 'scroll' | 'time_on_page';
type AnalysisMethod = 'sequential' | 'bayesian' | 'fixed';

interface VariantContent {
  html?: string;
  json?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ExperienceVariant {
  id: string;
  name: string;
  weight: number;
  content: VariantContent;
  [key: string]: unknown;
}

interface ExperienceTrigger {
  type: TriggerType;
  value?: number;
  [key: string]: unknown;
}

interface ExperienceAnalysis {
  method: AnalysisMethod;
  alpha: number;
  threshold: number;
  [key: string]: unknown;
}

interface ExperienceContent {
  placement?: string;
  description?: string;
  priority?: number;
  targeting?: Record<string, unknown>;
  variants?: ExperienceVariant[];
  holdoutPercent?: number;
  goal?: { event?: string; [key: string]: unknown };
  analysis?: ExperienceAnalysis;
  trigger?: ExperienceTrigger;
  [key: string]: unknown;
}

const TRIGGER_LABEL: Record<TriggerType, string> = {
  immediate: 'At once, when the placement appears',
  exit_intent: 'When the visitor is about to leave',
  scroll: 'After scrolling a share of the page',
  time_on_page: 'After a time on the page',
};

const ANALYSIS_LABEL: Record<AnalysisMethod, string> = {
  sequential: 'Sequential: always-valid, check any time',
  bayesian: 'Bayesian: probability that a variant beats the control',
  fixed: 'Fixed: z-test at a planned sample size',
};

/** Sum of the variant weights, as the percentages people see in the editor. */
export function variantWeightTotal(variants: ExperienceVariant[] | undefined): number {
  return (variants ?? []).reduce((n, v) => n + (Number(v.weight) || 0), 0);
}

/** A stable, schema-valid id that is not used by another variant. */
export function nextVariantId(variants: ExperienceVariant[] | undefined): string {
  const used = new Set((variants ?? []).map((v) => v.id));
  for (let c = 0; c < 26; c++) {
    const id = String.fromCharCode(97 + c);
    if (!used.has(id)) return id;
  }
  for (let n = 1; ; n++) if (!used.has(`v${n}`)) return `v${n}`;
}

export function addVariant(variants: ExperienceVariant[] | undefined): ExperienceVariant[] {
  const list = variants ?? [];
  const letter = nextVariantId(list);
  return [...list, { id: letter, name: `Variant ${letter.toUpperCase()}`, weight: 50, content: { html: '' } }];
}

export function updateVariant(
  variants: ExperienceVariant[] | undefined,
  index: number,
  patch: Partial<ExperienceVariant>,
): ExperienceVariant[] {
  return (variants ?? []).map((v, i) => (i === index ? { ...v, ...patch } : v));
}

export function removeVariant(variants: ExperienceVariant[] | undefined, index: number): ExperienceVariant[] {
  return (variants ?? []).filter((_, i) => i !== index);
}

/** Move a variant one place up (delta -1) or down (+1); the first and last stay put. */
export function moveVariant(variants: ExperienceVariant[] | undefined, index: number, delta: -1 | 1): ExperienceVariant[] {
  const list = [...(variants ?? [])];
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const [item] = list.splice(index, 1);
  list.splice(to, 0, item);
  return list;
}

/** How the targeting editor presents the current decision condition. */
export function targetingKind(targeting: unknown): 'everyone' | 'segment' | 'custom' {
  if (!targeting) return 'everyone';
  if (typeof targeting === 'object' && typeof (targeting as { segment?: unknown }).segment === 'string') return 'segment';
  return 'custom';
}

/** A trigger keeps its value only for the kinds that use one; immediate/exit intent drop it. */
export function triggerFor(type: TriggerType, current?: ExperienceTrigger): ExperienceTrigger {
  if (type === 'immediate' || type === 'exit_intent') return { type };
  return { type, value: current?.value ?? (type === 'scroll' ? 50 : 15) };
}

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

export function ExperienceEditor({ content, onChange, readOnly, errors, warnings }: EditorProps<ExperienceContent>) {
  const set = (patch: Partial<ExperienceContent>) => onChange({ ...content, ...patch });
  const variants = content.variants ?? [];
  const trigger = content.trigger ?? { type: 'immediate' as TriggerType };
  const analysis = content.analysis ?? { method: 'sequential' as AnalysisMethod, alpha: 0.05, threshold: 0.95 };
  const total = variantWeightTotal(variants);
  const targeting = targetingKind(content.targeting);

  return (
    <div className="max-w-[900px] space-y-6">
      {warnings.length > 0 && (
        <Alert tone="warn" title="The schema still needs">
          <ul className="list-disc pl-4">
            {warnings.map((w) => (
              <li key={`${w.path}-${w.message}`}>{w.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <FieldGroup legend="Where it shows">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
          <Field
            label="Placement"
            hint="The element on your site marked data-am-placement=&quot;…&quot;. Lowercase letters, digits, _ and -."
            error={errors.placement}
            required
          >
            <Input
              value={content.placement ?? ''}
              readOnly={readOnly}
              maxLength={64}
              placeholder="article-footer"
              onChange={(e) => set({ placement: e.target.value })}
            />
          </Field>
          <NumberField
            label="Priority"
            value={content.priority ?? 100}
            min={0}
            max={1000}
            step={1}
            hint="Higher wins when several target the placement."
            error={errors.priority}
            readOnly={readOnly}
            onChange={(n) => set({ priority: Math.round(n) })}
          />
        </div>
        <Field label="Description" hint="For the team; visitors never see it." error={errors.description}>
          <Textarea
            rows={2}
            maxLength={1000}
            value={content.description ?? ''}
            readOnly={readOnly}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
      </FieldGroup>

      <FieldGroup legend="When it shows">
        <Field label="Trigger" error={errors['trigger.type']}>
          <Select
            value={trigger.type}
            disabled={readOnly}
            onChange={(e) => set({ trigger: triggerFor(e.target.value as TriggerType, trigger) })}
          >
            {(Object.keys(TRIGGER_LABEL) as TriggerType[]).map((t) => (
              <option key={t} value={t}>
                {TRIGGER_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        {(trigger.type === 'scroll' || trigger.type === 'time_on_page') && (
          <NumberField
            label={trigger.type === 'scroll' ? 'Scroll' : 'Wait'}
            value={trigger.value ?? (trigger.type === 'scroll' ? 50 : 15)}
            min={0}
            max={3600}
            step={1}
            unit={trigger.type === 'scroll' ? '%' : 'seconds'}
            hint={trigger.type === 'scroll' ? 'Share of the page scrolled past.' : 'Seconds on the page before it shows.'}
            error={errors['trigger.value'] ?? errors.trigger}
            readOnly={readOnly}
            onChange={(n) => set({ trigger: { ...trigger, value: Math.round(n) } })}
          />
        )}
      </FieldGroup>

      <FieldGroup
        legend="Who sees it"
        hint="Traits, segments and session conditions need web_personalization consent; page, referrer, UTM and device do not."
      >
        <Field label="Targeting" error={errors.targeting}>
          <Select
            value={targeting}
            disabled={readOnly}
            onChange={(e) => {
              const kind = e.target.value;
              if (kind === 'everyone') {
                const next = { ...content };
                delete next.targeting;
                onChange(next);
              } else if (kind === 'segment') set({ targeting: { segment: '' } });
              else set({ targeting: { page: {} } });
            }}
          >
            <option value="everyone">Everyone who sees the placement</option>
            <option value="segment">People in a segment</option>
            <option value="custom">A custom condition</option>
          </Select>
        </Field>
        {targeting === 'segment' && (
          <Field
            label="Segment"
            hint="Members of a published segment; evaluated from the segment snapshot."
            error={errors['targeting.segment']}
          >
            <ArtifactSelect
              type="segment"
              value={typeof content.targeting?.segment === 'string' ? content.targeting.segment : undefined}
              disabled={readOnly}
              onChange={(v) => set({ targeting: v ? { segment: v } : { segment: '' } })}
            />
          </Field>
        )}
        {targeting === 'custom' && (
          <JsonEditor
            label="Targeting condition (JSON)"
            hint="The decision condition, e.g. {&quot;page&quot;:{&quot;pathPrefix&quot;:&quot;/blog&quot;}} or {&quot;device&quot;:&quot;mobile&quot;}."
            value={content.targeting ?? { page: {} }}
            onChange={(v) => set({ targeting: (v ?? {}) as Record<string, unknown> })}
            readOnly={readOnly}
            rows={8}
          />
        )}
      </FieldGroup>

      <FieldGroup legend="Variants" hint="Up to five. Weights are relative shares; at least one must be above 0.">
        <div className="space-y-3">
          {variants.map((variant, i) => {
            const n = i + 1;
            const contentKind = variant.content?.html !== undefined ? 'html' : 'json';
            return (
              <div key={variant.id || i} className="space-y-3 rounded-md border border-line p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-muted">Variant {n}</span>
                  {!readOnly && (
                    <div className="ml-auto flex items-center gap-1">
                      <IconButton
                        label={`Move variant ${n} up`}
                        icon={<ArrowUp size={14} />}
                        size="sm"
                        onClick={() => set({ variants: moveVariant(variants, i, -1) })}
                        disabled={i === 0}
                      />
                      <IconButton
                        label={`Move variant ${n} down`}
                        icon={<ArrowDown size={14} />}
                        size="sm"
                        onClick={() => set({ variants: moveVariant(variants, i, 1) })}
                        disabled={i === variants.length - 1}
                      />
                      <IconButton
                        label={`Remove variant ${n}`}
                        icon={<Trash2 size={14} />}
                        size="sm"
                        variant="danger"
                        onClick={() => set({ variants: removeVariant(variants, i) })}
                        disabled={variants.length <= 1}
                        title={variants.length <= 1 ? 'An experience needs at least one variant.' : undefined}
                      />
                    </div>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_200px_130px] sm:items-start">
                  <Field label={`Name of variant ${n}`} error={errors[`variants.${i}.name`]} hideLabel={false}>
                    <Input
                      value={variant.name}
                      readOnly={readOnly}
                      maxLength={120}
                      placeholder={`Variant ${n}`}
                      onChange={(e) => set({ variants: updateVariant(variants, i, { name: e.target.value }) })}
                    />
                  </Field>
                  <Field label={`Id of variant ${n}`} hint="Lowercase letters, digits and _, up to 32." error={errors[`variants.${i}.id`]}>
                    <Input
                      value={variant.id}
                      readOnly={readOnly}
                      maxLength={32}
                      spellCheck={false}
                      onChange={(e) => set({ variants: updateVariant(variants, i, { id: e.target.value }) })}
                    />
                  </Field>
                  <NumberField
                    label={`Weight of variant ${n}`}
                    value={variant.weight}
                    min={0}
                    max={100}
                    step={1}
                    unit="%"
                    error={errors[`variants.${i}.weight`]}
                    readOnly={readOnly}
                    onChange={(weight) => set({ variants: updateVariant(variants, i, { weight: Math.round(weight) }) })}
                  />
                </div>
                <Field label={`Content for variant ${n}`} error={errors[`variants.${i}.content`]}>
                  <Select
                    value={contentKind}
                    disabled={readOnly}
                    aria-label={`Content kind for variant ${n}`}
                    onChange={(e) =>
                      set({
                        variants: updateVariant(variants, i, {
                          content: e.target.value === 'html' ? { html: '' } : { json: {} },
                        }),
                      })
                    }
                  >
                    <option value="html">HTML for the placement</option>
                    <option value="json">JSON data for the site to render</option>
                  </Select>
                </Field>
                {contentKind === 'html' ? (
                  <Field
                    label={`HTML for variant ${n}`}
                    hint="Scripts and event handlers are removed by the SDK."
                    error={errors[`variants.${i}.content.html`]}
                  >
                    <Textarea
                      rows={5}
                      mono
                      maxLength={50000}
                      spellCheck={false}
                      value={variant.content?.html ?? ''}
                      readOnly={readOnly}
                      placeholder="<p>Get the Tuesday signal.</p>"
                      onChange={(e) =>
                        set({ variants: updateVariant(variants, i, { content: { ...variant.content, html: e.target.value } }) })
                      }
                    />
                  </Field>
                ) : (
                  <JsonEditor
                    label={`JSON data for variant ${n}`}
                    hint="Data for a site that renders the placement itself."
                    value={variant.content?.json ?? {}}
                    onChange={(v) =>
                      set({
                        variants: updateVariant(variants, i, {
                          content: { ...variant.content, json: (v ?? {}) as Record<string, unknown> },
                        }),
                      })
                    }
                    readOnly={readOnly}
                    rows={6}
                  />
                )}
              </div>
            );
          })}
          {!variants.length && <p className="text-[12px] text-bad">Add at least one variant.</p>}
          {!readOnly && variants.length < 5 && (
            <Button variant="secondary" icon={<Plus size={14} />} onClick={() => set({ variants: addVariant(variants) })}>
              Add variant
            </Button>
          )}
        </div>
        <p className={total === 100 ? 'text-[12px] text-muted' : 'text-[12px] text-warn'} aria-live="polite">
          {variants.length === 0
            ? 'No variants yet.'
            : total === 100
              ? 'The weights total 100%.'
              : `The weights total ${total}%. Visitors are split in proportion to them; ${total === 0 ? 'at least one must be above 0.' : 'they do not have to add up to 100.'}`}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Holdout"
            value={content.holdoutPercent ?? 0}
            min={0}
            max={50}
            step={1}
            unit="%"
            hint="Eligible visitors who see nothing, as a control group."
            error={errors.holdoutPercent}
            readOnly={readOnly}
            onChange={(n) => set({ holdoutPercent: Math.round(n) })}
          />
        </div>
      </FieldGroup>

      <FieldGroup legend="Measurement" hint="Optional: the event that counts as a conversion, and how results call a winner.">
        <div>
          <Field
            label="Goal event"
            hint="For example Purchase or Newsletter Signup. Leave empty for no conversion goal."
            error={errors['goal.event']}
          >
            <Input
              value={content.goal?.event ?? ''}
              readOnly={readOnly}
              maxLength={200}
              placeholder="Newsletter Signup"
              onChange={(e) => {
                const event = e.target.value.trim();
                if (event) set({ goal: { ...content.goal, event } });
                else {
                  const next = { ...content };
                  delete next.goal;
                  onChange(next);
                }
              }}
            />
          </Field>
        </div>
        <Field label="Analysis" error={errors['analysis.method']}>
          <Select
            value={analysis.method}
            disabled={readOnly}
            onChange={(e) => set({ analysis: { ...analysis, method: e.target.value as AnalysisMethod } })}
          >
            {(Object.keys(ANALYSIS_LABEL) as AnalysisMethod[]).map((m) => (
              <option key={m} value={m}>
                {ANALYSIS_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Alpha"
            value={analysis.alpha}
            min={0.001}
            max={0.2}
            step={0.01}
            hint={analysis.method === 'bayesian' ? 'Not used by the Bayesian method.' : 'The false-positive rate to accept.'}
            error={errors['analysis.alpha']}
            readOnly={readOnly}
            onChange={(n) => set({ analysis: { ...analysis, alpha: n } })}
          />
          <NumberField
            label="Threshold"
            value={analysis.threshold}
            min={0.5}
            max={0.999}
            step={0.01}
            hint="Bayesian method: probability needed to call a winner."
            error={errors['analysis.threshold']}
            readOnly={readOnly}
            onChange={(n) => set({ analysis: { ...analysis, threshold: n } })}
          />
        </div>
      </FieldGroup>
    </div>
  );
}
