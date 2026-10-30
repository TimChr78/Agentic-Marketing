import { KeyRound, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { useApi } from '../../app/useApi';
import {
  Alert,
  Button,
  Card,
  CodeView,
  Drawer,
  EmptyState,
  Field,
  Input,
  Menu,
  Modal,
  RadioCards,
  Select,
  Switch,
  Table,
  TableFrame,
  Tag,
  Td,
  Textarea,
  THead,
  Th,
  Tr,
  useConfirm,
  useToast,
} from '../../ui';

type Source = Out<'sources.list'>['sources'][number];

/** Event sources: a browser write key per site, or a secret server key (shown once). Admins only. */
export function SourcesCard() {
  const list = useApi(() => api.call('sources.list', {}), []);
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [editing, setEditing] = useState<Source | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);
  const sources = list.data?.sources ?? [];
  const browser = sources.find((s) => s.kind === 'browser' && s.enabled);

  const rotate = async (s: Source) => {
    const ok = await confirm({
      title: `Replace the key of “${s.name}”?`,
      body: 'The current key stops working at once; update the site or server that sends events.',
      confirmLabel: 'Replace key',
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.call('sources.rotateKey', { id: s.id });
      setSecret({ name: s.name, key: r.key });
      void list.reload();
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const remove = async (s: Source) => {
    const ok = await confirm({
      title: `Delete “${s.name}”?`,
      body: 'Events sent with its key are refused from now on. Events already collected stay.',
      confirmLabel: 'Delete source',
      destructive: true,
      typeToConfirm: s.name,
    });
    if (!ok) return;
    try {
      await api.call('sources.delete', { id: s.id });
      toast.success(`Deleted “${s.name}”.`);
      void list.reload();
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const toggle = async (s: Source) => {
    try {
      await api.call('sources.update', { id: s.id, enabled: !s.enabled });
      void list.reload();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <Card
      title="Event sources"
      description="Where events come from: your website (a public write key limited to its origins) or a server (a secret key)."
      action={
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>
          Add source
        </Button>
      }
    >
      <TableFrame
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        isEmpty={!sources.length}
        empty={
          <EmptyState
            title="No sources yet"
            action={
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>
                Add source
              </Button>
            }
          >
            Add your website to collect page views and events with the browser SDK, consent first.
          </EmptyState>
        }
      >
        <Table label="Event sources">
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Kind</Th>
              <Th className="hidden md:table-cell">Allowed sites</Th>
              <Th>Consent needed</Th>
              <Th>Enabled</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {sources.map((s) => (
              <Tr key={s.id}>
                <Td>
                  <span className="font-medium text-fg">{s.name}</span>
                  <div className="font-mono text-[11px] text-muted">{s.keyHint}</div>
                </Td>
                <Td>
                  <Tag>{s.kind === 'browser' ? 'Website' : 'Server'}</Tag>
                </Td>
                <Td className="hidden md:table-cell">{s.kind === 'browser' ? s.allowedOrigins.join(', ') || 'Any' : '—'}</Td>
                <Td>{s.requiredPurpose ? <Tag>{s.requiredPurpose}</Tag> : <span className="text-muted">None</span>}</Td>
                <Td>
                  <Switch checked={s.enabled} onChange={() => void toggle(s)} label={`${s.name} enabled`} hideLabel />
                </Td>
                <Td align="right">
                  <Menu
                    label={`More for ${s.name}`}
                    items={[
                      { label: 'Edit', onSelect: () => setEditing(s) },
                      { label: 'Replace key', icon: <RefreshCw />, onSelect: () => void rotate(s) },
                      'separator',
                      { label: 'Delete', icon: <Trash2 />, destructive: true, onSelect: () => void remove(s) },
                    ]}
                    trigger={(t) => (
                      <button
                        {...t}
                        type="button"
                        aria-label={`More actions for ${s.name}`}
                        className="inline-flex size-7 items-center justify-center rounded-md text-fg-2 hover:bg-surface-2"
                      >
                        <MoreHorizontal size={16} />
                      </button>
                    )}
                  />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
      {browser?.writeKey && (
        <div className="border-t border-line p-4">
          <CodeView
            label={`Browser SDK for “${browser.name}”`}
            value={`import { createAnalytics } from '@agentic-marketing/sdk-js';
const analytics = createAnalytics({ writeKey: '${browser.writeKey}', host: '${location.origin}' });
// From your consent banner:
analytics.setConsent({ analytics: true, marketing_email: false });
analytics.page();`}
          />
        </div>
      )}
      {editing && (
        <SourceDrawer
          source={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null);
            void list.reload();
            if (created) setSecret(created);
          }}
        />
      )}
      {secret && (
        <Modal
          open
          onClose={() => setSecret(null)}
          title={`Key for “${secret.name}”`}
          footer={
            <Button variant="primary" onClick={() => setSecret(null)}>
              I've stored it
            </Button>
          }
        >
          <p className="mb-3">Store it where the events are sent from. A server key is shown only now.</p>
          <CodeView value={secret.key} />
        </Modal>
      )}
      {confirmDialog}
    </Card>
  );
}

function SourceDrawer({
  source,
  onClose,
  onSaved,
}: {
  source: Source | null;
  onClose: () => void;
  onSaved: (created?: { name: string; key: string }) => void;
}) {
  const toast = useToast();
  const purposes = useApi(() => api.call('purposes.list', {}), []);
  const [kind, setKind] = useState<'browser' | 'server'>(source?.kind ?? 'browser');
  const [name, setName] = useState(source?.name ?? 'Website');
  const [origins, setOrigins] = useState((source?.allowedOrigins ?? [location.origin]).join('\n'));
  const [purpose, setPurpose] = useState<string>(source ? (source.requiredPurpose ?? '') : 'analytics');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    const allowedOrigins = origins
      .split(/\s+/)
      .map((o) => o.trim())
      .filter(Boolean);
    try {
      if (source) {
        await api.call('sources.update', { id: source.id, name, allowedOrigins, requiredPurpose: purpose || null });
        toast.success(`Saved “${name}”.`);
        onSaved();
      } else {
        const r = await api.call('sources.create', {
          name,
          kind,
          allowedOrigins: kind === 'browser' ? allowedOrigins : [],
          requiredPurpose: purpose || null,
        });
        toast.success(`Added “${name}”.`);
        onSaved(kind === 'server' ? { name, key: r.key } : undefined);
      }
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
      title={source ? `Edit “${source.name}”` : 'Add an event source'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="ml-auto" icon={source ? undefined : <KeyRound size={14} />} loading={busy} onClick={save}>
            {source ? 'Save changes' : 'Add source'}
          </Button>
        </>
      }
    >
      <div className="space-y-5 p-5">
        {!source && (
          <RadioCards
            name="source-kind"
            className="sm:grid-cols-2"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'browser', label: 'Website', hint: 'Public write key, only accepted from the sites you list.' },
              { value: 'server', label: 'Server', hint: 'Secret key for your backend or n8n; shown once.' },
            ]}
          />
        )}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} data-autofocus />
        </Field>
        {kind === 'browser' && (
          <Field label="Allowed sites" hint="One origin per line, e.g. https://example.com. Events from other sites are refused.">
            <Textarea rows={3} mono value={origins} onChange={(e) => setOrigins(e.target.value)} />
          </Field>
        )}
        <Field
          label="Keep events only with consent for"
          hint="Visitors who have not allowed this purpose send nothing that is kept. Websites usually use analytics."
        >
          <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="">No consent check</option>
            {purposes.data?.purposes.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} ({p.key})
              </option>
            ))}
          </Select>
        </Field>
        {kind === 'browser' && !purpose && (
          <Alert tone="warn">
            Without a consent check, website events are kept for every visitor. Most sites need consent for analytics.
          </Alert>
        )}
        {error && <Alert tone="bad">{error}</Alert>}
      </div>
    </Drawer>
  );
}
