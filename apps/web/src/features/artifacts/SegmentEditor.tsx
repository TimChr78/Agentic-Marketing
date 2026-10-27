import { useEffect, useMemo, useRef, useState } from 'react';
import { List, Plus, Trash2, Users } from 'lucide-react';
import { api, errText } from '../../app/api';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Button, Field, IconButton, Input, JsonView, Select, Skeleton, Textarea } from '../../ui';
import type { EditorProps } from './ArtifactDetailPage';
import { ListAudiencePanel } from './ListAudiencePanel';

// Segment condition builder: the same tree agents read and write, edited as rows instead of JSON.
// A condition is a group ({all}/{any}) or one leaf: trait, event, consent, segment or not.

type Op = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'not_exists' | 'contains';
type Scalar = string | number | boolean;
type ScalarList = (string | number)[];

interface TraitCondition {
  trait: string;
  op: Op;
  value?: Scalar | ScalarList;
}
interface EventCondition {
  event: string;
  where?: Record<string, Scalar>;
  count?: { gte?: number; lte?: number };
  within?: string;
}
interface ConsentCondition {
  consent: string;
}
interface SegmentRefCondition {
  segment: string;
}
interface NotCondition {
  not: Condition;
}
interface GroupCondition {
  all: Condition[];
}
interface AnyCondition {
  any: Condition[];
}
type Condition = GroupCondition | AnyCondition | NotCondition | TraitCondition | EventCondition | ConsentCondition | SegmentRefCondition;
type Mode = 'all' | 'any';
type Kind = 'trait' | 'event' | 'consent' | 'segment' | 'not' | 'group';

interface SegmentContent {
  description?: string;
  mode?: 'dynamic' | 'static' | 'snapshot';
  condition?: Condition;
  sourceSegment?: string;
  snapshotAt?: string;
  snapshotVersion?: number;
  [key: string]: unknown;
}

const OPERATORS: { value: Op; label: string }[] = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'in', label: 'is one of' },
  { value: 'gt', label: 'is greater than' },
  { value: 'gte', label: 'is at least' },
  { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' },
  { value: 'exists', label: 'is set' },
  { value: 'not_exists', label: 'is not set' },
  { value: 'contains', label: 'contains' },
];

const DURATIONS = [
  { value: 'P1D', label: '1 day' },
  { value: 'P7D', label: '7 days' },
  { value: 'P14D', label: '14 days' },
  { value: 'P30D', label: '30 days' },
  { value: 'P90D', label: '90 days' },
];

const NUM_RE = /^-?(?:\d+|\d*\.\d+)$/;

export function SegmentEditor({ artifact, content, onChange, readOnly, errors }: EditorProps<SegmentContent>) {
  const set = (patch: Partial<SegmentContent>) => onChange({ ...content, ...patch });
  const group = useMemo(() => groupOf(content.condition), [content.condition]);
  const condition = useMemo(() => buildTopCondition(group.mode, group.rows), [group]);
  const mode = content.mode ?? 'dynamic';

  const emit = (mode: Mode, rows: Condition[]) => set({ condition: buildTopCondition(mode, rows) });

  if (mode !== 'dynamic') {
    return (
      <div className="max-w-[900px] space-y-5">
        <Field label="Description" hint="For the team; people in the segment never see it." error={errors.description}>
          <Textarea
            rows={2}
            maxLength={1000}
            value={content.description ?? ''}
            readOnly={readOnly}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
        <div className="flex items-start gap-3 rounded-md border border-line bg-surface-2 px-3.5 py-3">
          <List size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <div>
            <p className="text-[13px] font-medium text-fg">{mode === 'snapshot' ? 'Snapshot audience' : 'Static list'}</p>
            <p className="text-[12px] text-muted">
              {mode === 'snapshot'
                ? 'A frozen copy of another segment. Its members do not follow the source until it is refreshed.'
                : 'An explicit member list. A segment refresh never changes it.'}{' '}
              Edit the list below; it is data, so it does not create an artifact version.
            </p>
          </div>
        </div>
        <ListAudiencePanel artifactId={artifact.id} content={content} />
      </div>
    );
  }

  return (
    <div className="max-w-[900px] space-y-5">
      <Field
        label="Description"
        hint="For the team; people in the segment never see it."
        error={errors.description}
      >
        <Textarea
          rows={2}
          maxLength={1000}
          value={content.description ?? ''}
          readOnly={readOnly}
          onChange={(e) => set({ description: e.target.value })}
        />
      </Field>

      <section aria-label="Condition" className="space-y-2">
        <h2 className="text-[13px] font-medium text-fg">Who is in it</h2>
        {(errors.condition ?? errors['condition.all'] ?? errors['condition.any']) && (
          <p className="text-[12px] text-bad">{errors.condition ?? errors['condition.all'] ?? errors['condition.any']}</p>
        )}
        <GroupEditor
          mode={group.mode}
          rows={group.rows}
          onChange={emit}
          depth={1}
          readOnly={readOnly}
          artifactId={artifact.id}
        />
      </section>

      <EstimatedSize condition={condition} />

      <details className="rounded-md border border-line">
        <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-fg-2 select-none">JSON</summary>
        <div className="border-t border-line p-3">
          <JsonView value={condition} maxHeight={320} />
        </div>
      </details>
    </div>
  );
}

