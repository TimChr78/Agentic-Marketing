import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, Checkbox, cx, Field, FieldGroup, IconButton, Input, Select, Switch, Textarea } from '../../ui';
import { ACTION_CLASS_LABEL, AUTONOMY_LEVEL, type Autonomy, levelFor, levelLabel, MANDATE_CLASSES } from '../agents/labels';
import type { EditorProps } from './ArtifactDetailPage';

// The borders a person grants one agent (ADR-0016, #228). A level per action class, never above
// the workspace ceiling and never 4 (a later release); the audiences, purposes, topics, channels
// and artifact types it may touch; limits, guardrails, working hours and an end date.

type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const DAYS: { value: Day; label: string }[] = [
  { value: 'mon', label: 'Mon' },
  { value: 'tue', label: 'Tue' },
  { value: 'wed', label: 'Wed' },
  { value: 'thu', label: 'Thu' },
  { value: 'fri', label: 'Fri' },
  { value: 'sat', label: 'Sat' },
  { value: 'sun', label: 'Sun' },
];

const CHANNELS: { value: 'email' | 'sms' | 'push'; label: string }[] = [
  { value: 'email', label: 'E-mail' },
  { value: 'sms', label: 'SMS' },
  { value: 'push', label: 'Push' },
];

/** Artifact types a mandate can name; empty means any type the levels allow. */
const ARTIFACT_TYPES: { value: string; label: string }[] = [
  { value: 'email_template', label: 'E-mail templates' },
  { value: 'email_block', label: 'E-mail blocks' },
  { value: 'sms_template', label: 'SMS templates' },
  { value: 'push_template', label: 'Push templates' },
  { value: 'broadcast', label: 'Broadcasts' },
  { value: 'campaign', label: 'Campaigns' },
  { value: 'form', label: 'Forms' },
  { value: 'segment', label: 'Segments' },
  { value: 'journey', label: 'Journeys' },
  { value: 'experience', label: 'Experiences' },
  { value: 'prompt', label: 'AI prompts' },
  { value: 'audience_sync', label: 'Audience syncs' },
];

const HOLD_WINDOWS: { value: string; label: string }[] = [
  { value: 'PT30M', label: '30 minutes' },
  { value: 'PT1H', label: '1 hour' },
  { value: 'PT2H', label: '2 hours' },
  { value: 'PT4H', label: '4 hours' },
  { value: 'PT12H', label: '12 hours' },
  { value: 'PT24H', label: '24 hours' },
];

const RATE_WINDOWS: { value: string; label: string }[] = [
  { value: 'P7D', label: 'the last 7 days' },
  { value: 'P14D', label: 'the last 14 days' },
  { value: 'P30D', label: 'the last 30 days' },
];

const SHORT_LEVEL = ['Observe', 'Propose', 'Veto', 'Limits', 'Loop'] as const;

export interface MandateScope {
  segments: string[];
  purposes: string[];
  topics: string[];
  channels: ('email' | 'sms' | 'push')[];
  artifactTypes: string[];
  artifacts: string[];
  brand: string | null;
}

export interface MandateContent {
  agent: string;
  purpose: string;
  goals?: { measure: string; target?: number; direction?: 'up' | 'down' }[];
  scope: MandateScope;
  levels: Record<string, number>;
  limits: {
    recipientsPerSend?: number;
    recipientGrowth?: number;
    sendsPerDay?: number;
    changesPerDay?: number;
    messagesPerDay?: number;
  };
  guardrails: {
    unsubscribeRate?: number;
    complaintRate?: number;
    bounceRate?: number;
    window: 'P7D' | 'P14D' | 'P30D';
    minSent: number;
  };
  validUntil: string;
  workingHours?: { start: string; end: string; days?: Day[] };
  blackoutDates: string[];
  holdWindow: 'PT30M' | 'PT1H' | 'PT2H' | 'PT4H' | 'PT12H' | 'PT24H';
  escalation: { userIds: string[] };
  independentCheck: boolean;
  [key: string]: unknown;
}

const EMPTY_SCOPE: MandateScope = {
  segments: [],
  purposes: [],
  topics: [],
  channels: ['email'],
  artifactTypes: [],
  artifacts: [],
  brand: null,
};
const EMPTY_LIMITS: MandateContent['limits'] = {};
const EMPTY_GUARDRAILS: MandateContent['guardrails'] = { window: 'P7D', minSent: 100 };

