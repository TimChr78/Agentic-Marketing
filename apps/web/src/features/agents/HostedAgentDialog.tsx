import { HOSTED_AGENT_TEMPLATES, type HostedAgentTemplate } from '@agentic-marketing/server/src/agents/hostedTemplates';
import { Wand2 } from 'lucide-react';
import { useState } from 'react';
import { api, errText } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, Checkbox, Drawer, Field, FieldGroup, Input, Select, Switch, Textarea, useToast } from '../../ui';
import { HOSTED_SCOPES, type HostedAgentView, type HostedScope } from './labels';

// Create or edit a hosted agent (#258): the platform runs it on a schedule, under the agent's
// mandate, with budgets and a run history. The two starter templates prefill a weekly report and
// the deliverability guardian.

const isScope = (value: string): value is HostedScope => HOSTED_SCOPES.some((s) => s.key === value);

function templateState(template: HostedAgentTemplate) {
  return {
    name: template.name,
    description: template.description,
    instructions: template.instructions,
    schedule: template.schedule,
    scopes: template.scopes.filter(isScope),
    maxTokensPerRun: template.maxTokensPerRun,
    maxToolCallsPerRun: template.maxToolCallsPerRun,
  };
}

export function HostedAgentDialog({
  agent,
  onClose,
  onSaved,
}: {
  /** The hosted agent to edit; omit to create one. */
  agent?: HostedAgentView;
  onClose: () => void;
  onSaved: (agentId: string) => void;
}) {
  const toast = useToast();
  const providers = useApi(() => api.call('aiProviders.list', {}), []);
  const first = HOSTED_AGENT_TEMPLATES[0]!;
  const initial = agent
    ? {
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
        schedule: agent.schedule,
        scopes: agent.scopes.filter(isScope),
        maxTokensPerRun: agent.budgets.maxTokensPerRun,
        maxToolCallsPerRun: agent.budgets.maxToolCallsPerRun,
      }
    : templateState(first);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [schedule, setSchedule] = useState(initial.schedule);
  const [scopes, setScopes] = useState<HostedScope[]>(initial.scopes);
  const [maxTokensPerRun, setMaxTokens] = useState(String(initial.maxTokensPerRun));
  const [maxToolCallsPerRun, setMaxToolCalls] = useState(String(initial.maxToolCallsPerRun));
  const [modelProviderId, setModelProviderId] = useState(agent?.modelProviderId ?? '');
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyTemplate = (template: HostedAgentTemplate) => {
    const next = templateState(template);
    setName(next.name);
    setDescription(next.description);
    setInstructions(next.instructions);
    setSchedule(next.schedule);
    setScopes(next.scopes);
    setMaxTokens(String(next.maxTokensPerRun));
    setMaxToolCalls(String(next.maxToolCallsPerRun));
  };

  const toggleScope = (key: HostedScope, on: boolean) =>
    setScopes((current) => (on ? [...new Set([...current, key])] : current.filter((s) => s !== key)));

  const submit = async () => {
    if (!name.trim()) return setError('Give the agent a name.');
    if (!instructions.trim()) return setError('Give the agent instructions for each run.');
    if (!scopes.length) return setError('Choose at least one permission for the run.');
    setBusy(true);
    setError(null);
    try {
      if (!agent) {
        const created = await api.call('agents.createHosted', {
          name: name.trim(),
          description,
          instructions,
          schedule: schedule.trim(),
          scopes,
          maxTokensPerRun: Number(maxTokensPerRun),
          maxToolCallsPerRun: Number(maxToolCallsPerRun),
          ...(modelProviderId ? { modelProviderId } : {}),
        });
        toast.success(`Created “${created.name}”. It runs ${created.scheduleText.toLowerCase()} (${created.timeZone}).`);
        onSaved(created.agentId);
      } else {
        const updated = await api.call('agents.updateHosted', {
          agentId: agent.agentId,
          name: name.trim(),
          description,
          instructions,
          schedule: schedule.trim(),
          scopes,
          maxTokensPerRun: Number(maxTokensPerRun),
          maxToolCallsPerRun: Number(maxToolCallsPerRun),
          modelProviderId: modelProviderId || null,
          enabled,
        });
        toast.success(`Saved “${updated.name}”.`);
        onSaved(updated.agentId);
      }
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const providerOptions = (providers.data?.providers ?? []).filter((p) => p.enabled);

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={agent ? `Edit hosted agent “${agent.name}”` : 'New hosted agent'}
      meta={agent ? <>Runs in {agent.timeZone}</> : <>The platform runs it on a schedule, under its mandate</>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {agent ? 'Save changes' : 'Create hosted agent'}
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
        {!agent && (
          <FieldGroup legend="Start from a template" hint="Both are ordinary hosted agents; change anything below.">
            <div className="flex flex-wrap gap-2">
              {HOSTED_AGENT_TEMPLATES.map((template) => (
                <Button key={template.key} type="button" icon={<Wand2 size={14} />} onClick={() => applyTemplate(template)}>
                  {template.name}
                </Button>
              ))}
            </div>
          </FieldGroup>
        )}

        <Field label="Name" hint="What people see in Settings → Agents." required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Description" hint="One sentence for the list.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </Field>
        <Field
          label="Schedule"
          hint="hourly, daily:07:00 or weekly:mon:07:00, in the workspace time zone. A run is one fresh session."
          required
        >
          <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} maxLength={80} placeholder="weekly:mon:07:00" />
        </Field>
        <Field label="Instructions" hint="The prompt for each run: what to look at and what to report." required>
          <Textarea rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={8000} />
        </Field>

        <FieldGroup
          legend="Permissions"
          hint="Never more than your own role. A tool outside this list is refused by the server, not by the prompt."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {HOSTED_SCOPES.map((scope) => (
              <Checkbox
                key={scope.key}
                label={scope.label}
                hint={scope.key}
                checked={scopes.includes(scope.key)}
                onChange={(e) => toggleScope(scope.key, e.target.checked)}
              />
            ))}
          </div>
        </FieldGroup>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tokens per run" hint="The run stops when the model’s usage reaches it." required>
            <Input type="number" min={100} max={1000000} value={maxTokensPerRun} onChange={(e) => setMaxTokens(e.target.value)} />
          </Field>
          <Field label="Tool calls per run" hint="A call past this budget never reaches the command layer." required>
            <Input type="number" min={1} max={100} value={maxToolCallsPerRun} onChange={(e) => setMaxToolCalls(e.target.value)} />
          </Field>
        </div>

        <Field label="Model" hint="Leave empty to use the workspace’s copilot provider.">
          <Select value={modelProviderId} onChange={(e) => setModelProviderId(e.target.value)}>
            <option value="">Copilot provider</option>
            {providerOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.models.default})
              </option>
            ))}
          </Select>
        </Field>

        {agent && (
          <Field label="Enabled" hint="Disabled agents keep their history but do not run.">
            <Switch checked={enabled} onChange={setEnabled} label={enabled ? 'Enabled' : 'Disabled'} />
          </Field>
        )}

        {error && <Alert tone="bad">{error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}
