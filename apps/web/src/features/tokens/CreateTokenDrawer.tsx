import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { api, apiForWorkspace, errText } from '../../app/api';
import type { Membership } from '../../app/session';
import { Alert, Button, Drawer, Field, Input, Select, useToast } from '../../ui';
import { ScopePicker } from './ScopePicker';
import { membershipsThatCanGrant, type Scope } from './scopes';

/**
 * Create a token in one brand (#44, #187). The brand selector lists the memberships whose role can
 * grant the chosen scopes; a token never crosses brands, so a second brand means a second token.
 */
export function CreateTokenDrawer({
  allowed,
  memberships,
  currentWorkspaceId,
  onClose,
  onCreated,
}: {
  allowed: string[];
  memberships: Membership[];
  currentWorkspaceId: string;
  onClose: () => void;
  onCreated: (c: { name: string; token: string; workspaceName: string }) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [scopes, setScopes] = useState<string[]>(['artifacts:read']);
  const [workspaceId, setWorkspaceId] = useState(currentWorkspaceId);
  const [days, setDays] = useState('90');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A token can only carry scopes its owner's role in that brand allows, so only offer brands where
  // the chosen scopes are grantable.
  const grantable = membershipsThatCanGrant(memberships, scopes);
  const chosen = grantable.find((m) => m.id === workspaceId) ?? grantable[0];
  const submit = async () => {
    if (!name.trim()) return setNameError('Name it after what uses it, e.g. “Hermes”.');
    if (!scopes.length) return setError('Choose at least one scope.');
    if (!chosen) return setError('Your role in your brands cannot grant these scopes. Choose fewer scopes or ask for a role change.');
    setBusy(true);
    setError(null);
    try {
      const target = chosen.id === currentWorkspaceId ? api : apiForWorkspace(chosen.id);
      const r = await target.call('apiTokens.create', {
        name: name.trim(),
        scopes: scopes as Scope[],
        ...(days ? { expiresInDays: Number(days) } : {}),
      });
      toast.success(`Created “${r.name}” for ${r.workspaceName}.`);
      onCreated({ name: r.name, token: r.token, workspaceName: r.workspaceName });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title="Create an API token"
      meta="For an agent, n8n or a script. It is shown once and acts in one brand."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="ml-auto" icon={<KeyRound size={14} />} loading={busy} onClick={submit}>
            Create token
          </Button>
        </>
      }
    >
      <form
        className="space-y-6 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" hint="What uses it, e.g. “Hermes” or “n8n reporting”." error={nameError} required>
          <Input
            value={name}
            data-autofocus
            maxLength={120}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            onBlur={() => !name.trim() && setNameError('Name it after what uses it, e.g. “Hermes”.')}
          />
        </Field>
        <Field
          label="Brand"
          hint="The token acts in this brand only. To let the same tool work in another brand, create a second token there."
        >
          <Select value={chosen?.id ?? ''} onChange={(e) => setWorkspaceId(e.target.value)}>
            {grantable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.role})
              </option>
            ))}
          </Select>
        </Field>
        {!grantable.length && (
          <Alert tone="bad">Your role in your brands cannot grant these scopes. Choose fewer scopes or ask for a role change.</Alert>
        )}
        <ScopePicker value={scopes} onChange={setScopes} allowed={allowed} />
        <Field label="Expires" hint="Shorter is safer; an admin can extend it later with their password.">
          <Select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In a year</option>
            <option value="">Never</option>
          </Select>
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}
