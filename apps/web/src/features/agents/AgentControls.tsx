import { Ban, MoreHorizontal, Pause, Pencil, Play } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errText, type Out } from '../../app/api';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Button, Drawer, Field, fieldErrors, IconButton, Input, Menu, Mono, Select, Textarea, useConfirm, useToast } from '../../ui';
import type { Agent } from './labels';

type Member = Out<'members.list'>['members'][number];
const personName = (m: Member) => m.name || m.email || 'This person';

/**
 * The stop controls and details editor for one agent (#213, #509). Pause is a single click: no
 * modal, no mandatory reason, and the returned agent replaces the old state only after the server
 * confirms it. Resume, edit and revoke keep their existing semantics. Admin-only; renders nothing
 * otherwise. `variant="menu"` keeps Pause/Resume visible in a table row and puts edit/revoke in the
 * row menu, so the stop control stays one click away on every layout.
 */
export function AgentControls({
  agent,
  onUpdated,
  onChanged,
  variant = 'buttons',
}: {
  agent: Agent;
  /** The agent returned by the mutation; replaces the old row without another read. */
  onUpdated?: (agent: Agent) => void;
  /** Fallback for hosts that do not accept the returned agent. */
  onChanged?: () => void;
  variant?: 'menu' | 'buttons';
}) {
  const { can } = useWorkspace();
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [busy, setBusy] = useState<'pause' | 'resume' | 'revoke' | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  if (!can('workspace:admin')) return null;

  const applied = (updated: Agent) => {
    if (onUpdated) onUpdated(updated);
    else onChanged?.();
  };

  const pause = async () => {
    setBusy('pause');
    setPauseError(null);
    try {
      const updated = await api.call('agents.pause', { id: agent.id });
      applied(updated);
      toast.success(`Paused “${agent.name}”. Its credentials no longer work.`);
    } catch (e) {
      // Preserve the active state until the server says otherwise; the error stays beside the
      // control with a Retry rather than becoming a toast that disappears.
      setPauseError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const resume = async () => {
    setBusy('resume');
    try {
      const updated = await api.call('agents.resume', { id: agent.id });
      applied(updated);
      toast.success(`Resumed “${agent.name}”. It works again with the same credentials and limits.`);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
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
    setBusy('revoke');
    try {
      const updated = await api.call('agents.revoke', { id: agent.id });
      applied(updated);
      toast.success(`Revoked “${agent.name}”. Its credentials no longer work.`);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const stopControls = (
    <>
      {agent.status === 'active' && (
        <Button icon={<Pause size={14} />} mutation loading={busy === 'pause'} onClick={() => void pause()}>
          Pause
        </Button>
      )}
      {agent.status === 'paused' && (
        <Button variant="primary" icon={<Play size={14} />} mutation loading={busy === 'resume'} onClick={() => void resume()}>
          Resume
        </Button>
      )}
    </>
  );

  const menuItems = [
    { label: 'Edit', icon: <Pencil size={14} />, onSelect: () => setEditing(true) },
    ...(agent.status === 'revoked'
      ? []
      : [
          'separator' as const,
          { label: 'Revoke', icon: <Ban size={14} />, destructive: true, mutation: true, onSelect: () => void revoke() },
        ]),
  ];

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {stopControls}
        {variant === 'menu' ? (
          <Menu
            label={`More actions for ${agent.name}`}
            items={menuItems}
            trigger={(p) => <IconButton {...p} label={`More actions for ${agent.name}`} icon={<MoreHorizontal size={16} />} />}
          />
        ) : (
          <>
            <Button icon={<Pencil size={14} />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            {agent.status !== 'revoked' && (
              <Button variant="danger" icon={<Ban size={14} />} mutation loading={busy === 'revoke'} onClick={() => void revoke()}>
                Revoke
              </Button>
            )}
          </>
        )}
      </div>
      {pauseError && (
        <div className="max-w-[360px] rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[12px] leading-[18px] text-fg">
          <p role="alert">
            Pause failed. {agent.name} remains active. {pauseError}
          </p>
          <Button size="sm" variant="ghost" className="mt-1" mutation onClick={() => void pause()}>
            Retry
          </Button>
        </div>
      )}

      {editing && (
        <EditAgentDrawer
          agent={agent}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            applied(updated);
            setEditing(false);
          }}
        />
      )}
      {confirmDialog}
    </div>
  );
}

/** Name, description and sponsor. Saves only what changed. */
function EditAgentDrawer({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: (agent: Agent) => void }) {
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
      const updated = await api.call('agents.update', {
        id: agent.id,
        ...(trimmed !== agent.name ? { name: trimmed } : {}),
        ...(description !== agent.description ? { description } : {}),
        ...(sponsorId !== agent.sponsor.id ? { sponsorUserId: sponsorId } : {}),
      });
      toast.success(`Saved “${trimmed}”.`);
      onSaved(updated);
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
          <Button variant="primary" mutation loading={busy} onClick={() => void submit()}>
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
