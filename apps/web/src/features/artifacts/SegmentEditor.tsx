import { List, Plus, Trash2, Users } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, errText } from '../../app/api';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { useFocusRecheck } from '../../app/useFocusRecheck';
import { Button, Field, IconButton, Input, JsonView, Select, Skeleton, Textarea } from '../../ui';
import { forgetArtifact, getArtifact, onArtifactsChanged } from '../artifactCache';
import { CopyPurposeKey } from '../audience/phase26/CopyControl';
import { containsMessage } from '../previews/conditionMessage';
import type { EditorProps } from './ArtifactDetailPage';
import { ListAudiencePanel } from './ListAudiencePanel';
import { usePickerIndex } from './pickerIndex';
import { type LiveReference, mergeObservation, mergeReferenceSnapshots, type ReferenceSnapshot } from './referenceSnapshots';

// Segment condition builder: the same tree agents read and write, edited as rows instead of JSON.
// A condition is a group ({all}/{any}) or one leaf: trait, event, message engagement, consent,
// segment or not.

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
type MessageEvent = 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained' | 'unsubscribed';
interface MessageCondition {
  message: MessageEvent;
  count?: { gte?: number; lte?: number };
  within?: string;
  channel?: 'email' | 'sms' | 'push';
  purpose?: string;
  broadcast?: string;
  journey?: string;
}
interface ConsentCondition {
  consent: string;
}
interface TopicCondition {
  topic: string;
}
interface ScoreCondition {
  score: { key: string; gte?: number; lte?: number };
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
type Condition =
  | GroupCondition
  | AnyCondition
  | NotCondition
  | TraitCondition
  | EventCondition
  | MessageCondition
  | ConsentCondition
  | TopicCondition
  | ScoreCondition
  | SegmentRefCondition;
type Mode = 'all' | 'any';
type Kind = 'trait' | 'event' | 'message' | 'consent' | 'topic' | 'score' | 'segment' | 'not' | 'group';
/** Where the counted messages came from: any send, or one broadcast or journey. */
type SendSource = 'any' | 'broadcast' | 'journey';

/**
 * A row reports what it still needs (a send picked but not chosen) so the page can refuse to save
 * or publish and show the row's message. Rows unregister on unmount.
 */
const RowProblemContext = createContext<(id: string, problem: string | null) => void>(() => {});

interface PurposeOption {
  key: string;
  name: string;
}

/** The one purposes read the dynamic editor shares across every consent condition row. */
interface PurposesRead {
  loading: boolean;
  error: string | null;
  purposes: PurposeOption[];
}

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

const MESSAGE_EVENTS: { value: MessageEvent; label: string }[] = [
  { value: 'delivered', label: 'Was delivered' },
  { value: 'opened', label: 'Opened' },
  { value: 'clicked', label: 'Clicked' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'complained', label: 'Marked as spam' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
];

export function SegmentEditor({ artifact, content, onChange, readOnly, errors, reportProblems }: EditorProps<SegmentContent>) {
  const set = (patch: Partial<SegmentContent>) => onChange({ ...content, ...patch });
  const group = useMemo(() => groupOf(content.condition), [content.condition]);
  const condition = useMemo(() => buildTopCondition(group.mode, group.rows), [group]);
  const mode = content.mode ?? 'dynamic';
  // One bounded purposes read for the whole condition tree. Static and snapshot lists have no
  // consent conditions, so they do not read purposes at all.
  const purposesRead = useApi(() => api.call('purposes.list', {}), [], { skip: mode !== 'dynamic' });
  const purposes: PurposesRead = {
    loading: purposesRead.loading,
    error: purposesRead.error,
    purposes: (purposesRead.data?.purposes ?? []).map((p) => ({ key: p.key, name: p.name })),
  };
  // Rows that still need something (a send picked but not chosen) report it here, and the page
  // refuses to save or publish while the set is not empty. The callback lives in a ref so a caller
  // passing an inline function cannot re-run the effect.
  const [rowProblems, setRowProblems] = useState<Record<string, string>>({});
  const reportRowProblem = useCallback((id: string, problem: string | null) => {
    setRowProblems((prev) => {
      if (problem === null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return prev[id] === problem ? prev : { ...prev, [id]: problem };
    });
  }, []);
  const reportProblemsRef = useRef(reportProblems);
  reportProblemsRef.current = reportProblems;
  useEffect(() => {
    reportProblemsRef.current?.([...new Set(Object.values(rowProblems))]);
  }, [rowProblems]);
  // Leaving the editor (a tab switch, a caught error) must not leave the page blocked.
  useEffect(() => () => reportProblemsRef.current?.([]), []);

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
    <RowProblemContext.Provider value={reportRowProblem}>
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
            purposes={purposes}
          />
        </section>

        <EstimatedSize condition={condition} />

        <details className="rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-fg-2 select-none">Advanced condition view</summary>
          <div className="border-t border-line p-3">
            <JsonView value={condition} maxHeight={320} />
          </div>
        </details>
      </div>
    </RowProblemContext.Provider>
  );
}

function GroupEditor({
  mode,
  rows,
  onChange,
  depth,
  readOnly,
  artifactId,
  purposes,
}: {
  mode: Mode;
  rows: Condition[];
  onChange: (mode: Mode, rows: Condition[]) => void;
  depth: number;
  readOnly: boolean;
  artifactId: string;
  purposes: PurposesRead;
}) {
  const setRow = (i: number, next: Condition) =>
    onChange(
      mode,
      rows.map((r, idx) => (idx === i ? next : r)),
    );
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
          // biome-ignore lint/suspicious/noArrayIndexKey: condition rows are plain objects with no id and their position is their identity
          <li key={i}>
            <RowEditor
              condition={row}
              onChange={(next) => setRow(i, next)}
              onRemove={() => removeRow(i)}
              index={i}
              depth={depth}
              readOnly={readOnly}
              artifactId={artifactId}
              purposes={purposes}
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
  purposes,
}: {
  condition: Condition;
  onChange: (c: Condition) => void;
  onRemove: () => void;
  index: number;
  depth: number;
  readOnly: boolean;
  artifactId: string;
  purposes: PurposesRead;
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
          <option value="message">Message engagement</option>
          <option value="consent">Allows purpose</option>
          <option value="topic">Subscribed to topic</option>
          <option value="score">Score</option>
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
      {kind === 'message' && (
        <MessageRow c={condition as MessageCondition} onChange={onChange} index={n} readOnly={readOnly} purposes={purposes} />
      )}
      {kind === 'consent' && (
        <ConsentRow c={condition as ConsentCondition} onChange={onChange} index={n} readOnly={readOnly} purposes={purposes} />
      )}
      {kind === 'topic' && <TopicRow c={condition as TopicCondition} onChange={onChange} index={n} readOnly={readOnly} />}
      {kind === 'score' && <ScoreRow c={condition as ScoreCondition} onChange={onChange} index={n} readOnly={readOnly} />}
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
            purposes={purposes}
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
          purposes={purposes}
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
  purposes,
}: {
  condition: Condition;
  onChange: (c: Condition) => void;
  groupDepth: number;
  index: number;
  readOnly: boolean;
  artifactId: string;
  purposes: PurposesRead;
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
        purposes={purposes}
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
      purposes={purposes}
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
        <Input value={c.trait} readOnly={readOnly} placeholder="loyaltyTier" onChange={(e) => onChange({ ...c, trait: e.target.value })} />
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

/**
 * Message engagement (#441): what happened to the messages the platform sent. Opens and clicks
 * live in the message log, not the customer event stream, so this row is how "opened in the last
 * 30 days" is built. The send, channel and purpose narrow it; `not` around the row is "never".
 */
function MessageRow({
  c,
  onChange,
  index,
  readOnly,
  purposes,
}: {
  c: MessageCondition;
  onChange: (c: Condition) => void;
  index: number;
  readOnly: boolean;
  purposes: PurposesRead;
}) {
  const set = (patch: Partial<MessageCondition>) => {
    const next: MessageCondition = { ...c, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
    onChange(next);
  };
  const setCount = (raw: string) => {
    if (raw.trim() === '') {
      const next: MessageCondition = { ...c };
      if (next.count) {
        const count = { ...next.count };
        delete count.gte;
        if (count.lte === undefined) delete next.count;
        else next.count = count;
      }
      onChange(next);
    } else set({ count: { ...c.count, gte: Math.max(0, Math.floor(Number(raw) || 0)) } });
  };
  // The selected send comes from the condition's own property, so a saved `broadcast` (or a cleared
  // one) is always shown as it is. A kind picked before any id exists lives here only: an empty id
  // would fail the DSL's id validation, read as "any send" anyway (empty is falsy) and let a save
  // silently drop the send the condition really has.
  const savedSource: SendSource = 'broadcast' in c ? 'broadcast' : 'journey' in c ? 'journey' : 'any';
  const [pendingSource, setPendingSource] = useState<Exclude<SendSource, 'any'> | null>(null);
  const source: SendSource = pendingSource ?? savedSource;
  // An id only ever comes from the condition: a pending kind has none until one is picked.
  const sendId = savedSource === source && savedSource !== 'any' ? (c[savedSource] ?? '') : '';
  const chooseSource = (kind: SendSource) => {
    if (kind === savedSource) {
      // Back to what the condition already says: drop the pending kind and change nothing.
      setPendingSource(null);
      return;
    }
    if (kind === 'any') {
      // "Any send" is an explicit choice, and the only one that makes the row unrestricted.
      setPendingSource(null);
      const next: MessageCondition = { ...c };
      delete next.broadcast;
      delete next.journey;
      onChange(next);
      return;
    }
    // Picking a kind of send is not a change yet: the condition keeps the send it has (if any) and
    // the row reports itself incomplete, so nothing invalid or accidentally unrestricted is saved.
    setPendingSource(kind);
  };
  const chooseSend = (id: string) => {
    if (!id) {
      setPendingSource(source === 'any' ? null : source);
      return;
    }
    const next: MessageCondition = { ...c };
    delete next.broadcast;
    delete next.journey;
    if (source === 'broadcast') next.broadcast = id;
    else if (source === 'journey') next.journey = id;
    setPendingSource(null);
    onChange(next);
  };
  const missingPurpose = c.purpose && !purposes.purposes.some((p) => p.key === c.purpose);
  // The page must refuse to save or publish until this row is finished.
  const rowId = useId();
  const reportRowProblem = useContext(RowProblemContext);
  const problem = source !== 'any' && !sendId ? `Choose a ${source} for condition ${index}.` : null;
  useEffect(() => {
    reportRowProblem(rowId, problem);
    return () => reportRowProblem(rowId, null);
  }, [rowId, problem, reportRowProblem]);

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[180px_150px_170px]">
        <Field label={`Message event, condition ${index}`} hideLabel>
          <Select
            value={c.message}
            disabled={readOnly}
            aria-label={`Message event, condition ${index}`}
            onChange={(e) => set({ message: e.target.value as MessageEvent })}
          >
            {MESSAGE_EVENTS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`At least how many messages, condition ${index}`} hideLabel unit="messages">
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
          <Select
            value={c.within ?? ''}
            disabled={readOnly}
            aria-label={`In the last, condition ${index}`}
            onChange={(e) => set({ within: e.target.value || undefined })}
          >
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
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={`Channel, condition ${index}`} hideLabel>
          <Select
            value={c.channel ?? ''}
            disabled={readOnly}
            aria-label={`Channel, condition ${index}`}
            onChange={(e) => set({ channel: (e.target.value || undefined) as MessageCondition['channel'] })}
          >
            <option value="">Any channel</option>
            <option value="email">E-mail</option>
            <option value="sms">SMS</option>
            <option value="push">Push</option>
          </Select>
        </Field>
        <Field label={`Purpose, condition ${index}`} hideLabel>
          <Select
            value={c.purpose ?? ''}
            disabled={readOnly || purposes.loading}
            aria-label={`Purpose, condition ${index}`}
            onChange={(e) => set({ purpose: e.target.value || undefined })}
          >
            <option value="">
              {purposes.loading ? 'Loading purposes…' : purposes.error ? `Couldn't load: ${purposes.error}` : 'Any purpose'}
            </option>
            {purposes.purposes.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
            {missingPurpose && c.purpose && <option value={c.purpose}>Unavailable purpose</option>}
          </Select>
          {missingPurpose && c.purpose && (
            <div className="mt-1">
              <CopyPurposeKey purposeKey={c.purpose} />
            </div>
          )}
        </Field>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={`Sent from, condition ${index}`} hideLabel>
          <Select
            value={source}
            disabled={readOnly}
            aria-label={`Sent from, condition ${index}`}
            onChange={(e) => chooseSource(e.target.value as SendSource)}
          >
            <option value="any">Any send</option>
            <option value="broadcast">From a broadcast</option>
            <option value="journey">From a journey</option>
          </Select>
        </Field>
        {source !== 'any' && <SendSourcePicker type={source} value={sendId} onPick={chooseSend} disabled={readOnly} index={index} />}
      </div>
      <p className="text-[12px] text-muted">
        Opens are counted only where the provider or the workspace tracks them, and a mailbox that pre-fetches the pixel can open a message
        before the person does: treat opens as a hint and clicks as a signal. Engagement is counted per message, so two opens of one issue
        still count once. A message-engagement rule changes who is in the segment only at the next scheduled refresh (or when someone
        refreshes the segment), not as messages arrive.
      </p>
    </div>
  );
}

/** One picker for the broadcast or journey the counted messages came from. */
function SendSourcePicker({
  type,
  value,
  onPick,
  disabled,
  index,
}: {
  type: Exclude<SendSource, 'any'>;
  value: string;
  onPick: (id: string) => void;
  disabled?: boolean;
  index: number;
}) {
  const list = usePickerIndex(type);
  const items = list.data?.artifacts ?? [];
  const known = !value || items.some((a) => a.id === value);
  const label = type === 'broadcast' ? `Broadcast, condition ${index}` : `Journey, condition ${index}`;
  return (
    <Field label={label} hideLabel error={value ? undefined : `Choose a ${type} for condition ${index}.`}>
      <Select value={value} disabled={disabled || list.loading} aria-label={label} onChange={(e) => onPick(e.target.value)}>
        <option value="">{list.loading ? `Loading ${type}s…` : list.error ? `Couldn't load: ${list.error}` : `Choose a ${type}…`}</option>
        {!known && value && <option value={value}>{value} (not found)</option>}
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

function ConsentRow({
  c,
  onChange,
  index,
  readOnly,
  purposes,
}: {
  c: ConsentCondition;
  onChange: (c: Condition) => void;
  index: number;
  readOnly: boolean;
  purposes: PurposesRead;
}) {
  const known = purposes.purposes;
  const missing = c.consent && !known.some((p) => p.key === c.consent);

  return (
    <Field label={`Purpose, condition ${index}`} hideLabel>
      <Select
        value={c.consent}
        disabled={readOnly || purposes.loading}
        aria-label={`Purpose, condition ${index}`}
        onChange={(e) => onChange({ consent: e.target.value })}
      >
        <option value="">
          {purposes.loading ? 'Loading purposes…' : purposes.error ? `Couldn't load: ${purposes.error}` : 'Choose a purpose…'}
        </option>
        {known.map((p) => (
          <option key={p.key} value={p.key}>
            {p.name}
          </option>
        ))}
        {missing && <option value={c.consent}>Unavailable purpose</option>}
      </Select>
      {missing && (
        <div className="mt-1">
          <CopyPurposeKey purposeKey={c.consent} />
        </div>
      )}
    </Field>
  );
}

function TopicRow({
  c,
  onChange,
  index,
  readOnly,
}: {
  c: TopicCondition;
  onChange: (c: Condition) => void;
  index: number;
  readOnly: boolean;
}) {
  return (
    <Field label={`Topic, condition ${index}`} hideLabel hint="The topic key the person currently subscribes to, e.g. newsletter.">
      <Input value={c.topic} readOnly={readOnly} placeholder="newsletter" onChange={(e) => onChange({ topic: e.target.value })} />
    </Field>
  );
}

function ScoreRow({
  c,
  onChange,
  index,
  readOnly,
}: {
  c: ScoreCondition;
  onChange: (c: Condition) => void;
  index: number;
  readOnly: boolean;
}) {
  const setBound = (key: 'gte' | 'lte', raw: string) => {
    const score = { ...c.score };
    if (raw.trim() === '') delete score[key];
    else {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      score[key] = Math.min(1, Math.max(0, n));
    }
    onChange({ score });
  };
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_140px]">
      <Field label={`Score key, condition ${index}`} hideLabel>
        <Input
          value={c.score.key}
          readOnly={readOnly}
          placeholder="conversion_propensity"
          onChange={(e) => onChange({ score: { ...c.score, key: e.target.value } })}
        />
      </Field>
      <Field label={`Score at least, condition ${index}`} hideLabel>
        <Input
          type="number"
          min={0}
          max={1}
          step={0.01}
          inputMode="decimal"
          value={c.score.gte ?? ''}
          readOnly={readOnly}
          onChange={(e) => setBound('gte', e.target.value)}
        />
      </Field>
      <Field label={`Score at most, condition ${index}`} hideLabel>
        <Input
          type="number"
          min={0}
          max={1}
          step={0.01}
          inputMode="decimal"
          value={c.score.lte ?? ''}
          readOnly={readOnly}
          onChange={(e) => setBound('lte', e.target.value)}
        />
      </Field>
    </div>
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
  return (
    <SegmentPicker value={c.segment} onChange={(segment) => onChange({ segment })} exclude={artifactId} disabled={readOnly} index={index} />
  );
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
  const list = usePickerIndex('segment');
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
        <option value="">{list.loading ? 'Loading segments…' : list.error ? `Couldn't load: ${list.error}` : 'Choose a segment…'}</option>
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

interface Estimate {
  /** The condition JSON this result (or request) belongs to. */
  key: string;
  /** The request that produced (or is producing) this state; a completion may only settle its own. */
  request: number;
  loading: boolean;
  count?: number;
  error?: string;
  /**
   * The published versions of the referenced segments the server resolved, and the membership stamp
   * of a referenced list (a list changes members without a new published version, #771).
   */
  resolved?: Record<string, { version: number; stamp: string | null }>;
  /** The request was abandoned by an edit or a newer request and will not be shown as current. */
  cancelled?: boolean;
}

/** Every segment id a condition references, directly or nested under not/all/any. */
export function referencedSegmentIds(condition: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'segment' && typeof value === 'string') found.add(value);
      else walk(value);
    }
  };
  walk(condition);
  return [...found].sort();
}

/** A referenced segment as the estimate recorded it: its published version, plus a list's stamp. */
/**
 * The referenced segments' current published versions, and the membership stamp of any that is a
 * static or snapshot list. A publish in another tab is not a local change, so the reads are forced
 * on the shared invalidation signal, on focus and when the tab becomes visible again: an estimate
 * must never outlive the definitions (or list membership) it was counted from.
 */
function useReferencedSegmentVersions(ids: string[]) {
  const key = [...new Set(ids)].sort().join(',');
  const [versions, setVersions] = useState<Record<string, LiveReference>>({});
  const seq = useRef(0);
  // One counter for every observation, watcher reads and estimates alike, taken when the request
  // starts: it orders an "unpublished" or failed read against an adopted estimate (round 4).
  const observations = useRef(0);
  const begin = useCallback(() => ++observations.current, []);
  const read = useCallback(async () => {
    const list = key ? key.split(',') : [];
    const n = ++seq.current;
    const observed = begin();
    const entries = await Promise.all(
      list.map(async (id) => {
        forgetArtifact(id);
        try {
          const artifact = await getArtifact(id);
          const version = artifact.publishedVersion ?? null;
          let stamp: string | null = null;
          // A list's count changes on an import or `audiences.add`, not on a publish (#771).
          // `segments.preview` reports the list's membership stamp, so read it the same way.
          const mode = (artifact.version.content as { mode?: string } | undefined)?.mode;
          if (version !== null && mode && mode !== 'dynamic') {
            const preview = await api.call('segments.preview', { artifactId: id });
            stamp = preview.segments?.find((s) => s.id === id)?.stamp ?? null;
          }
          return [id, { version, stamp }] as const;
        } catch {
          // A failed read keeps the snapshot but marks it unverified (see mergeObservation).
          return [id, undefined] as const;
        }
      }),
    );
    // Merge, never replace: an estimate may already have adopted a newer stamp than this read saw
    // (0.14.13 review round 3). References the segment no longer uses are dropped.
    if (n === seq.current) setVersions((prev) => mergeReferenceSnapshots(prev, Object.fromEntries(entries), observed));
  }, [key, begin]);

  useEffect(() => {
    void read();
  }, [read]);
  useEffect(
    () =>
      onArtifactsChanged((changed) => {
        if (changed && !(key ? key.split(',') : []).includes(changed)) return;
        void read();
      }),
    [key, read],
  );
  useFocusRecheck(() => void read());

  // A fresh estimate names the exact reference state it counted, so re-estimating with the same
  // rules after an import elsewhere must not label its own fresh count as previous (#771 review).
  //
  // It is not always newer than the live state: an estimate queued before an import can answer
  // after a focus re-check has read the newer state. Merge per reference and keep the newer of
  // (version, stamp), so a stale answer can never pull the live state backwards. The watcher's
  // sequence is left alone: a newer read still in flight must still commit.
  const adopt = useCallback((resolved: Record<string, ReferenceSnapshot> | undefined, observed: number) => {
    if (!resolved) return;
    setVersions((prev) => {
      const next = { ...prev };
      for (const [id, snapshot] of Object.entries(resolved)) next[id] = mergeObservation(prev[id], snapshot, observed);
      return next;
    });
  }, []);

  return { versions, adopt, begin };
}

function EstimatedSize({ condition }: { condition: Condition }) {
  const { can } = useSession();
  const allowed = can('profiles:read');
  const conditionKey = JSON.stringify(condition);
  // A message rule reads live engagement, but the stored membership only moves on the scheduler's
  // refresh, so the estimate and the send can disagree until then (#1078).
  const messageRule = containsMessage(condition);
  const keyRef = useRef(conditionKey);
  keyRef.current = conditionKey;
  const requestRef = useRef(0);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  // The server names the versions it counted against; read them again when the cache says an
  // artifact changed, on focus and when the tab returns, so a republished reference is noticed
  // without an edit here (#599).
  const [resolvedIds, setResolvedIds] = useState<string[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the condition is keyed by its JSON form
  const directReferences = useMemo(() => referencedSegmentIds(condition), [conditionKey]);
  // Nothing is watched before an estimate exists: there is no count to invalidate, and opening a
  // segment must not read every reference it names.
  const hasEstimate = estimate !== null;
  const watched = useMemo(
    () => (hasEstimate ? [...new Set([...directReferences, ...resolvedIds])] : []),
    [hasEstimate, directReferences, resolvedIds],
  );
  const { versions: liveVersions, adopt, begin } = useReferencedSegmentVersions(watched);
  const versionsKnown = watched.every((id) => id in liveVersions);
  const referencedChanged =
    !!estimate &&
    estimate.resolved !== undefined &&
    estimate.key === conditionKey &&
    !estimate.loading &&
    versionsKnown &&
    watched.some(
      (id) =>
        liveVersions[id]?.unverified === true ||
        (liveVersions[id]?.version ?? null) !== (estimate.resolved?.[id]?.version ?? null) ||
        (liveVersions[id]?.stamp ?? null) !== (estimate.resolved?.[id]?.stamp ?? null),
    );
  // A reference that could not be re-checked (a failed or forbidden read) makes the estimate
  // previous too, with its own explanation: it is unverified, not known to be current.
  const referenceUnverified = !!estimate && watched.some((id) => liveVersions[id]?.unverified === true);
  const current = estimate && estimate.key === conditionKey && !referencedChanged ? estimate : null;
  const previous = estimate && !current ? estimate : null;

  // Editing the rules abandons a pending estimate: it stops looking current so returning to those
  // rules can never restore a permanently loading state. The response is still ignored below.
  useEffect(() => {
    setEstimate((prev) => (prev?.loading && prev.key !== conditionKey ? { ...prev, loading: false, cancelled: true } : prev));
  }, [conditionKey]);

  const settle = (request: number) =>
    setEstimate((prev) => (prev?.loading && prev.request === request ? { ...prev, loading: false, cancelled: true } : prev));

  // A size is an explicit request, never an automatic read on every keystroke or on open. The
  // result belongs to the exact rules it was asked for: editing the rules makes it a previous
  // estimate, and a response that lands after another request is ignored.
  const estimateNow = async () => {
    if (!allowed) return;
    const key = keyRef.current;
    const request = requestRef.current + 1;
    requestRef.current = request;
    setEstimate({ key, request, loading: true });
    const observed = begin();
    try {
      const r = await api.call('segments.preview', { condition });
      if (requestRef.current !== request || keyRef.current !== key) {
        settle(request);
        return;
      }
      const resolved = r.segments
        ? Object.fromEntries(r.segments.map((s) => [s.id, { version: s.version, stamp: s.stamp ?? null }]))
        : undefined;
      if (resolved) {
        setResolvedIds(Object.keys(resolved));
        adopt(resolved, observed);
      }
      setEstimate({ key, request, loading: false, count: r.count, resolved });
    } catch (e) {
      if (requestRef.current !== request || keyRef.current !== key) {
        settle(request);
        return;
      }
      setEstimate({ key, request, loading: false, error: errText(e) });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-2 px-3.5 py-3" aria-live="polite">
      <Users size={18} className="text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-muted">Estimated size from live data</p>
        {messageRule && <p className="text-[12px] text-muted">Membership updates at the next scheduled refresh, not as messages arrive.</p>}
        {!allowed ? (
          <p className="text-[13px] text-muted">Your role can’t read profiles, so the size isn’t shown.</p>
        ) : current?.loading ? (
          <span className="flex items-center gap-2">
            <Skeleton className="mt-1 h-5 w-24" />
            <span className="sr-only">Estimating the audience size</span>
          </span>
        ) : current?.cancelled ? (
          <p className="text-[13px] text-muted">The estimate was not applied. Estimate again.</p>
        ) : current?.error ? (
          <p className="text-[13px] text-bad">{current.error} Your rules are retained.</p>
        ) : current?.count !== undefined ? (
          <p className="text-[18px] leading-6 font-semibold tabular-nums">
            {current.count.toLocaleString()} <span className="text-[13px] font-normal text-muted">people</span>
          </p>
        ) : previous ? (
          <p className="text-[13px] text-muted">
            {previous.cancelled
              ? 'The previous estimate was not applied. Estimate the current rules.'
              : previous.loading
                ? 'The previous estimate is no longer current. Estimate the current rules.'
                : previous.error
                  ? 'The previous estimate failed. Estimate the current rules.'
                  : referenceUnverified && previous.count !== undefined
                    ? `The previous estimate was ${previous.count.toLocaleString()} people. A referenced segment could not be re-checked, so it may be out of date.`
                    : referencedChanged && previous.count !== undefined
                      ? `The previous estimate was ${previous.count.toLocaleString()} people, before a referenced segment was republished.`
                      : `The last estimate was ${(previous.count ?? 0).toLocaleString()} people, for the previous rules.`}
          </p>
        ) : (
          <p className="text-[13px] text-muted">Not estimated yet. Estimate the rules currently shown.</p>
        )}
      </div>
      {allowed && (
        <Button size="sm" variant="secondary" loading={!!current?.loading} onClick={() => void estimateNow()}>
          {estimate ? 'Estimate again' : 'Estimate audience'}
        </Button>
      )}
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
  if ('message' in c) return 'message';
  if ('consent' in c) return 'consent';
  if ('topic' in c) return 'topic';
  if ('score' in c) return 'score';
  if ('segment' in c) return 'segment';
  return 'trait';
}

function blank(kind: Kind): Condition {
  switch (kind) {
    case 'event':
      return { event: '' };
    case 'message':
      return { message: 'opened' };
    case 'consent':
      return { consent: '' };
    case 'topic':
      return { topic: '' };
    case 'score':
      return { score: { key: '', gte: 0.5 } };
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
