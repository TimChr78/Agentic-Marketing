import { useState } from 'react';
import { ExternalLink, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  CodeView,
  Drawer,
  EmptyState,
  Field,
  FieldGroup,
  Input,
  LoadingBlock,
  Menu,
  Modal,
  Select,
  StatusPill,
  Table,
  TableFrame,
  Tag,
  THead,
  Td,
  Th,
  Tr,
  fieldErrors,
  useConfirm,
  useToast,
} from '../../ui';
import { ApiError, api, errText, type Out } from '../../app/api';
import { useApi } from '../../app/useApi';
import { useWorkspace } from '../../app/session';
import { cleanValues, defaultsOf, humanize, type JsonSchema } from '../providers/SchemaForm';
import { JsonSchemaFields } from './JsonSchemaFields';

type Connection = Out<'connections.list'>['connections'][number];
type Connector = Out<'connectors.list'>['connectors'][number];
type ConnectorSettings = JsonSchema;

const OAUTH_LABEL: Record<'pending' | 'connected' | 'error', { label: string; tone: 'neutral' | 'good' | 'bad' }> = {
  pending: { label: 'Not authorized', tone: 'neutral' },
  connected: { label: 'Connected', tone: 'good' },
  error: { label: 'Authorization failed', tone: 'bad' },
};

function requiredErrors(schema: ConnectorSettings | undefined, value: Record<string, unknown>, prefix: string, skip: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (skip || !schema) return e;
  for (const key of schema.required ?? []) {
    const v = value[key];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) e[`${prefix}.${key}`] = `${humanize(key)} is required.`;
  }
  return e;
}

function validateConnection(f: { name: string; connector: string }, settings: Record<string, unknown>, secrets: Record<string, unknown>, connector: Connector | undefined, hasSecrets: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.connector) e.connector = 'Choose a connector.';
  if (!f.name.trim()) e.name = 'Give the connection a name.';
  if (!connector) return e;
  Object.assign(e, requiredErrors(connector.settings as ConnectorSettings, settings, 'settings', false));
  Object.assign(e, requiredErrors(connector.secrets as ConnectorSettings, secrets, 'secrets', hasSecrets));
  return e;
}