export const scopeOf = (content: MandateContent): MandateScope => content.scope ?? EMPTY_SCOPE;
export const limitsOf = (content: MandateContent): MandateContent['limits'] => content.limits ?? EMPTY_LIMITS;
export const guardrailsOf = (content: MandateContent): MandateContent['guardrails'] => content.guardrails ?? EMPTY_GUARDRAILS;

/** A percentage typed by a person ("0.5") as the fraction the schema stores (0.005); empty: unset. */
export function percentToFraction(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n / 100));
}

/** A stored fraction (0.005) as the percentage shown in the editor ("0.5"). */
export function fractionToPercent(fraction: number | undefined): string {
  return fraction === undefined ? '' : String(Number((fraction * 100).toFixed(4)));
}

/** The levels a new mandate starts from: propose (1), but never above a workspace ceiling. */
export function defaultLevels(autonomy: Autonomy | null): Record<string, number> {
  return Object.fromEntries(MANDATE_CLASSES.map((c) => [c, Math.min(1, levelFor(autonomy?.maxLevel ?? {}, c))]));
}

/** Toggles one id in a list, keeping the schema's order (the order people picked them). */
export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function LevelSegments({
  actionClass,
  label,
  value,
  ceiling,
  readOnly,
  onChange,
}: {
  actionClass: string;
  label: string;
  value: number;
  ceiling: number;
  readOnly: boolean;
  onChange: (level: number) => void;
}) {
  return (
    <div role="radiogroup" aria-label={`${label} level`} className="grid grid-cols-5 overflow-hidden rounded-md border border-line-strong">
      {AUTONOMY_LEVEL.map((name, level) => {
        const reason =
          level === 4
            ? 'Level 4 (run the loop) arrives in a later release.'
            : level > ceiling
              ? `Above the workspace ceiling of ${levelLabel(ceiling)} (${ceiling}).`
              : undefined;
        return (
          <label
            key={name}
            title={reason ?? `${level} · ${name}`}
            className={cx(
              'relative flex h-9 cursor-pointer items-center justify-center border-r border-line-strong px-1 text-center text-[11px] font-medium text-fg-2 transition-colors last:border-r-0 hover:bg-surface-2 has-[:checked]:bg-accent has-[:checked]:text-accent-fg has-[:disabled]:cursor-not-allowed has-[:disabled]:text-muted/60 has-[:disabled]:hover:bg-transparent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[-2px] has-[:focus-visible]:outline-accent',
            )}
          >
            <input
              type="radio"
              name={`mandate-level-${actionClass}`}
              value={level}
              checked={value === level}
              disabled={readOnly || !!reason}
              aria-label={`${label}: ${name}${reason ? ` (${reason})` : ''}`}
              onChange={() => onChange(level)}
              className="sr-only"
            />
            <span className="hidden sm:inline">{name}</span>
            <span className="sm:hidden">{SHORT_LEVEL[level]}</span>
          </label>
        );
      })}
    </div>
  );
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
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  error?: string;
  readOnly?: boolean;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow changes from outside, not every keystroke
  useEffect(() => {
    if (value === undefined ? text !== '' : Number(text) !== value) setText(value === undefined ? '' : String(value));
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
        onBlur={() => setText(value === undefined ? '' : String(value))}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (t.trim() === '') return onChange(undefined);
          const n = Number(t);
          if (Number.isFinite(n)) onChange(Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n)));
        }}
      />
    </Field>
  );
}

function PercentField({
  label,
  value,
  onChange,
  hint,
  error,
  readOnly,
}: {
  label: string;
  value: number | undefined;
  onChange: (fraction: number | undefined) => void;
  hint?: string;
  error?: string;
  readOnly?: boolean;
}) {
  const shown = fractionToPercent(value);
  const [text, setText] = useState(shown);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow changes from outside, not every keystroke
  useEffect(() => {
    if (percentToFraction(text) !== value) setText(shown);
  }, [value]);
  return (
    <Field label={label} unit="%" hint={hint} error={error}>
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        step={0.01}
        value={text}
        readOnly={readOnly}
        onBlur={() => setText(shown)}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          onChange(percentToFraction(t));
        }}
        className="pr-7"
      />
    </Field>
  );
}

