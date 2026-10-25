import { Copy, Trash2 } from 'lucide-react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, Field, FieldGroup, Input, Segmented, Select, Textarea } from '../../ui';
import { ArtifactSelect } from '../artifacts/ArtifactSelect';
import { JsonEditor } from '../artifacts/JsonEditor';
import { durationText } from '../previews/ConditionView';
import { edgeLabel, type JNode, KINDS, maxEdges } from './model';

const DURATIONS = ['PT30M', 'PT1H', 'PT6H', 'PT12H', 'P1D', 'P2D', 'P3D', 'P5D', 'P1W', 'P2W', 'P30D'];

function DurationSelect({ value, onChange, disabled, label, hint }: { value: unknown; onChange: (v: string) => void; disabled?: boolean; label: string; hint?: string }) {
  const v = typeof value === 'string' ? value : '';
  return (
    <Field label={label} hint={hint}>
      <Select value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {!DURATIONS.includes(v) && <option value={v}>{v ? durationText(v) : 'Choose…'}</option>}
        {DURATIONS.map((d) => (
          <option key={d} value={d}>
            {durationText(d)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * Settings of the selected step, and where it continues. The "Continues to" selects are the
 * keyboard way to connect steps (the canvas also connects by dragging).
 */
export function Inspector({
  node,
  nodes,
  warnings,
  readOnly,
  onChange,
  onConnect,
  onDelete,
  onDuplicate,
}: {
  node: JNode;
  nodes: JNode[];
  warnings: string[];
  readOnly: boolean;
  onChange: (n: JNode) => void;
  onConnect: (index: number, target: string | null) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const meta = KINDS[node.kind];
  const c = node.config as Record<string, any>;
  const setC = (p: Record<string, unknown>) => onChange({ ...node, config: Object.fromEntries(Object.entries({ ...c, ...p }).filter(([, v]) => v !== undefined)) });
  const outs = maxEdges(node);
  const targets = nodes.filter((n) => n.id !== node.id && n.kind !== 'trigger');
  const webhooks = useApi(() => api.call('webhooks.list', {}), [], { skip: node.kind !== 'webhook' });
  const connections = useApi(() => api.call('connections.list', {}), [], { skip: node.kind !== 'action' });

  return (
    <div className="space-y-5 p-4">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md" style={{ color: `var(--cat-${meta.category})`, background: `color-mix(in srgb, var(--cat-${meta.category}) 14%, transparent)` }}>
          <meta.icon size={15} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold">{meta.label}</p>
          <p className="text-[12px] text-muted">{meta.hint}</p>
        </div>
      </div>
      {warnings.length > 0 && (
        <Alert tone="warn" title="Incomplete">
          <ul className="list-disc pl-4">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Field label="Label" hint="Shown on the canvas and in reports.">
        <Input value={node.label} readOnly={readOnly} maxLength={120} onChange={(e) => onChange({ ...node, label: e.target.value })} />
      </Field>

      {node.kind === 'trigger' && (
        <FieldGroup legend="Starts when">
          <Segmented
            label="Starts when"
            value={c.segment !== undefined ? 'segment' : 'event'}
            onChange={(v) => !readOnly && setC(v === 'segment' ? { event: undefined, segment: c.segment ?? '' } : { segment: undefined, event: c.event ?? '' })}
            items={[
              { key: 'event', label: 'An event happens' },
              { key: 'segment', label: 'Joins a segment' },
            ]}
          />
          {c.segment !== undefined ? (
            <Field label="Segment">
              <ArtifactSelect type="segment" value={c.segment} disabled={readOnly} onChange={(v) => setC({ segment: v })} />
            </Field>
          ) : (
            <Field label="Event name" hint='As sent by your site or forms, e.g. "Subscription Confirmed".'>
              <Input value={c.event ?? ''} readOnly={readOnly} onChange={(e) => setC({ event: e.target.value })} />
            </Field>
          )}
          <Field label="Enter again">
            <Select value={c.reentry ?? 'once'} disabled={readOnly} onChange={(e) => setC({ reentry: e.target.value })}>
              <option value="once">Never: once per person</option>
              <option value="after_exit">After leaving the journey</option>
              <option value="always">Every time</option>
            </Select>
          </Field>
        </FieldGroup>
      )}
      {(node.kind === 'email' || node.kind === 'sms' || node.kind === 'push') && (
        <Field label="Template" hint="It must be live before the journey can be published.">
          <ArtifactSelect type={`${node.kind === 'email' ? 'email' : node.kind}_template`} value={c.template || undefined} disabled={readOnly} onChange={(v) => setC({ template: v })} />
        </Field>
      )}
      {node.kind === 'wait' && <DurationSelect label="Wait for" value={c.duration} disabled={readOnly} onChange={(v) => setC({ duration: v })} />}
      {(node.kind === 'waitEvent' || node.kind === 'goal') && (
        <>
          <Field label="Event name">
            <Input value={c.event ?? ''} readOnly={readOnly} onChange={(e) => setC({ event: e.target.value })} />
          </Field>
          {node.kind === 'waitEvent' ? (
            <DurationSelect label="Give up after" hint="Then it takes the “timeout” path." value={c.timeout} disabled={readOnly} onChange={(v) => setC({ timeout: v })} />
          ) : (
            <DurationSelect label="Counts within" value={c.within} disabled={readOnly} onChange={(v) => setC({ within: v })} />
          )}
        </>
      )}
      {node.kind === 'branch' && (
        <FieldGroup legend="Yes when the person…">
          <Segmented
            label="Yes when the person"
            value={c.segment !== undefined ? 'segment' : 'condition'}
            onChange={(v) => !readOnly && setC(v === 'segment' ? { condition: undefined, segment: c.segment ?? '' } : { segment: undefined, condition: c.condition ?? { trait: 'city', op: 'eq', value: '' } })}
            items={[
              { key: 'segment', label: 'Is in a segment' },
              { key: 'condition', label: 'Matches a condition' },
            ]}
          />
          {c.segment !== undefined ? (
            <ArtifactSelect type="segment" value={c.segment || undefined} disabled={readOnly} onChange={(v) => setC({ segment: v })} />
          ) : (
            <JsonEditor label="Condition" hint="A segment condition, e.g. {&quot;trait&quot;:&quot;city&quot;,&quot;op&quot;:&quot;eq&quot;,&quot;value&quot;:&quot;Aarhus&quot;}." value={c.condition} onChange={(v) => setC({ condition: v })} readOnly={readOnly} rows={5} />
          )}
        </FieldGroup>
      )}
      {node.kind === 'split' && (
        <FieldGroup legend="Weights" hint="One per path; people are split at random by these weights.">
          {((c.weights as number[]) ?? [50, 50]).map((w, i, all) => (
            <div key={i} className="flex items-end gap-2">
              <Field label={`Path ${String.fromCharCode(65 + i)}`} unit="%" className="flex-1">
                <Input type="number" min={0} max={100} value={w} readOnly={readOnly} className="pr-8" onChange={(e) => setC({ weights: all.map((x, k) => (k === i ? Number(e.target.value) : x)) })} />
              </Field>
              {all.length > 2 && !readOnly && <Button variant="ghost" aria-label={`Remove path ${String.fromCharCode(65 + i)}`} onClick={() => setC({ weights: all.filter((_, k) => k !== i) })} icon={<Trash2 size={14} />} />}
            </div>
          ))}
          {!readOnly && ((c.weights as number[]) ?? []).length < 5 && (
            <Button size="sm" onClick={() => setC({ weights: [...((c.weights as number[]) ?? [50, 50]), 0] })}>
              Add path
            </Button>
          )}
        </FieldGroup>
      )}
      {node.kind === 'updateProfile' && (
        <>
          <Field label="Trait" hint="Letters, digits and _.">
            <Input value={c.trait ?? ''} readOnly={readOnly} onChange={(e) => setC({ trait: e.target.value })} />
          </Field>
          <Field label="Value" hint="Text, a number, true or false.">
            <Input
              value={c.value === null || c.value === undefined ? '' : String(c.value)}
              readOnly={readOnly}
              onChange={(e) => {
                const v = e.target.value;
                setC({ value: v === 'true' ? true : v === 'false' ? false : v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v });
              }}
            />
          </Field>
        </>
      )}
      {(node.kind === 'aiDecide' || node.kind === 'aiGenerate') && (
        <>
          <Field label="Prompt" hint={node.kind === 'aiDecide' ? 'A decide prompt; its live version is used.' : 'A generate prompt; its slots fill content.* for later e-mails.'}>
            <ArtifactSelect type="prompt" value={c.prompt || undefined} disabled={readOnly} onChange={(v) => setC({ prompt: v })} />
          </Field>
          {node.kind === 'aiDecide' && (
            <>
              <Field label="Options" hint="The prompt's option keys, one per path, comma-separated.">
                <Input value={((c.options as string[]) ?? []).join(', ')} readOnly={readOnly} onChange={(e) => setC({ options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
              </Field>
              <Field label="Fallback" hint="Taken when the AI cannot decide (no consent, budget, timeout, error).">
                <Select value={c.fallback ?? ''} disabled={readOnly} onChange={(e) => setC({ fallback: e.target.value })}>
                  {((c.options as string[]) ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <DurationSelect label="Wait for the model at most" value={c.timeout ?? 'PT5M'} disabled={readOnly} onChange={(v) => setC({ timeout: v })} />
        </>
      )}
      {node.kind === 'webhook' && (
        <>
          <Field label="Endpoint" hint="Webhook endpoints are set up under Settings → Integrations.">
            <Select value={c.endpoint ?? ''} disabled={readOnly} onChange={(e) => setC({ endpoint: e.target.value })}>
              <option value="">{webhooks.loading ? 'Loading…' : 'Choose…'}</option>
              {webhooks.data?.endpoints.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.url})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payload (JSONata)" hint="Optional. Default: the profile id, non-personal traits and the trigger event.">
            <Textarea mono rows={3} value={c.data ?? ''} readOnly={readOnly} onChange={(e) => setC({ data: e.target.value || undefined })} />
          </Field>
        </>
      )}
      {node.kind === 'action' && (
        <>
          <Field label="Connection" hint="Connections are set up under Settings → Integrations.">
            <Select value={c.connection ?? ''} disabled={readOnly} onChange={(e) => setC({ connection: e.target.value })}>
              <option value="">{connections.loading ? 'Loading…' : 'Choose…'}</option>
              {connections.data?.connections.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({x.connector})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Action" hint='e.g. "postMessage" (Slack) or "request" (HTTP API).'>
            <Input value={c.action ?? ''} readOnly={readOnly} onChange={(e) => setC({ action: e.target.value })} />
          </Field>
          <JsonEditor label="Input" hint="A JSON object for the action." value={typeof c.input === 'object' ? c.input : {}} onChange={(v) => setC({ input: v })} readOnly={readOnly} rows={4} />
        </>
      )}
      {node.kind === 'transform' && (
        <>
          <Field label="Store as" hint="Becomes vars.<name> for later steps.">
            <Input value={c.set ?? ''} readOnly={readOnly} onChange={(e) => setC({ set: e.target.value })} />
          </Field>
          <Field label="Expression (JSONata)" hint="Over {profile, event, vars, content, results}.">
            <Textarea mono rows={3} value={c.expression ?? ''} readOnly={readOnly} onChange={(e) => setC({ expression: e.target.value })} />
          </Field>
        </>
      )}

      {outs > 0 && (
        <FieldGroup legend="Continues to" hint={outs > 1 ? 'Each outcome goes to one step.' : undefined}>
          {Array.from({ length: outs }, (_, i) => {
            const label = edgeLabel(node, i);
            const current = node.next?.[i]?.to ?? '';
            const disabled = readOnly || i > (node.next?.length ?? 0);
            return (
              <Field key={i} label={label ? `If ${label}` : 'Next step'} hint={i > (node.next?.length ?? 0) ? `Connect “${edgeLabel(node, i - 1) ?? 'the previous outcome'}” first.` : undefined}>
                <Select value={current} disabled={disabled} onChange={(e) => onConnect(i, e.target.value || null)}>
                  <option value="">{current ? 'Disconnect' : 'Not connected'}</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} ({KINDS[t.kind].label})
                    </option>
                  ))}
                </Select>
              </Field>
            );
          })}
        </FieldGroup>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <Button size="sm" icon={<Copy size={13} />} onClick={onDuplicate} disabled={node.kind === 'trigger'}>
            Duplicate
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={onDelete}>
            Delete step
          </Button>
        </div>
      )}
    </div>
  );
}
