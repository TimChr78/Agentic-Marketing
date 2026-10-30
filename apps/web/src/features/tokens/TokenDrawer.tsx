import { ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errText } from '../../app/api';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import {
  Alert,
  Button,
  DateTimeInput,
  Drawer,
  Field,
  FieldGroup,
  formatDateTime,
  Input,
  LoadingBlock,
  Meta,
  Mono,
  Select,
  timeAgo,
  useConfirm,
  useToast,
} from '../../ui';
import { ScopePicker } from './ScopePicker';
import { SCOPE_TEXT, type Scope, scopeSentence } from './scopes';
import { TokenStatus, tokenStatus } from './TokenStatus';

const describeChange = (k: string, v: unknown): string => {
  const c = v as { from?: unknown; to?: unknown; name?: string; scopes?: string[] };
  if (k === 'created') return `Created with ${(c.scopes ?? []).join(', ')}`;
  if (k === 'revoked') return 'Revoked';
  if (k === 'name') return `Renamed from “${c.from}” to “${c.to}”`;
  if (k === 'scopes') {
    const from = (c.from as string[]) ?? [];
    const to = (c.to as string[]) ?? [];
    const added = to.filter((s) => !from.includes(s));
    const removed = from.filter((s) => !to.includes(s));
    return [added.length && `Added ${added.join(', ')}`, removed.length && `Removed ${removed.join(', ')}`].filter(Boolean).join('; ');
  }
  if (k === 'expiresAt')
    return `Expiry ${c.from ? formatDateTime(String(c.from)) : 'never'} → ${c.to ? formatDateTime(String(c.to)) : 'never'}`;
  return `${k} changed`;
};

/**
 * A token's detail (#44): owner, last use, history; admins edit name, scopes and expiry.
 * Narrowing applies at once; widening says in plain words what the token could then do and
 * asks for the admin's password.
 */
