import { ExternalLink, KeyRound, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errText, type Out } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, Card, Checkbox, CodeView, Drawer, EmptyState, Field, FieldGroup, fieldErrors, Input, LoadingBlock, Menu, Modal, Select, StatusPill, Switch, Tag, useConfirm, useToast } from '../../ui';
import { cleanValues, defaultsOf, type JsonSchema, SchemaForm } from './SchemaForm';

type List = Out<'emailProviders.list'>;
type Provider = List['providers'][number];
type Adapter = List['adapters'][number];
type Use = 'transactional' | 'marketing';

const USE_TEXT: Record<Use, { label: string; hint: string }> = {
  transactional: { label: 'Transactional', hint: 'Confirmations, receipts and other messages people expect (contract or legal purposes).' },
  marketing: { label: 'Marketing', hint: 'Newsletters, broadcasts and journeys that need consent.' },
};

export const trackingPill = (t: Adapter['tracking']) =>
  t === 'forced' ? <StatusPill tone="warn">Tracks every message</StatusPill> : t === 'configurable' ? <StatusPill tone="neutral">Tracking configurable</StatusPill> : <StatusPill tone="neutral">No provider tracking</StatusPill>;

/** E-mail providers (#40): add, edit, enable or disable, rotate the webhook URL, delete. */
export function EmailProviders() {
  const list = useApi(() => api.call('emailProviders.list', {}), []);
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const [webhook, setWebhook] = useState<{ name: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const adapters = list.data?.adapters ?? [];
  const adapterOf = (id: string) => adapters.find((a) => a.id === id);

  const toggle = async (p: Provider) => {
    setBusy(p.id);
    try {
      await api.call('emailProviders.update', { id: p.id, enabled: !p.enabled });
      toast.success(p.enabled ? `Disabled “${p.name}”. Messages for its uses wait until another provider takes them.` : `Enabled “${p.name}”.`);
      await list.reload();
    } catch (e) {
      toast.error(`Couldn't change “${p.name}”: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const rotate = async (p: Provider) => {
    const ok = await confirm({
      title: `Replace the webhook URL of “${p.name}”?`,
      body: 'The current URL stops working at once. Paste the new one into the provider’s webhook settings, or delivery and bounce events are lost until you do.',
      confirmLabel: 'Replace URL',
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.call('emailProviders.rotateWebhook', { id: p.id });
      setWebhook({ name: p.name, url: r.webhookUrl });
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const remove = async (p: Provider) => {
    const ok = await confirm({
      title: `Delete “${p.name}”?`,
      body: (
        <>
          Its credentials are deleted and it stops sending{p.useFor.length ? ` ${p.useFor.join(' and ')} e-mail` : ''}. Messages already sent keep their history.
          {p.useFor.length > 0 && ' Give its uses to another provider first, or those messages wait.'}
        </>
      ),
      confirmLabel: 'Delete provider',
      destructive: true,
      typeToConfirm: p.name,
    });
    if (!ok) return;
    try {
      await api.call('emailProviders.delete', { id: p.id });
      toast.success(`Deleted “${p.name}”.`);
      await list.reload();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <Card
      title="E-mail"
      description="Who delivers your e-mail. Each use (transactional, marketing) goes through one provider."
      action={
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')} disabled={!adapters.length}>
          Add provider
        </Button>
      }
    >
      {list.loading ? (
        <LoadingBlock lines={4} />
      ) : list.error ? (
        <div className="p-4">
          <Alert tone="bad" title="Couldn't load e-mail providers" onRetry={list.reload}>
            {list.error}
          </Alert>
        </div>
      ) : (
        <>
          {list.data!.warnings.map((w) => (
            <div key={w} className="border-b border-line p-4">
              <Alert tone="warn" title="Provider tracking overrides your setting">
                {w}
              </Alert>
            </div>
          ))}
          {!list.data!.providers.length ? (
            <EmptyState title="No e-mail provider yet" action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>Add provider</Button>}>
              Add one to send e-mail: Postmark, Amazon SES, Brevo, Cloudflare or any SMTP relay. Until then, nothing is sent.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {list.data!.providers.map((p) => {
                const a = adapterOf(p.adapter);
                return (
                  <li key={p.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-fg">{p.name}</span>
                        <Tag>{a?.label ?? p.adapter}</Tag>
                        {p.enabled ? <StatusPill tone="good">Enabled</StatusPill> : <StatusPill>Disabled</StatusPill>}
                        {trackingPill(p.tracking)}
                      </div>
                      <p className="mt-1 text-[13px] text-fg-2">
                        From {p.fromName ? `${p.fromName} <${p.fromEmail}>` : p.fromEmail}
                        {p.replyTo && ` · replies to ${p.replyTo}`}
                      </p>
                      <p className="mt-0.5 text-[12px] text-muted">
                        {p.useFor.length ? `Sends ${p.useFor.map((u) => USE_TEXT[u].label.toLowerCase()).join(' and ')} e-mail` : 'Not used for any e-mail yet: edit it to choose what it sends'}
                        {!p.hasCredentials && p.adapter !== 'log' && ' · no credentials stored'}
                      </p>
                      {p.tracking === 'forced' && p.useFor.includes('marketing') && <p className="mt-1 text-[12px] text-warn">{p.trackingNote}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch checked={p.enabled} disabled={busy === p.id} onChange={() => void toggle(p)} label={p.enabled ? 'Enabled' : 'Disabled'} hideLabel />
                      <Button size="sm" icon={<Pencil size={13} />} onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                      <Menu
                        label={`More for ${p.name}`}
                        items={[
                          { label: 'Replace webhook URL', icon: <RefreshCw />, onSelect: () => void rotate(p) },
                          'separator',
                          { label: 'Delete', icon: <Trash2 />, destructive: true, onSelect: () => void remove(p) },
                        ]}
                        trigger={(t) => (
                          <button {...t} type="button" aria-label={`More actions for ${p.name}`} className="inline-flex size-7 items-center justify-center rounded-md text-fg-2 hover:bg-surface-2">
                            <MoreHorizontal size={16} />
                          </button>
                        )}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {editing && (
        <ProviderDrawer
          provider={editing === 'new' ? null : editing}
          adapters={adapters}
          others={list.data?.providers.filter((p) => editing === 'new' || p.id !== editing.id) ?? []}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null);
            void list.reload();
            if (created) setWebhook(created);
          }}
        />
      )}
      {webhook && (
        <Modal open onClose={() => setWebhook(null)} title={`Webhook URL for “${webhook.name}”`} footer={<Button variant="primary" onClick={() => setWebhook(null)}>I've saved it</Button>}>
          <p className="mb-3">Register this URL for delivery, bounce and complaint events in the provider's webhook settings. It is shown only now; you can replace it later.</p>
          <CodeView value={webhook.url} />
        </Modal>
      )}
      {confirmDialog}
    </Card>
  );
}

function ProviderDrawer({ provider, adapters, others, onClose, onSaved }: { provider: Provider | null; adapters: Adapter[]; others: Provider[]; onClose: () => void; onSaved: (created?: { name: string; url: string }) => void }) {
  const toast = useToast();
  const [adapterId, setAdapterId] = useState<string>(provider?.adapter ?? adapters.find((a) => a.id === 'postmark')?.id ?? adapters[0]!.id);
  const adapter = adapters.find((a) => a.id === adapterId)!;
  const [name, setName] = useState(provider?.name ?? '');
  const [fromEmail, setFromEmail] = useState(provider?.fromEmail ?? '');
  const [fromName, setFromName] = useState(provider?.fromName ?? '');
  const [replyTo, setReplyTo] = useState(provider?.replyTo ?? '');
  const [useFor, setUseFor] = useState<Use[]>(provider?.useFor ?? (others.length ? [] : ['transactional', 'marketing']));
  const [config, setConfig] = useState<Record<string, unknown>>(provider ? { ...provider.config } : defaultsOf(adapter.config as JsonSchema));
  const [secrets, setSecrets] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blurred, setBlurred] = useState<Record<string, boolean>>({});

  const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const local = {
    ...(blurred.name && !name.trim() ? { name: 'Name it so people recognise it, e.g. “Postmark (newsletter)”.' } : {}),
    ...(blurred.fromEmail && !emailOk(fromEmail) ? { fromEmail: 'Enter the sender address, e.g. news@example.com.' } : {}),
    ...(blurred.replyTo && replyTo && !emailOk(replyTo) ? { replyTo: 'Enter a valid address or leave it empty.' } : {}),
  };
  const err = (k: string) => (local as Record<string, string>)[k] ?? errors[k];
  const takes = (u: Use) => others.find((o) => o.useFor.includes(u));

  const save = async () => {
    setBlurred({ name: true, fromEmail: true, replyTo: true });
    if (!name.trim() || !emailOk(fromEmail) || (replyTo && !emailOk(replyTo))) return;
    setBusy(true);
    setError(null);
    setErrors({});
    const secretValues = cleanValues(secrets);
    try {
      if (provider) {
        await api.call('emailProviders.update', {
          id: provider.id,
          name: name.trim(),
          config: cleanValues(config),
          ...(Object.keys(secretValues).length ? { secrets: secretValues } : {}),
          fromEmail,
          fromName,
          replyTo: replyTo || null,
          useFor,
        });
        toast.success(`Saved “${name.trim()}”.`);
        onSaved();
      } else {
        const r = await api.call('emailProviders.create', { name: name.trim(), adapter: adapterId as never, config: cleanValues(config), secrets: secretValues, fromEmail, fromName, ...(replyTo ? { replyTo } : {}), useFor });
        toast.success(`Added “${r.name}”.`);
        onSaved({ name: r.name, url: r.webhookUrl });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') {
        const prefix = /^Settings/.test(e.message) ? 'config' : /^Credentials/.test(e.message) ? 'secrets' : '';
        setErrors(fieldErrors(e.details, prefix));
      }
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
      title={provider ? `Edit “${provider.name}”` : 'Add an e-mail provider'}
      meta={provider ? adapter.label : 'Credentials are encrypted and never shown again.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="ml-auto" loading={busy} onClick={save}>
            {provider ? 'Save changes' : 'Add provider'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-6 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {!provider && (
          <Field label="Provider" hint="Which service delivers the e-mail." required>
            <Select
              value={adapterId}
              data-autofocus
              onChange={(e) => {
                const next = adapters.find((a) => a.id === e.target.value)!;
                setAdapterId(next.id);
                setConfig(defaultsOf(next.config as JsonSchema));
                setSecrets({});
                setErrors({});
              }}
            >
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Alert tone={adapter.tracking === 'forced' ? 'warn' : 'info'} title={adapter.tracking === 'forced' ? `${adapter.label} tracks every message` : 'Tracking by the provider'} action={adapter.docsUrl ? <a href={adapter.docsUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-accent hover:underline">Docs <ExternalLink size={12} aria-hidden /></a> : undefined}>
          {adapter.trackingNote}
        </Alert>

        <Field label="Name" hint="For your team, e.g. “Postmark (newsletter)”." error={err('name')} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setBlurred((b) => ({ ...b, name: true }))} maxLength={120} />
        </Field>

        <FieldGroup legend="Sender">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From address" error={err('fromEmail')} hint="Must be on a domain verified with the provider." required>
              <Input type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} onBlur={() => setBlurred((b) => ({ ...b, fromEmail: true }))} autoComplete="off" />
            </Field>
            <Field label="From name" error={err('fromName')} hint="Shown in the inbox, e.g. your newsletter's name.">
              <Input value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={120} />
            </Field>
          </div>
          <Field label="Reply-to address" error={err('replyTo')} hint="Optional. Where replies go if not to the from address.">
            <Input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} onBlur={() => setBlurred((b) => ({ ...b, replyTo: true }))} autoComplete="off" />
          </Field>
        </FieldGroup>

        <FieldGroup legend="Use for" hint="Each use goes through one provider; choosing one here takes it from the other provider.">
          {(['transactional', 'marketing'] as Use[]).map((u) => {
            const other = takes(u);
            return (
              <Checkbox
                key={u}
                label={USE_TEXT[u].label}
                hint={`${USE_TEXT[u].hint}${other && useFor.includes(u) ? ` Moves it from “${other.name}”.` : other ? ` Now sent by “${other.name}”.` : ''}`}
                checked={useFor.includes(u)}
                onChange={(e) => setUseFor(e.target.checked ? [...useFor, u] : useFor.filter((x) => x !== u))}
              />
            );
          })}
          {!useFor.length && <p className="text-[12px] text-muted">Without a use, this provider sends nothing.</p>}
        </FieldGroup>

        <FieldGroup legend="Settings">
          <SchemaForm schema={adapter.config as JsonSchema} value={config} onChange={setConfig} errors={errors} prefix="config" />
        </FieldGroup>

        <FieldGroup legend={<span className="inline-flex items-center gap-1.5"><KeyRound size={13} aria-hidden /> Credentials</span>}>
          <SchemaForm
            schema={adapter.secrets as JsonSchema}
            value={secrets}
            onChange={setSecrets}
            errors={errors}
            prefix="secrets"
            secret
            keepHint={provider?.hasCredentials ? 'Leave empty to keep the stored value; filling any field replaces all credentials.' : undefined}
          />
        </FieldGroup>
        {error && <Alert tone="bad" title={provider ? 'Not saved' : 'Not added'}>{error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}
