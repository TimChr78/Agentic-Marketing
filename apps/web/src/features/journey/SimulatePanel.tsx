import { Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { Alert, Button, Field, Input, Select, StatusPill, Textarea } from '../../ui';
import { durationText } from '../previews/ConditionView';
import type { JNode } from './model';

type Result = Out<'journeys.simulate'>;

/**
 * Simulate (#33): walk the saved draft with made-up events and answers. Nothing is sent, no
 * action or model is called. Steps light up on the canvas.
 */
export function SimulatePanel({
  artifactId,
  version,
  nodes,
  dirty,
  onPath,
  onSelect,
}: {
  artifactId: string;
  version: number;
  nodes: JNode[];
  dirty: boolean;
  onPath: (ids: string[]) => void;
  onSelect: (id: string) => void;
}) {
  const [events, setEvents] = useState<{ event: string; after: string }[]>([]);
  const [branches, setBranches] = useState<Record<string, 'yes' | 'no'>>({});
  const [ai, setAi] = useState<Record<string, string>>({});
  const [sampleName, setSampleName] = useState('');
  const [sampleProperties, setSampleProperties] = useState('{}');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trigger = nodes.find((n) => n.kind === 'trigger');
  const entryKey = trigger?.config.entryKey as { source?: string; property?: string } | undefined;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      let sampleEvent: { name?: string; properties: Record<string, unknown> } | undefined;
      if (entryKey?.source === 'event_property') {
        try {
          sampleEvent = {
            name: sampleName || String(trigger?.config.event ?? ''),
            properties: sampleProperties.trim() ? (JSON.parse(sampleProperties) as Record<string, unknown>) : {},
          };
        } catch {
          setError('The sample event properties must be JSON.');
          return;
        }
      }
      const r = await api.call('journeys.simulate', {
        artifactId,
        version,
        events: events.filter((e) => e.event),
        branches,
        ai,
        ...(sampleEvent ? { sampleEvent } : {}),
      });
      setResult(r);
      onPath(r.steps.map((s) => s.node));
    } catch (e) {
      setError(errText(e));
      onPath([]);
    } finally {
      setBusy(false);
    }
  };
  const branchNodes = nodes.filter((n) => n.kind === 'branch');
  const aiNodes = nodes.filter((n) => n.kind === 'aiDecide');
  return (
    <div className="space-y-4 p-4">
      <p className="text-[12px] text-muted">Walks version {version} as saved. Nothing is sent; actions and AI models are not called.</p>
      {dirty && <Alert tone="info">Saving your latest changes first…</Alert>}
      <div className="space-y-2">
        <p className="text-[12px] font-medium text-fg-2">Events the person does</p>
        {events.map((e, i) => (
          <div key={i} className="flex items-end gap-2">
            <Field label="Event" className="flex-1">
              <Input
                compact
                value={e.event}
                placeholder="Email Opened"
                onChange={(x) => setEvents(events.map((y, k) => (k === i ? { ...y, event: x.target.value } : y)))}
              />
            </Field>
            <Field label="After" className="w-[96px]">
              <Select
                compact
                value={e.after}
                onChange={(x) => setEvents(events.map((y, k) => (k === i ? { ...y, after: x.target.value } : y)))}
              >
                {['PT1H', 'P1D', 'P2D', 'P3D', 'P7D', 'P14D'].map((d) => (
                  <option key={d} value={d}>
                    {durationText(d)}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Remove event"
              icon={<Trash2 size={13} />}
              onClick={() => setEvents(events.filter((_, k) => k !== i))}
            />
          </div>
        ))}
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setEvents([...events, { event: '', after: 'P1D' }])}>
          Add event
        </Button>
      </div>
      {entryKey?.source === 'event_property' && (
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-fg-2">Entry key sample</p>
          <p className="text-[12px] text-muted">
            The trigger deduplicates on “{entryKey.property}”. Try an event to see its key and whether it would be a duplicate.
          </p>
          <Field label="Event name">
            <Input
              compact
              value={sampleName}
              placeholder={String(trigger?.config.event ?? '')}
              onChange={(e) => setSampleName(e.target.value)}
            />
          </Field>
          <Field label="Properties (JSON)" hint="For example {&quot;order_id&quot;:&quot;A-1&quot;}.">
            <Textarea mono rows={2} value={sampleProperties} onChange={(e) => setSampleProperties(e.target.value)} />
          </Field>
        </div>
      )}
      {branchNodes.length > 0 && (
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-fg-2">Branch answers</p>
          {branchNodes.map((n) => (
            <Field key={n.id} label={n.label}>
              <Select
                compact
                value={branches[n.id] ?? 'no'}
                onChange={(e) => setBranches({ ...branches, [n.id]: e.target.value as 'yes' | 'no' })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </Field>
          ))}
        </div>
      )}
      {aiNodes.length > 0 && (
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-fg-2">AI decisions</p>
          {aiNodes.map((n) => (
            <Field key={n.id} label={n.label}>
              <Select
                compact
                value={ai[n.id] ?? String(n.config.fallback ?? '')}
                onChange={(e) => setAi({ ...ai, [n.id]: e.target.value })}
              >
                {((n.config.options as string[]) ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
      )}
      <Button variant="primary" icon={<Play size={14} />} loading={busy} disabled={dirty} onClick={run}>
        Run simulation
      </Button>
      {error && <Alert tone="bad">{error}</Alert>}
      {result && (
        <section aria-label="Simulation result" className="space-y-2">
          <div className="flex items-center gap-2">
            <StatusPill tone={result.outcome === 'completed' ? 'good' : result.outcome === 'waiting' ? 'warn' : 'neutral'}>
              {result.outcome === 'completed' ? 'Completed' : result.outcome === 'waiting' ? 'Still waiting' : 'Exited'}
            </StatusPill>
            {result.converted && <StatusPill tone="good">Reached the goal</StatusPill>}
          </div>
          {result.entry && (
            <Alert tone={result.entry.duplicate ? 'warn' : 'info'} title="Entry key">
              {result.entry.key
                ? `${result.entry.key} — ${result.entry.duplicate ? 'a duplicate, so it would not enter' : 'it would enter'}`
                : `Skipped: ${result.entry.note}`}
            </Alert>
          )}
          <ol className="space-y-1 border-l-2 border-line pl-3 text-[13px]">
            {result.steps.map((s, i) => (
              <li key={i}>
                <button type="button" className="text-left hover:underline" onClick={() => onSelect(s.node)}>
                  <span className="text-muted tabular-nums">{s.after === 'PT0S' ? 'At once' : durationText(s.after)}</span> ·{' '}
                  <span className="font-medium">{s.label}</span>
                </button>
                {s.detail && <p className="text-[12px] text-muted">{s.detail}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