export function TokenDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, workspace, user } = useWorkspace();
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const t = useApi(() => api.call('apiTokens.get', { id }), [id]);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiryMode, setExpiryMode] = useState<'keep' | 'never' | 'date'>('keep');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!t.data) return;
    setName(t.data.name);
    setScopes(t.data.scopes);
    setExpiryMode('keep');
    setExpiresAt(t.data.expiresAt);
    setPassword('');
    setError(null);
  }, [t.data]);

  const tok = t.data;
  const editable = !!tok && can('workspace:admin') && !tok.revoked;
  const added = tok ? scopes.filter((s) => !tok.scopes.includes(s)) : [];
  const removed = tok ? tok.scopes.filter((s) => !scopes.includes(s)) : [];
  const newExpiry = expiryMode === 'keep' ? (tok?.expiresAt ?? null) : expiryMode === 'never' ? null : expiresAt;
  const expiryChanged =
    !!tok &&
    (tok.expiresAt ?? null) !== (newExpiry ?? null) &&
    !(tok.expiresAt && newExpiry && new Date(tok.expiresAt).getTime() === new Date(newExpiry).getTime());
  const expiryWidens =
    !!tok && expiryChanged && !!tok.expiresAt && (!newExpiry || new Date(newExpiry).getTime() > new Date(tok.expiresAt).getTime());
  const widening = added.length > 0 || expiryWidens;
  const dirty = !!tok && (name.trim() !== tok.name || added.length > 0 || removed.length > 0 || expiryChanged);
  // Owners can grant only what their role allows; the server checks the owner's role too.
  const allowed = useMemo(() => workspace.you.permissions, [workspace]);

  const save = async () => {
    if (!tok) return;
    if (!scopes.length) return setError('Keep at least one scope, or revoke the token instead.');
    if (widening && !password) return setError('Enter your password to widen this token.');
    setBusy(true);
    setError(null);
    try {
      const r = await api.call('apiTokens.update', {
        id: tok.id,
        ...(name.trim() !== tok.name ? { name: name.trim() } : {}),
        ...(added.length || removed.length ? { scopes: scopes as Scope[] } : {}),
        ...(expiryChanged ? { expiresAt: newExpiry } : {}),
        ...(widening ? { password } : {}),
      });
      toast.success(
        r.removed.length && !r.added.length
          ? `Narrowed “${r.name}”. It lost ${r.removed.join(', ')} on its next request.`
          : r.added.length
            ? `Widened “${r.name}”: it can now ${scopeSentence(r.added)}.`
            : `Saved “${r.name}”.`,
      );
      onChanged();
      await t.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!tok) return;
    const ok = await confirm({
      title: `Revoke “${tok.name}”?`,
      body: 'Anything using it (an agent, n8n, a script) stops working on its next request. This cannot be undone; create a new token if you need one again.',
      confirmLabel: 'Revoke token',
      destructive: true,
      typeToConfirm: tok.name,
    });
    if (!ok) return;
    try {
      await api.call('apiTokens.revoke', { id: tok.id });
      toast.success(`Revoked “${tok.name}”.`);
      onChanged();
      await t.reload();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const canRevoke = tok && !tok.revoked && (can('workspace:admin') || tok.userId === user.id);
  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={tok?.name ?? 'API token'}
      meta={
        tok && (
          <span className="inline-flex items-center gap-2">
            <Mono>{tok.tokenHint}</Mono> <TokenStatus t={tok} />
          </span>
        )
      }
      footer={
        tok && (
          <>
            {canRevoke && (
              <Button variant="danger" onClick={revoke}>
                Revoke
              </Button>
            )}
            {editable && (
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" disabled={!dirty} onClick={() => void t.reload()}>
                  Discard
                </Button>
                <Button variant="primary" disabled={!dirty} loading={busy} onClick={save}>
                  {widening ? 'Confirm and widen' : 'Save changes'}
                </Button>
              </div>
            )}
          </>
        )
      }
    >
      {t.loading ? (
        <LoadingBlock lines={8} />
      ) : t.error ? (
        <div className="p-5">
          <Alert tone="bad" title="Couldn't open this token" onRetry={t.reload}>
            {t.error}
          </Alert>
        </div>
      ) : tok ? (
        <div className="space-y-6 p-5">
          <Meta
            items={[
              ['Owner', `${tok.owner.name || tok.owner.email}${tok.owner.email && tok.owner.name ? ` (${tok.owner.email})` : ''}`],
              ['Status', <TokenStatus key="status" t={tok} />],
              ['Last used', tok.lastUsedAt ? `${timeAgo(tok.lastUsedAt)} · ${formatDateTime(tok.lastUsedAt)}` : 'Never'],
              ['Created', formatDateTime(tok.createdAt)],
              ['Expires', tok.expiresAt ? formatDateTime(tok.expiresAt, { zone: true }) : 'Never'],
            ]}
          />
          {tokenStatus(tok) === 'active' && !editable && (
            <Alert tone="info">
              {can('workspace:admin')
                ? 'Revoked tokens cannot be edited.'
                : 'Only a workspace admin can change a token’s name, scopes or expiry. You can revoke your own tokens.'}
            </Alert>
          )}
          <Field label="Name" hint="What uses it, e.g. “Hermes” or “n8n reporting”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} readOnly={!editable} maxLength={120} />
          </Field>
          <ScopePicker value={scopes} onChange={setScopes} allowed={editable ? allowed : []} disabled={!editable} />
          <FieldGroup legend="Expiry">
            <Field label="Expires" hideLabel>
              <Select value={expiryMode} onChange={(e) => setExpiryMode(e.target.value as typeof expiryMode)} disabled={!editable}>
                <option value="keep">{tok.expiresAt ? `Keep: ${formatDateTime(tok.expiresAt)}` : 'Keep: never'}</option>
                <option value="never">Never expires</option>
                <option value="date">On a date…</option>
              </Select>
            </Field>
            {expiryMode === 'date' && (
              <Field label="Expires at" hint="Shortening applies at once; extending needs your password.">
                <DateTimeInput value={expiresAt} onChange={setExpiresAt} disabled={!editable} />
              </Field>
            )}
          </FieldGroup>
          {editable && dirty && (
            <section aria-live="polite" className="space-y-3">
              {removed.length > 0 && (
                <Alert tone="info" title="Applies at once">
                  On its next request the token can no longer {scopeSentence(removed)}.
                </Alert>
              )}
              {widening && (
                <div className="rounded-lg border border-warn/40 bg-warn-soft p-4">
                  <p className="flex items-center gap-2 font-medium text-fg">
                    <ShieldAlert size={16} className="text-warn" aria-hidden /> This widens what the token can do
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-fg-2">
                    {added.map((s) => (
                      <li key={s}>
                        <strong className="font-medium text-fg">{SCOPE_TEXT[s as Scope]?.label ?? s}</strong>: it could{' '}
                        {SCOPE_TEXT[s as Scope]?.does ?? s}.
                      </li>
                    ))}
                    {expiryWidens && (
                      <li>
                        {newExpiry
                          ? `It keeps working until ${formatDateTime(newExpiry, { zone: true })}.`
                          : 'It keeps working with no end date.'}
                      </li>
                    )}
                  </ul>
                  <Field label="Your password" hint="Confirms it is you making this change." className="mt-3">
                    <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </Field>
                </div>
              )}
            </section>
          )}
          {error && (
            <Alert tone="bad" title="Not saved">
              {error}
            </Alert>
          )}
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">History</h3>
            {tok.history.length ? (
              <ol className="space-y-2 border-l-2 border-line pl-4 text-[13px]">
                {tok.history.map((h) => (
                  <li key={`${h.at}-${h.by.name}`}>
                    <p className="text-fg">
                      {Object.entries(h.changes)
                        .map(([k, v]) => describeChange(k, v))
                        .join('; ')}
                    </p>
                    <p className="text-[12px] text-muted">
                      {h.by.name} · {formatDateTime(h.at)}
                      {h.steppedUp && ' · confirmed with password'}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[13px] text-muted">No changes recorded. Tokens created before 0.2 have no history from before.</p>
            )}
          </section>
        </div>
      ) : null}
      {confirmDialog}
    </Drawer>
  );
}