function GroupEditor({
  mode,
  rows,
  onChange,
  depth,
  readOnly,
  artifactId,
}: {
  mode: Mode;
  rows: Condition[];
  onChange: (mode: Mode, rows: Condition[]) => void;
  depth: number;
  readOnly: boolean;
  artifactId: string;
}) {
  const setRow = (i: number, next: Condition) => onChange(mode, rows.map((r, idx) => (idx === i ? next : r)));
  const removeRow = (i: number) => onChange(mode, rows.length === 1 ? [blank('trait')] : rows.filter((_, idx) => idx !== i));
  const add = (kind: Kind) => onChange(mode, [...rows, blank(kind)]);

  return (
    <div className={depth > 1 ? 'space-y-2 rounded-md border border-line bg-surface-2 p-2.5' : 'space-y-2'}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          compact
          className="w-auto"
          aria-label={depth > 1 ? 'Match all or any of the conditions in this group' : 'Match all or any of these conditions'}
          value={mode}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value as Mode, rows)}
        >
          <option value="all">Match all of these</option>
          <option value="any">Match any of these</option>
        </Select>
      </div>

      <ol className="space-y-2">
        {rows.map((row, i) => (
          <li key={i}>
            <RowEditor
              condition={row}
              onChange={(next) => setRow(i, next)}
              onRemove={() => removeRow(i)}
              index={i}
              depth={depth}
              readOnly={readOnly}
              artifactId={artifactId}
            />
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => add('trait')} disabled={readOnly}>
          Add row
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={14} />}
          onClick={() => add('group')}
          disabled={readOnly || depth >= 3}
          title={depth >= 3 ? 'Groups can be nested three levels deep.' : undefined}
        >
          Add group
        </Button>
      </div>
    </div>
  );
}