function ConnectionDrawer({
  connection,
  connectors,
  onClose,
  onSaved,
}: {
  connection: Connection | null;
  connectors: Connector[];
  onClose: () => void;
  onSaved: (created: { name: string; inboundPath: string } | null) => void;
}) {
  const initialConnector = connection ? connectors.find((c) => c.id === connection.connector) : connectors[0];
  const [connectorId, setConnectorId] = useState(connection?.connector ?? initialConnector?.id ?? '');
  const connector = connectors.find((c) => c.id === connectorId);
  const [name, setName] = useState(connection?.name ?? initialConnector?.label ?? '');
  const [settings, setSettings] = useState<Record<string, unknown>>(() =>
    connection ? connection.settings : ((initialConnector?.settings ? defaultsOf(initialConnector.settings as JsonSchema) : {}) as Record<string, unknown>),
  );
  const [secrets, setSecrets] = useState<Record<string, unknown>>({});
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = !!connection;
  const hasStoredSecrets = connection?.hasSecrets ?? false;

  const changeConnector = (id: string) => {
    const next = connectors.find((c) => c.id === id);
    setConnectorId(id);
    setName((cur) => (!cur.trim() || cur === connector?.label ? (next?.label ?? '') : cur));
    setSettings((next?.settings ? defaultsOf(next.settings as JsonSchema) : {}) as Record<string, unknown>);
    setSecrets({});
    setErrors({});
  };

  const save = async () => {
    const found = validateConnection({ name, connector: connectorId }, settings, secrets, connector, hasStoredSecrets);
    setErrors(found);
    setError(null);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const cleanedSecrets = cleanValues(secrets) as Record<string, unknown>;
      if (connection) {
        await api.call('connections.update', {
          id: connection.id,
          name: name.trim(),
          settings,
          ...(Object.keys(cleanedSecrets).length ? { secrets: cleanedSecrets } : {}),
          enabled,
        });
        onSaved(null);
      } else {
        const created = await api.call('connections.create', { connector: connectorId, name: name.trim(), settings, secrets: cleanedSecrets });
        onSaved(created.inboundPath ? { name: created.name, inboundPath: created.inboundPath } : null);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') {
        const raw = fieldErrors(e.details);
        const prefix = /^Secrets/.test(e.message) ? 'secrets' : /^Settings/.test(e.message) ? 'settings' : null;
        if (prefix) {
          setErrors(Object.fromEntries(Object.entries(raw).map(([key, value]) => [`${prefix}.${key}`, value])));
        } else if (Object.keys(raw).length) {
          setErrors(raw);
        } else if (/^Unknown connector/.test(e.message)) {
          setErrors({ connector: e.message });
        } else {
          setErrors({});
        }
      }
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={connection ? `Edit ${connection.name}` : 'Add connection'}
      meta={
        connection ? (
          <span className="font-mono text-[12px]">{connection.id}</span>
        ) : (
          'Connect a service so journeys can call it or receive its webhooks.'
        )
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="connection-form" loading={saving}>
            {connection ? 'Save changes' : 'Add connection'}
          </Button>
        </>
      }
    >
      <form
        id="connection-form"
        className="space-y-6 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field
          label="Connector"
          hint={connector?.description}
          error={errors.connector}
          required
        >
          <Select value={connectorId} disabled={editing} onChange={(e) => changeConnector(e.target.value)}>
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" hint="How this connection appears in journeys and deliveries." error={errors.name} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>

        {connector && (
          <>
            <FieldGroup legend="Settings">
              <JsonSchemaFields
                key={connectorId}
                schema={connector.settings as ConnectorSettings}
                value={settings}
                onChange={setSettings}
                errors={errors}
                prefix="settings"
                disabled={saving}
              />
            </FieldGroup>
            <FieldGroup
              legend="Credentials"
              hint={
                hasStoredSecrets
                  ? 'Credentials are stored. Leave every field empty to keep them; filling any field replaces all of them.'
                  : 'Stored encrypted and never shown again.'
              }
            >
              <JsonSchemaFields
                key={connectorId}
                schema={connector.secrets as ConnectorSettings}
                value={secrets}
                onChange={setSecrets}
                errors={errors}
                prefix="secrets"
                keepHint={hasStoredSecrets ? 'Stored credentials are kept while this is empty.' : undefined}
                disabled={saving}
              />
            </FieldGroup>
          </>
        )}

        {connection && (
          <Checkbox label="Enabled" hint="Disabled connections are skipped; journey steps that use them take their error edge." checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        )}

        {connector && !connection && (
          <Alert tone="info" title={connector.inbound ? 'This connector receives webhooks' : connector.auth === 'oauth2' ? 'Sign in after saving' : 'Ready to use after saving'}>
            {connector.inbound
              ? 'After you add it, copy the inbound URL and register it at the other system. The last part of the URL is a secret and is shown once.'
              : connector.auth === 'oauth2'
                ? 'Add the connection, then use Authorize in the list to sign in and allow access.'
                : 'Journey steps can use this connection right away.'}
          </Alert>
        )}

        {error && (
          <Alert tone="bad" title={connection ? 'Not saved' : 'Not added'}>
            {error}
          </Alert>
        )}
      </form>
    </Drawer>
  );
}

