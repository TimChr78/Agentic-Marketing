import { Ban, MoreHorizontal, Pause, Pencil, Play } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errText, type Out } from '../../app/api';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import {
  Alert,
  Button,
  Drawer,
  Field,
  fieldErrors,
  IconButton,
  Input,
  Menu,
  Modal,
  Mono,
  Select,
  Textarea,
  useConfirm,
  useToast,
} from '../../ui';
import type { Agent } from './labels';

type Member = Out<'members.list'>['members'][number];
const personName = (m: Member) => m.name || m.email || 'This person';

/**
 * The stop controls and details editor for one agent (#213): pause with a reason, resume it, edit
 * its name, description or sponsor, or revoke it for good. Admin-only; renders nothing otherwise.
 * `variant="menu"` fits a table row, `variant="buttons"` the detail header.
 */
export function AgentControls({
  agent,
  onChanged,
  variant = 'buttons',
}: {
  agent: Agent;
  onChanged: () => void;
  variant?: 'menu' | 'buttons';
}) {
  const { can } = useWorkspace();
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [pausing, setPausing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!can('workspace:admin')) return null;

  const resume = async () => {
    setBusy(true);
    try {
      await api.call('agents.resume', { id: agent.id });
      toast.success(`Resumed “${agent.name}”. It works again with the same credentials and limits.`);
      onChanged();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    const ok = await confirm({
      title: `Revoke “${agent.name}”?`,
      body: (
        <>
          Its credentials stop working at once and it cannot be resumed. Its history and the content it created stay. This cannot be undone.
        </>
      ),
      confirmLabel: 'Revoke agent',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.call('agents.revoke', { id: agent.id });
      toast.success(`Revoked “${agent.name}”. Its credentials no longer work.`);
      onChanged();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const items = [
    ...(agent.status === 'active'
      ? [{ label: 'Pause', icon: <Pause size={14} />, onSelect: () => setPausing(true) }]
      : agent.status === 'paused'
        ? [{ label: 'Resume', icon: <Play size={14} />, onSelect: () => void resume(), disabled: busy }]
        : []),
    { label: 'Edit', icon: <Pencil size={14} />, onSelect: () => setEditing(true) },
    ...(agent.status === 'revoked'
      ? []
      : ['separator' as const, { label: 'Revoke', icon: <Ban size={14} />, destructive: true, onSelect: () => void revoke() }]),
  ];

  return (
    <>
      {variant === 'menu' ? (
        <Menu
          label={`Actions for ${agent.name}`}
          items={items}
          trigger={(p) => <IconButton {...p} label={`Actions for ${agent.name}`} icon={<MoreHorizontal size={16} />} />}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {agent.status === 'active' && (
            <Button icon={<Pause size={14} />} onClick={() => setPausing(true)}>
              Pause
            </Button>
          )}
          {agent.status === 'paused' && (
            <Button variant="primary" icon={<Play size={14} />} loading={busy} onClick={() => void resume()}>
              Resume
            </Button>
          )}
          <Button icon={<Pencil size={14} />} onClick={() => setEditing(true)}>
            Edit
          </Button>
          {agent.status !== 'revoked' && (
            <Button variant="danger" icon={<Ban size={14} />} onClick={() => void revoke()}>
              Revoke
            </Button>
          )}
        </div>
      )}

      {pausing && <PauseDialog agent={agent} onClose={() => setPausing(false)} onPaused={onChanged} />}
      {editing && <EditAgentDrawer agent={agent} onClose={() => setEditing(false)} onSaved={onChanged} />}
      {confirmDialog}
    </>
  );
}

/** Pause stops every credential at its next request; the reason is shown to the agent and in the ledger. */
function PauseDialog({ agent, onClose, onPaused }: { agent: Agent; onClose: () => void; onPaused: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = reason.trim();
      await api.call('agents.pause', { id: agent.id, ...(trimmed ? { reason: trimmed } : {}) });
      toast.success(`Paused “${agent.name}”. Its credentials no longer work.`);
      onClose();
      onPaused();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Pause “${agent.name}”?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Pause agent
          </Button>
        </>
      }
    >
      <p>Every credential it holds stops at the next request, and its pending approvals cannot be approved until it is resumed.</p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Reason (optional)" hint="Shown to the agent and in its activity.">
          <Textarea
            rows={3}
            maxLength={500}
            value={reason}
            data-autofocus
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Budget review"
          />
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Name, description and sponsor. Saves only what changed. */
function EditAgentDrawer({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const members = useApi(() => api.call('members.list', {}), []);
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [sponsorId, setSponsorId] = useState(agent.sponsor.id);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setErrors({ name: 'Give the agent a name.' });
    setBusy(true);
    setError(null);
    try {
      await api.call('agents.update', {
        id: agent.id,
        ...(trimmed !== agent.name ? { name: trimmed } : {}),
        ...(description !== agent.description ? { description } : {}),
        ...(sponsorId !== agent.sponsor.id ? { sponsorUserId: sponsorId } : {}),
      });
      toast.success(`Saved “${trimmed}”.`);
      onClose();
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') setErrors(fieldErrors(e.details));
      else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const people = members.data?.members ?? [{ userId: agent.sponsor.id, name: agent.sponsor.name, role: 'viewer' } as Member];

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Edit “${agent.name}”`}
      meta={
        <>
          Agent <Mono>{agent.id}</Mono>
        </>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        className="space-y-5 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" hint="What people see in the list and in the ledger." error={errors.name} required>
          <Input
            value={name}
            maxLength={120}
            data-autofocus
            onChange={(e) => {
              setName(e.target.value);
              setErrors((x) => ({ ...x, name: '' }));
            }}
          />
        </Field>
        <Field label="Description" hint="What this agent is for. Up to 1,000 characters." error={errors.description}>
          <Textarea rows={4} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label="Sponsor"
          hint="The person accountable for this agent. The agent never has more permissions than its sponsor’s role."
          error={errors.sponsorUserId ?? members.error ?? undefined}
        >
          <Select value={sponsorId} onChange={(e) => setSponsorId(e.target.value)} disabled={members.loading}>
            {members.loading && <option value={agent.sponsor.id}>{agent.sponsor.name}</option>}
            {people.map((m) => (
              <option key={m.userId} value={m.userId}>
                {personName(m)}
              </option>
            ))}
          </Select>
        </Field>
        {error && (
          <Alert tone="bad" title="Not saved">
            {error}
          </Alert>
        )}
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}