function RowEditor({
  condition,
  onChange,
  onRemove,
  index,
  depth,
  readOnly,
  artifactId,
}: {
  condition: Condition;
  onChange: (c: Condition) => void;
  onRemove: () => void;
  index: number;
  depth: number;
  readOnly: boolean;
  artifactId: string;
}) {
  const kind = kindOf(condition);
  const n = index + 1;

  const changeKind = (next: Kind) => {
    if (next === kind) return;
    if (next === 'not') return onChange({ not: blank('trait') });
    if (next === 'group') return onChange({ all: [blank('trait')] });
    onChange(blank(next));
  };

  return (
    <div className="space-y-2 rounded-md border border-line bg-surface p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-muted">Condition {n}</span>
        <Select
          compact
          className="w-auto"
          aria-label={`Kind of condition ${n}`}
          value={kind}
          disabled={readOnly}
          onChange={(e) => changeKind(e.target.value as Kind)}
        >
          <option value="trait">Trait</option>
          <option value="event">Did event</option>
          <option value="consent">Allows purpose</option>
          <option value="segment">In segment</option>
          <option value="not">Not</option>
          <option value="group" disabled={depth >= 3}>
            Group
          </option>
        </Select>
        <div className="ml-auto">
          <IconButton
            label={`Remove condition ${n}`}
            icon={<Trash2 size={14} />}
            size="sm"
            variant="danger"
            onClick={onRemove}
            disabled={readOnly}
          />
        </div>
      </div>

      {kind === 'trait' && <TraitRow c={condition as TraitCondition} onChange={onChange} index={n} readOnly={readOnly} />}
      {kind === 'event' && <EventRow c={condition as EventCondition} onChange={onChange} index={n} readOnly={readOnly} />}
      {kind === 'consent' && (
        <ConsentRow c={condition as ConsentCondition} onChange={onChange} index={n} readOnly={readOnly} />
      )}
      {kind === 'segment' && (
        <SegmentRow c={condition as SegmentRefCondition} onChange={onChange} index={n} readOnly={readOnly} artifactId={artifactId} />
      )}
      {kind === 'not' && (
        <div className="rounded-md border border-line bg-surface-2 p-2.5">
          <p className="mb-2 text-[12px] text-muted">Does not match</p>
          <ConditionNode
            condition={(condition as NotCondition).not}
            onChange={(next) => onChange({ not: next })}
            groupDepth={depth}
            index={index}
            readOnly={readOnly}
            artifactId={artifactId}
          />
        </div>
      )}
      {kind === 'group' && (
        <GroupEditor
          mode={groupMode(condition)}
          rows={groupRows(condition)}
          onChange={(mode, rows) => onChange(buildCondition(mode, rows))}
          depth={depth + 1}
          readOnly={readOnly}
          artifactId={artifactId}
        />
      )}
    </div>
  );
}
function ConditionNode({
  condition,
  onChange,
  groupDepth,
  index,
  readOnly,
  artifactId,
}: {
  condition: Condition;
  onChange: (c: Condition) => void;
  groupDepth: number;
  index: number;
  readOnly: boolean;
  artifactId: string;
}) {
  if (isGroup(condition)) {
    return (
      <GroupEditor
        mode={groupMode(condition)}
        rows={groupRows(condition)}
        onChange={(mode, rows) => onChange(buildCondition(mode, rows))}
        depth={groupDepth + 1}
        readOnly={readOnly}
        artifactId={artifactId}
      />
    );
  }
  return (
    <RowEditor
      condition={condition}
      onChange={onChange}
      onRemove={() => onChange(blank('trait'))}
      index={index}
      depth={groupDepth}
      readOnly={readOnly}
      artifactId={artifactId}
    />
  );
}

function TraitRow({
  c,
  onChange,
  index,
  readOnly,
}: {
  c: TraitCondition;
  onChange: (c: Condition) => void;
  index: number;
  readOnly: boolean;
}) {
  const setOp = (op: Op) => {
    const next: TraitCondition = { ...c, op };
    if (op === 'exists' || op === 'not_exists') delete next.value;
    onChange(next);
  };
  const needsValue = c.op !== 'exists' && c.op !== 'not_exists';

  // Keep the raw text for comma-separated values while typing (a trailing comma is not a value yet).
  const [text, setText] = useState(() => valueText(c.value));
  const last = useRef(valueText(c.value));
  useEffect(() => {
    const next = valueText(c.value);
    if (next !== last.current) {
      setText(next);
      last.current = next;
    }
  }, [c.value]);

  const updateValue = (raw: string) => {
    setText(raw);
    const value = parseValue(raw, c.op);
    last.current = valueText(value);
    onChange({ ...c, value });
  };

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px_minmax(0,1fr)]">
      <Field label={`Trait name, condition ${index}`} hideLabel>
        <Input
          value={c.trait}
          readOnly={readOnly}
          placeholder="loyaltyTier"
          onChange={(e) => onChange({ ...c, trait: e.target.value })}
        />
      </Field>
      <Field label={`Operator, condition ${index}`} hideLabel>
        <Select value={c.op} disabled={readOnly} onChange={(e) => setOp(e.target.value as Op)}>
          {OPERATORS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      {needsValue ? (
        <Field label={`Value, condition ${index}`} hideLabel hint={c.op === 'in' ? 'Separate values with commas.' : undefined}>
          <Input
            value={text}
            readOnly={readOnly}
            placeholder={c.op === 'in' ? 'a, b, c' : 'Value'}
            onChange={(e) => updateValue(e.target.value)}
          />
        </Field>
      ) : (
        <p className="self-center text-[12px] text-muted">No value needed.</p>
      )}
    </div>
  );
}

