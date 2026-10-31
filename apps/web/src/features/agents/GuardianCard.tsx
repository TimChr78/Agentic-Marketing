import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { api, errText } from '../../app/api';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Button, Card, Field, formatDateTime, Modal, StatusPill, Textarea, timeAgo, useToast } from '../../ui';
import type { Agent } from './labels';

const KIND: Record<string, string> = {
  guardrail: 'Guardrail',
  anomaly: 'Anomaly',
  probing: 'Probing',
  loop: 'Loop',
  errors: 'Rising errors',
};
const ACTION: Record<string, string> = {
  cap: 'Every change waits for a person',
  hold: 'Irreversible actions are held',
  pause: 'Paused',
};

/**
 * The guardian (#253): what it did to this agent, with the evidence, and the cap still in force.
 * An admin clears it after reviewing; a paused agent is resumed separately. Hidden until it acts.
 */
export function GuardianCard({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const { can } = useWorkspace();
  const toast = useToast();
  const data = useApi(() => api.call('agents.guardian', { agentId: agent.id, limit: 20 }), [agent.id, agent.guard?.since]);
  const [clearing, setClearing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const episodes = data.data?.episodes ?? [];
  if (!agent.guard && episodes.length === 0) return null;

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call('agents.clearGuard', { agentId: agent.id, note: note.trim() });
      toast.success(`Cleared ${out.cleared} ${out.cleared === 1 ? 'episode' : 'episodes'}. The mandate applies again.`);
      setClearing(false);
      setNote('');
      onChanged();
      void data.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Guardian"
      description="The guardian watches agents with a mandate and limits them by itself when their sends or their activity look wrong."
      action={
        agent.guard && can('workspace:admin') ? (
          <Button variant="primary" onClick={() => setClearing(true)}>
            Clear
          </Button>
        ) : undefined
      }
    >
      {agent.guard && (
        <div className="p-4 pb-0">
          <Alert tone="warn" title={`Limited since ${formatDateTime(agent.guard.since)}`}>
            {agent.guard.reason}{' '}
            {agent.guard.cap <= 1
              ? 'Every change it makes waits for a person until this is cleared.'
              : 'Its sends and other irreversible actions are held for a veto window until this is cleared.'}
          </Alert>
        </div>
      )}
      {data.error && (
        <div className="p-4">
          <Alert tone="bad" onRetry={() => void data.reload()}>
            {data.error}
          </Alert>
        </div>
      )}
      <ul className="divide-y divide-line">
        {episodes.map((e) => (
          <li key={e.id} className="space-y-1 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldAlert size={14} aria-hidden />
              <span className="font-medium">{KIND[e.kind] ?? e.kind}</span>
              <StatusPill tone={e.clearedAt ? 'neutral' : e.action === 'pause' ? 'bad' : 'warn'}>
                {e.clearedAt ? 'Cleared' : (ACTION[e.action] ?? e.action)}
              </StatusPill>
              <span className="ml-auto text-[12px] text-muted" title={formatDateTime(e.at)}>
                {timeAgo(e.at)}
              </span>
            </div>
            <p className="text-[13px] text-fg-2">{e.reason}</p>
            {e.suspendedHolds > 0 && (
              <p className="text-[12px] text-muted">
                {e.suspendedHolds} held {e.suspendedHolds === 1 ? 'change' : 'changes'} now wait for a person.
              </p>
            )}
            {e.clearedAt && e.clearedNote && <p className="text-[12px] text-muted">Cleared: “{e.clearedNote}”</p>}
          </li>
        ))}
      </ul>

      {clearing && (
        <Modal
          open
          onClose={() => setClearing(false)}
          title={`Clear the guardian for “${agent.name}”?`}
          footer={
            <>
              <Button onClick={() => setClearing(false)}>Cancel</Button>
              <Button variant="primary" loading={busy} disabled={!note.trim()} onClick={() => void clear()}>
                Clear
              </Button>
            </>
          }
        >
          <p>
            Its mandate applies again from the next request. {agent.status === 'paused' ? 'It stays paused until you resume it. ' : ''}
            Held changes the guardian suspended stay with a person.
          </p>
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) void clear();
            }}
          >
            <Field label="What did you check?" hint="Kept with the episodes.">
              <Textarea rows={3} maxLength={1000} value={note} data-autofocus onChange={(e) => setNote(e.target.value)} />
            </Field>
            {error && <Alert tone="bad">{error}</Alert>}
            <button type="submit" hidden />
          </form>
        </Modal>
      )}
    </Card>
  );
}