function CheckList({
  legend,
  options,
  selected,
  readOnly,
  onChange,
  empty,
  error,
}: {
  legend: string;
  options: { value: string; label: string; hint?: string }[];
  selected: string[];
  readOnly: boolean;
  onChange: (next: string[]) => void;
  empty?: string;
  error?: string;
}) {
  return (
    <FieldGroup legend={legend}>
      {options.length === 0 ? (
        <p className="text-[12px] text-muted">{empty ?? 'Nothing to choose from yet.'}</p>
      ) : (
        <div className="max-h-44 overflow-y-auto rounded-md border border-line p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {options.map((o) => (
              <Checkbox
                key={o.value}
                label={o.label}
                hint={o.hint}
                checked={selected.includes(o.value)}
                disabled={readOnly}
                onChange={() => onChange(toggle(selected, o.value))}
              />
            ))}
          </div>
        </div>
      )}
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </FieldGroup>
  );
}

export function MandateEditor({
  content,
  onChange,
  readOnly,
  errors,
  warnings,
  autonomy,
}: EditorProps<MandateContent> & { autonomy?: Autonomy | null }) {
  const set = (patch: Partial<MandateContent>) => onChange({ ...content, ...patch });
  const fetchedAutonomy = useApi(() => api.call('workspace.autonomy', {}), [], { skip: autonomy !== undefined });
  const settings = autonomy !== undefined ? autonomy : (fetchedAutonomy.data ?? null);
  const agents = useApi(() => api.call('agents.list', {}), []);
  const segments = useApi(() => api.call('artifacts.list', { type: 'segment', limit: 200 }), []);
  const purposes = useApi(() => api.call('purposes.list', {}), []);
  const members = useApi(() => api.call('members.list', {}), []);

  const scope = scopeOf(content);
  const limits = limitsOf(content);
  const guardrails = guardrailsOf(content);
  const levels = content.levels ?? {};
  const workingHours = content.workingHours;
  const userIds = content.escalation?.userIds ?? [];

  const purposeOptions = (purposes.data?.purposes ?? []).map((p) => ({ value: p.key, label: `${p.name} (${p.key})` }));
  const topicOptions = (purposes.data?.purposes ?? []).flatMap((p) =>
    (p.topics ?? []).map((t) => ({ value: t.key, label: `${t.name} (${p.name})` })),
  );
  const segmentOptions = (segments.data?.artifacts ?? []).map((s) => ({
    value: s.id,
    label: s.name,
    hint: s.publishedVersion ? `Live v${s.publishedVersion}` : 'Not live yet',
  }));
  const memberOptions = (members.data?.members ?? []).map((m) => ({ value: m.userId, label: m.name || m.email || m.userId }));
  const unknownMembers = userIds.filter((id) => !memberOptions.some((m) => m.value === id));

  const setScope = (patch: Partial<MandateScope>) => set({ scope: { ...scope, ...patch } });
  const setLimit = (patch: Partial<MandateContent['limits']>) => set({ limits: { ...limits, ...patch } });
  const setGuardrail = (patch: Partial<MandateContent['guardrails']>) => set({ guardrails: { ...guardrails, ...patch } });

  const validUntil = content.validUntil?.slice(0, 10) ?? '';
  const setValidDate = (date: string) => {
    if (!date) return;
    // End of the chosen day in UTC; the publish validator checks it is in the future and within a year.
    set({ validUntil: `${date}T23:59:00.000Z` });
  };

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

      <section className="space-y-4 rounded-lg border border-line p-4" aria-label="Agent and purpose">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Agent" hint="Its API token or MCP client acts under this mandate." error={errors.agent} required>
            <Select value={content.agent ?? ''} disabled={readOnly || agents.loading} onChange={(e) => set({ agent: e.target.value })}>
              <option value="">{agents.loading ? 'Loading agents…' : 'Choose an agent…'}</option>
              {content.agent && !(agents.data?.agents ?? []).some((a) => a.id === content.agent) && (
                <option value={content.agent}>{content.agent} (not found)</option>
              )}
              {(agents.data?.agents ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.status === 'active' ? '' : ` · ${a.status}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Valid until"
            hint="The mandate stops applying after this date; renew by publishing a new version."
            error={errors.validUntil}
            required
          >
            <Input type="date" value={validUntil} readOnly={readOnly} onChange={(e) => setValidDate(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Purpose"
          hint="What the agent is for, in a sentence or two. It is shown on holds and in the independent check."
          error={errors.purpose}
          required
        >
          <Textarea
            rows={2}
            maxLength={1000}
            value={content.purpose ?? ''}
            readOnly={readOnly}
            placeholder="Send the weekly newsletter to the readers who opted in, within the limits below."
            onChange={(e) => set({ purpose: e.target.value })}
          />
        </Field>
      </section>

      <section className="space-y-3 rounded-lg border border-line p-4" aria-label="Autonomy levels">
        <div>
          <h2 className="text-[13px] font-medium text-fg">Levels</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            The highest level for each kind of action; the workspace ceiling is shown next to it. Level 4 arrives in a later release.
          </p>
        </div>
        {settings === null && fetchedAutonomy.error ? (
          <Alert tone="warn" title="Couldn't load the workspace ceilings">
            Levels above the default are disabled until they load. {fetchedAutonomy.error}
          </Alert>
        ) : null}
        {MANDATE_CLASSES.map((c) => {
          const ceiling = levelFor(settings?.maxLevel ?? {}, c);
          const label = ACTION_CLASS_LABEL[c] ?? c;
          return (
            <div key={c} className="grid gap-2 sm:grid-cols-[minmax(0,190px)_minmax(0,1fr)] sm:items-center">
              <div>
                <div className="text-[13px] text-fg">{label}</div>
                <div className="text-[11px] text-muted">
                  Ceiling: {levelLabel(ceiling)} ({ceiling})
                </div>
              </div>
              <LevelSegments
                actionClass={c}
                label={label}
                value={levels[c] ?? 1}
                ceiling={ceiling}
                readOnly={readOnly}
                onChange={(level) => set({ levels: { ...levels, [c]: level } })}
              />
              {errors[`levels.${c}`] && <p className="text-[12px] text-bad sm:col-start-2">{errors[`levels.${c}`]}</p>}
            </div>
          );
        })}
      </section>

      <section className="space-y-4 rounded-lg border border-line p-4" aria-label="Scope">
        <div>
          <h2 className="text-[13px] font-medium text-fg">Scope</h2>
          <p className="mt-0.5 text-[12px] text-muted">What the agent may touch. Empty lists mean everything the levels allow.</p>
        </div>
        <CheckList
          legend="Audiences"
          options={segmentOptions}
          selected={scope.segments}
          readOnly={readOnly}
          error={errors['scope.segments']}
          empty="No segments yet. Create a segment first; until then the agent cannot send."
          onChange={(next) => setScope({ segments: next })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <CheckList
            legend="Purposes"
            options={purposeOptions}
            selected={scope.purposes}
            readOnly={readOnly}
            error={errors['scope.purposes']}
            empty="No purposes in force."
            onChange={(next) => setScope({ purposes: next })}
          />
          <CheckList
            legend="Topics"
            options={topicOptions}
            selected={scope.topics}
            readOnly={readOnly}
            error={errors['scope.topics']}
            empty="The purposes have no topics."
            onChange={(next) => setScope({ topics: next })}
          />
        </div>
        <FieldGroup legend="Channels">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {CHANNELS.map((ch) => (
              <Checkbox
                key={ch.value}
                label={ch.label}
                checked={scope.channels.includes(ch.value)}
                disabled={readOnly}
                onChange={() => setScope({ channels: toggle(scope.channels, ch.value) })}
              />
            ))}
          </div>
          {errors['scope.channels'] && <p className="text-[12px] text-bad">{errors['scope.channels']}</p>}
        </FieldGroup>
        <CheckList
          legend="Artifact types"
          options={ARTIFACT_TYPES}
          selected={scope.artifactTypes}
          readOnly={readOnly}
          error={errors['scope.artifactTypes']}
          empty="No artifact types."
          onChange={(next) => setScope({ artifactTypes: next })}
        />
      </section>

      <section className="space-y-4 rounded-lg border border-line p-4" aria-label="Limits">
        <div>
          <h2 className="text-[13px] font-medium text-fg">Limits</h2>
          <p className="mt-0.5 text-[12px] text-muted">On top of the workspace limits. Leave a field empty for no limit of its own.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField
            label="Recipients per send"
            value={limits.recipientsPerSend}
            min={0}
            step={1}
            unit="people"
            error={errors['limits.recipientsPerSend']}
            readOnly={readOnly}
            onChange={(n) => setLimit({ recipientsPerSend: n })}
          />
          <NumberField
            label="Recipient growth"
            value={limits.recipientGrowth}
            min={1}
            max={10}
            step={0.1}
            unit="×"
            hint="A send may reach at most this many times the previous one."
            error={errors['limits.recipientGrowth']}
            readOnly={readOnly}
            onChange={(n) => setLimit({ recipientGrowth: n })}
          />
          <NumberField
            label="Sends per day"
            value={limits.sendsPerDay}
            min={0}
            step={1}
            error={errors['limits.sendsPerDay']}
            readOnly={readOnly}
            onChange={(n) => setLimit({ sendsPerDay: n })}
          />
          <NumberField
            label="Changes per day"
            value={limits.changesPerDay}
            min={0}
            step={1}
            error={errors['limits.changesPerDay']}
            readOnly={readOnly}
            onChange={(n) => setLimit({ changesPerDay: n })}
          />
          <NumberField
            label="Messages per day"
            value={limits.messagesPerDay}
            min={0}
            step={1}
            error={errors['limits.messagesPerDay']}
            readOnly={readOnly}
            onChange={(n) => setLimit({ messagesPerDay: n })}
          />
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-line p-4" aria-label="Guardrails">
        <div>
          <h2 className="text-[13px] font-medium text-fg">Guardrails</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            Rates on the agent’s own sends, as percentages. Above one, the agent stops sending and a person decides.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <PercentField
            label="Unsubscribe rate"
            value={guardrails.unsubscribeRate}
            hint="e.g. 0.5%"
            error={errors['guardrails.unsubscribeRate']}
            readOnly={readOnly}
            onChange={(n) => setGuardrail({ unsubscribeRate: n })}
          />
          <PercentField
            label="Complaint rate"
            value={guardrails.complaintRate}
            hint="e.g. 0.1%"
            error={errors['guardrails.complaintRate']}
            readOnly={readOnly}
            onChange={(n) => setGuardrail({ complaintRate: n })}
          />
          <PercentField
            label="Bounce rate"
            value={guardrails.bounceRate}
            hint="e.g. 2%"
            error={errors['guardrails.bounceRate']}
            readOnly={readOnly}
            onChange={(n) => setGuardrail({ bounceRate: n })}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Rate window" hint="The period each rate is measured over." error={errors['guardrails.window']}>
            <Select
              value={guardrails.window}
              disabled={readOnly}
              onChange={(e) => setGuardrail({ window: e.target.value as MandateContent['guardrails']['window'] })}
            >
              {RATE_WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </Select>
          </Field>
          <NumberField
            label="Minimum sent"
            value={guardrails.minSent}
            min={0}
            step={1}
            unit="people"
            hint="Rates are judged only once the agent reached this many people."
            error={errors['guardrails.minSent']}
            readOnly={readOnly}
            onChange={(n) => setGuardrail({ minSent: n ?? 0 })}
          />
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-line p-4" aria-label="When it may act">
        <div>
          <h2 className="text-[13px] font-medium text-fg">When it may act</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            Sends outside these hours, on blackout dates, or while on a hold wait for a person.
          </p>
        </div>
        <Switch
          label="Limit irreversible actions to working hours"
          checked={!!workingHours}
          disabled={readOnly}
          onChange={(on) =>
            set({
              workingHours: on
                ? { start: workingHours?.start ?? '09:00', end: workingHours?.end ?? '17:00', days: workingHours?.days }
                : undefined,
            })
          }
        />
        {workingHours && (
          <div className="space-y-3 rounded-md border border-line p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Opens" error={errors['workingHours.start']}>
                <Input
                  type="time"
                  value={workingHours.start}
                  readOnly={readOnly}
                  onChange={(e) => set({ workingHours: { ...workingHours, start: e.target.value } })}
                />
              </Field>
              <Field label="Closes" error={errors['workingHours.end']}>
                <Input
                  type="time"
                  value={workingHours.end}
                  readOnly={readOnly}
                  onChange={(e) => set({ workingHours: { ...workingHours, end: e.target.value } })}
                />
              </Field>
            </div>
            <FieldGroup legend="Days" hint="None selected means every day.">
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {DAYS.map((d) => {
                  const days = workingHours.days ?? [];
                  return (
                    <Checkbox
                      key={d.value}
                      label={d.label}
                      checked={days.includes(d.value)}
                      disabled={readOnly}
                      onChange={() =>
                        set({ workingHours: { ...workingHours, days: days.length === 0 ? [d.value] : toggle(days, d.value) } })
                      }
                    />
                  );
                })}
              </div>
            </FieldGroup>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[12px] font-medium text-fg-2">Blackout dates</p>
              <p className="text-[12px] text-muted">No sends on these dates, in the workspace time zone.</p>
            </div>
            <Button
              variant="secondary"
              icon={<Plus size={14} />}
              disabled={readOnly || (content.blackoutDates ?? []).length >= 60}
              onClick={() =>
                set({
                  blackoutDates: [...(content.blackoutDates ?? []), new Date().toISOString().slice(0, 10)],
                })
              }
            >
              Add date
            </Button>
          </div>
          {(content.blackoutDates ?? []).length === 0 ? (
            <p className="text-[12px] text-muted">None.</p>
          ) : (
            <ul className="space-y-2">
              {(content.blackoutDates ?? []).map((date, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: dates are edited in place; the date value is the content
                <li key={i} className="flex items-end gap-2">
                  <Field label={`Blackout date ${i + 1}`} className="max-w-[200px]">
                    <Input
                      type="date"
                      value={date}
                      readOnly={readOnly}
                      onChange={(e) => set({ blackoutDates: (content.blackoutDates ?? []).map((d, j) => (j === i ? e.target.value : d)) })}
                    />
                  </Field>
                  {!readOnly && (
                    <IconButton
                      label={`Remove blackout date ${i + 1}`}
                      icon={<Trash2 size={14} />}
                      size="sm"
                      variant="danger"
                      onClick={() => set({ blackoutDates: (content.blackoutDates ?? []).filter((_, j) => j !== i) })}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {errors.blackoutDates && <p className="text-[12px] text-bad">{errors.blackoutDates}</p>}
        </div>

        <Field label="Hold window" hint="How long a level-2 action waits for a veto before it runs." error={errors.holdWindow}>
          <Select
            value={content.holdWindow ?? 'PT2H'}
            disabled={readOnly}
            onChange={(e) => set({ holdWindow: e.target.value as MandateContent['holdWindow'] })}
          >
            {HOLD_WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      <section className="space-y-4 rounded-lg border border-line p-4" aria-label="Escalation and check">
        <div>
          <h2 className="text-[13px] font-medium text-fg">Escalation and check</h2>
          <p className="mt-0.5 text-[12px] text-muted">Who is told about holds, refusals and guardrail hits, beyond the sponsor.</p>
        </div>
        {members.error ? (
          <Field
            label="Escalation members"
            hint="The member list needs workspace admin. Enter user ids separated by commas; leave empty for none."
            error={errors['escalation.userIds']}
          >
            <Input
              value={userIds.join(', ')}
              readOnly={readOnly}
              placeholder="usr_…, usr_…"
              onChange={(e) =>
                set({
                  escalation: {
                    userIds: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </Field>
        ) : (
          <CheckList
            legend="Escalation members"
            options={[...memberOptions, ...unknownMembers.map((id) => ({ value: id, label: `${id} (not found)` }))]}
            selected={userIds}
            readOnly={readOnly}
            error={errors['escalation.userIds']}
            empty="No other members."
            onChange={(next) => set({ escalation: { userIds: next } })}
          />
        )}

        <Checkbox
          label="Independent check"
          hint="A second model checks the intent, the diff and this mandate before level-2+ actions."
          checked={!!content.independentCheck}
          disabled={readOnly}
          onChange={(e) => set({ independentCheck: e.target.checked })}
        />
      </section>
    </div>
  );
}