function EventRow({
  c,
  onChange,
  index,
  readOnly,
}: {
  c: EventCondition;
  onChange: (c: Condition) => void;
  index: number;
  readOnly: boolean;
}) {
  const setCount = (raw: string) => {
    const next: EventCondition = { ...c };
    if (raw.trim() === '') {
      if (next.count) {
        const count = { ...next.count };
        delete count.gte;
        if (count.lte === undefined) delete next.count;
        else next.count = count;
      }
    } else {
      next.count = { ...next.count, gte: Math.max(0, Math.floor(Number(raw) || 0)) };
    }
    onChange(next);
  };
  const setWithin = (within: string) => {
    const next: EventCondition = { ...c };
    if (within) next.within = within;
    else delete next.within;
    onChange(next);
  };

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_180px]">
      <Field label={`Event name, condition ${index}`} hideLabel>
        <Input
          value={c.event}
          readOnly={readOnly}
          placeholder="Product Viewed"
          onChange={(e) => onChange({ ...c, event: e.target.value })}
        />
      </Field>
      <Field label={`At least how many times, condition ${index}`} hideLabel unit="times">
        <Input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={c.count?.gte ?? ''}
          readOnly={readOnly}
          onChange={(e) => setCount(e.target.value)}
        />
      </Field>
      <Field label={`In the last, condition ${index}`} hideLabel>
        <Select value={c.within ?? ''} disabled={readOnly} onChange={(e) => setWithin(e.target.value)}>
          <option value="">Any time</option>
          {DURATIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
          {c.within && !DURATIONS.some((d) => d.value === c.within) && <option value={c.within}>{c.within}</option>}
        </Select>
      </Field>
    </div>
  );
}

function ConsentRow({
  c,
  onChange,
  index,
  readOnly,
}: {
  c: ConsentCondition;
  onChange: (c: Condition) => void;
  index: number;
  readOnly: boolean;
}) {
  const purposes = useApi(() => api.call('purposes.list', {}), []);
  const known = purposes.data?.purposes ?? [];
  const missing = c.consent && !known.some((p) => p.key === c.consent);

  return (
    <Field label={`Purpose, condition ${index}`} hideLabel>
      <Select
        value={c.consent}
        disabled={readOnly || purposes.loading}
        aria-label={`Purpose, condition ${index}`}
        onChange={(e) => onChange({ consent: e.target.value })}
      >
        <option value="">{purposes.loading ? 'Loading purposes…' : purposes.error ? `Couldn't load: ${purposes.error}` : 'Choose a purpose…'}</option>
        {known.map((p) => (
          <option key={p.key} value={p.key}>
            {p.name} ({p.key})
          </option>
        ))}
        {missing && <option value={c.consent}>{c.consent} (not found)</option>}
      </Select>
    </Field>
  );
}

function SegmentRow({
  c,
  onChange,
  index,
  readOnly,
  artifactId,
}: {
  c: SegmentRefCondition;
  onChange: (c: Condition) => void;
  index: number;
  readOnly: boolean;
  artifactId: string;
}) {
  return <SegmentPicker value={c.segment} onChange={(segment) => onChange({ segment })} exclude={artifactId} disabled={readOnly} index={index} />;
}