export function ConnectionsCard() {
  const { can } = useWorkspace();
  const admin = can('workspace:admin');
  const catalog = useApi(() => api.call('connectors.list', {}), []);
  const list = useApi(() => api.call('connections.list', {}), []);
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [editing, setEditing] = useState<Connection | 'new' | null>(null);
  const [inbound, setInbound] = useState<{ name: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const connectors = catalog.data?.connectors ?? [];
  const connections = list.data?.connections ?? [];
  const connectorOf = (id: string) => connectors.find((c) => c.id === id);
  const reload = () => {
    void catalog.reload();
    void list.reload();
  };

  const authorize = async (c: Connection) => {
    setBusy(c.id);
    try {
      const { url } = await api.call('connections.authorize', { id: c.id });
      // `noopener` makes window.open return null even on success, so do not treat that as blocked.
      window.open(url, '_blank', 'noopener,noreferrer');
      toast.info(`Opened the authorization page for “${c.name}”. Finish there, then refresh this list.`);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: Connection) => {
    const ok = await confirm({
      title: `Delete “${c.name}”?`,
      body: <>The connection, its stored credentials and its inbound URL (if any) are removed. Journey steps that use it take their error edge.</>,
      confirmLabel: 'Delete connection',
      destructive: true,
      typeToConfirm: c.name,
    });
    if (!ok) return;
    setBusy(c.id);
    try {
      await api.call('connections.delete', { id: c.id });
      toast.success(`Deleted “${c.name}”.`);
      await list.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <Card
        title="Connections"
        description="Connect Slack, Shopify, Salesforce or your own HTTP API so journeys can call it or receive its webhooks."
        action={
          admin ? (
            <>
              <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={reload} loading={catalog.refreshing || list.refreshing}>
                Refresh
              </Button>
              <Button variant="primary" icon={<Plus size={16} />} disabled={!connectors.length} onClick={() => setEditing('new')}>
                Add connection
              </Button>
            </>
          ) : undefined
        }
      >
        {catalog.loading || list.loading ? (
          <LoadingBlock lines={4} />
        ) : (list.error ?? catalog.error) ? (
          <div className="p-3">
            <Alert tone="bad" title="Couldn't load connections" onRetry={reload}>
              {errText(list.error ?? catalog.error)}
            </Alert>
          </div>
        ) : connections.length === 0 ? (
          <EmptyState
            icon={<ExternalLink size={20} />}
            title="No connections yet"
            action={
              admin ? (
                <Button variant="primary" icon={<Plus size={16} />} disabled={!connectors.length} onClick={() => setEditing('new')}>
                  Add connection
                </Button>
              ) : undefined
            }
          >
            {!connectors.length
              ? 'This install offers no connectors.'
              : admin
                ? 'Add a connection to call an outside service from journeys, or to receive its webhooks. Inbound connections get a secret URL you register with the other system.'
                : 'No connections are configured. A workspace admin can add one.'}
          </EmptyState>
        ) : (
          <TableFrame columns={4}>
            <Table label="Connections">
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th className="hidden md:table-cell">Connector</Th>
                  <Th>Status</Th>
                  {admin && <Th align="right">Actions</Th>}
                </tr>
              </THead>
              <tbody>
                {connections.map((c) => {
                  const connector = connectorOf(c.connector);
                  const oauth = c.oauth ? OAUTH_LABEL[c.oauth.status] : null;
                  return (
                    <Tr key={c.id}>
                      <Td>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-fg">{c.name}</span>
                          {c.inbound && <Tag>Inbound</Tag>}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted md:hidden">{connector?.label ?? c.connector}</div>
                      </Td>
                      <Td className="hidden md:table-cell">{connector?.label ?? c.connector}</Td>
                      <Td>
                        <div className="flex flex-col items-start gap-0.5">
                          {oauth ? (
                            <StatusPill tone={oauth.tone}>{oauth.label}</StatusPill>
                          ) : (
                            <StatusPill tone={c.enabled ? 'good' : 'neutral'}>{c.enabled ? 'Enabled' : 'Disabled'}</StatusPill>
                          )}
                          {oauth && !c.enabled && <span className="text-[11px] text-muted">Disabled</span>}
                          {c.oauth?.status === 'error' && c.oauth.error && (
                            <span className="max-w-[220px] truncate text-[11px] text-bad" title={c.oauth.error}>
                              {c.oauth.error}
                            </span>
                          )}
                        </div>
                      </Td>
                      {admin && (
                        <Td align="right">
                          <div className="flex items-center justify-end gap-2">
                            {connector?.auth === 'oauth2' && (
                              <Button size="sm" icon={<ExternalLink size={14} />} loading={busy === c.id} onClick={() => void authorize(c)}>
                                {c.oauth?.status === 'connected' ? 'Reconnect' : 'Authorize'}
                              </Button>
                            )}
                            <Button size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(c)}>
                              Edit
                            </Button>
                            <Menu
                              label={`More for ${c.name}`}
                              trigger={(t) => (
                                <button
                                  {...t}
                                  type="button"
                                  aria-label={`More for ${c.name}`}
                                  className="inline-flex size-7 items-center justify-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg"
                                >
                                  <MoreHorizontal size={16} />
                                </button>
                              )}
                              items={[{ label: 'Delete', icon: <Trash2 size={14} />, destructive: true, disabled: busy === c.id, onSelect: () => void remove(c) }]}
                            />
                          </div>
                        </Td>
                      )}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableFrame>
        )}
      </Card>

      {editing && (
        <ConnectionDrawer
          key={editing === 'new' ? 'new' : editing.id}
          connection={editing === 'new' ? null : editing}
          connectors={connectors}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null);
            if (created) {
              setInbound({ name: created.name, url: `${location.origin}${created.inboundPath}` });
              toast.success(`Added “${created.name}”. Copy the inbound URL and register it at the other system.`);
            } else {
              toast.success('Connection saved.');
            }
            reload();
          }}
        />
      )}

      <Modal
        open={!!inbound}
        onClose={() => setInbound(null)}
        title={`Inbound URL for “${inbound?.name ?? ''}”`}
        footer={
          <Button variant="primary" onClick={() => setInbound(null)}>
            I've saved it
          </Button>
        }
      >
        <p className="mb-3">Register this URL at the other system. The last part is a secret; it is shown once and cannot be recovered.</p>
        <CodeView value={inbound?.url ?? ''} label="Inbound webhook URL" maxHeight={100} />
      </Modal>
      {confirmDialog}
    </div>
  );
}