/** A segment picker that leaves out the segment being edited, since it cannot refer to itself. */
function SegmentPicker({
  value,
  onChange,
  exclude,
  disabled,
  index,
}: {
  value?: string;
  onChange: (id: string) => void;
  exclude: string;
  disabled?: boolean;
  index: number;
}) {
  const list = useApi(() => api.call('artifacts.list', { type: 'segment' as never, limit: 200 }), []);
  const items = (list.data?.artifacts ?? []).filter((a) => a.id !== exclude);
  const known = !value || items.some((a) => a.id === value);
  return (
    <Field label={`Segment, condition ${index}`} hideLabel>
      <Select
        value={value ?? ''}
        disabled={disabled || list.loading}
        aria-label={`Segment, condition ${index}`}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{list.loading ? 'Loading…' : list.error ? `Couldn't load: ${list.error}` : 'Choose a segment…'}</option>
        {!known && value && <option value={value}>{value} (this segment or not found)</option>}
        {items.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.publishedVersion ? ` · live v${a.publishedVersion}` : ' · not live yet'}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function EstimatedSize({ condition }: { condition: Condition }) {
  const { can } = useSession();
  const allowed = can('profiles:read');
  const [size, setSize] = useState<{ loading: boolean; count?: number; error?: string }>({ loading: true });

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setSize({ loading: true });
    const timer = setTimeout(async () => {
      try {
        const r = await api.call('segments.preview', { condition });
        if (!cancelled) setSize({ loading: false, count: r.count });
      } catch (e) {
        if (!cancelled) setSize({ loading: false, error: errText(e) });
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [allowed, condition]);

  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2 px-3.5 py-3" aria-live="polite">
      <Users size={18} className="text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-muted">Estimated size now</p>
        {!allowed ? (
          <p className="text-[13px] text-muted">Your role can't read profiles, so the size isn't shown.</p>
        ) : size.loading ? (
          <Skeleton className="mt-1 h-5 w-24" />
        ) : size.error ? (
          <p className="text-[13px] text-bad">{size.error}</p>
        ) : (
          <p className="text-[18px] leading-6 font-semibold tabular-nums">
            {(size.count ?? 0).toLocaleString()} <span className="text-[13px] font-normal text-muted">people</span>
          </p>
        )}
      </div>
    </div>
  );
}

function groupOf(condition: unknown): { mode: Mode; rows: Condition[] } {
  if (isGroup(condition)) return { mode: groupMode(condition), rows: groupRows(condition) };
  if (condition && typeof condition === 'object') return { mode: 'all', rows: [condition as Condition] };
  return { mode: 'all', rows: [blank('trait')] };
}

function isGroup(c: unknown): c is GroupCondition | AnyCondition {
  return !!c && typeof c === 'object' && (Array.isArray((c as GroupCondition).all) || Array.isArray((c as AnyCondition).any));
}

function groupMode(c: Condition): Mode {
  return Array.isArray((c as AnyCondition).any) ? 'any' : 'all';
}

function groupRows(c: Condition): Condition[] {
  return Array.isArray((c as AnyCondition).any) ? (c as AnyCondition).any : (c as GroupCondition).all;
}

/** A nested group always keeps its wrapper, so the group row stays a group in the editor. */
function buildCondition(mode: Mode, rows: Condition[]): Condition {
  return mode === 'all' ? { all: rows } : { any: rows };
}

/** The top-level condition is unwrapped when it is a single row under "all". */
function buildTopCondition(mode: Mode, rows: Condition[]): Condition {
  if (rows.length === 1 && mode === 'all') return rows[0];
  return buildCondition(mode, rows);
}

function kindOf(c: Condition): Kind {
  if (isGroup(c)) return 'group';
  if ('not' in c) return 'not';
  if ('trait' in c) return 'trait';
  if ('event' in c) return 'event';
  if ('consent' in c) return 'consent';
  if ('segment' in c) return 'segment';
  return 'trait';
}

function blank(kind: Kind): Condition {
  switch (kind) {
    case 'event':
      return { event: '' };
    case 'consent':
      return { consent: '' };
    case 'segment':
      return { segment: '' };
    case 'not':
      return { not: { trait: '', op: 'eq' } };
    case 'group':
      return { all: [{ trait: '', op: 'eq' }] };
    default:
      return { trait: '', op: 'eq' };
  }
}

function parseValue(text: string, op: Op): Scalar | ScalarList | undefined {
  if (op === 'in') {
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseScalar);
  }
  if (text.trim() === '') return undefined;
  return parseScalar(text);
}

function parseScalar(text: string): string | number {
  const t = text.trim();
  return NUM_RE.test(t) ? Number(t) : t;
}

function valueText(value: TraitCondition['value']): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
