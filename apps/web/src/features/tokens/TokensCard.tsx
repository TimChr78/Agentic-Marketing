import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api, type Out } from '../../app/api';
import { navigate } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Button, CodeView, EmptyState, formatDate, Modal, Mono, Table, TableFrame, Tag, Td, THead, Th, Tr, timeAgo } from '../../ui';
import { CreateTokenDrawer } from './CreateTokenDrawer';
import { TokenDrawer } from './TokenDrawer';
import { TokenStatus } from './TokenStatus';

type Token = Out<'apiTokens.list'>['tokens'][number];

/** API tokens (#44): list, create (shown once), open a token to see its history and edit it. */
export function TokensCard({ openId }: { openId?: string }) {
  const { can, workspace, memberships } = useWorkspace();
  const list = useApi(() => api.call('apiTokens.list', {}), []);
  const warnings = useApi(() => api.call('system.inputWarnings', {}), []);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string; workspaceName: string } | null>(null);
  const tokens = list.data?.tokens ?? [];
  const admin = can('workspace:admin');
  const ignored = new Map((warnings.data?.clients ?? []).filter((c) => c.principalType === 'token').map((c) => [c.principalId, c]));
  const open = (id: string) => navigate(`/settings/integrations/tokens/${id}`);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[70ch] text-[13px] leading-5 text-muted">
          {admin
            ? 'Everyone’s tokens in this workspace. Tokens act as agents with the scopes chosen, never more than the owner’s role.'
            : 'Your tokens for scripts and agents. They act as agents with the scopes you choose.'}
        </p>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
          Create token
        </Button>
      </div>
      {admin && warnings.data && !warnings.data.strictInputs && warnings.data.safeToEnableStrict && (
        <Alert tone="good">
          No client has sent unknown input keys for 7 days: it's safe to set <Mono>STRICT_INPUTS=true</Mono>.
        </Alert>
      )}
      <TableFrame
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        isEmpty={!tokens.length}
        empty={
          <EmptyState
            title="No API tokens yet"
            action={
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
                Create token
              </Button>
            }
          >
            Create one for an agent such as Hermes, or for n8n and scripts: send it as <Mono>Authorization: Bearer amk_…</Mono> to{' '}
            <Mono>/v1/&lt;command&gt;</Mono> or <Mono>/mcp</Mono>.
          </EmptyState>
        }
      >
        <Table label="API tokens">
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Brand</Th>
              {admin && <Th>Owner</Th>}
              <Th className="hidden lg:table-cell">Scopes</Th>
              <Th>Last used</Th>
              <Th className="hidden md:table-cell">Expires</Th>
              <Th>Status</Th>
            </tr>
          </THead>
          <tbody>
            {tokens.map((t: Token) => (
              <Tr key={t.id} onClick={() => open(t.id)} selected={openId === t.id}>
                <Td>
                  <button
                    type="button"
                    className="font-medium text-fg hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      open(t.id);
                    }}
                  >
                    {t.name}
                  </button>
                  <div className="font-mono text-[11px] text-muted">{t.tokenHint}</div>
                  {ignored.has(t.id) && (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: only stops the row click from firing; the summary toggles natively from the keyboard
                    <details className="mt-1 text-[12px] text-muted" onClick={(e) => e.stopPropagation()}>
                      <summary className="cursor-pointer hover:text-fg">
                        Inputs the API ignored: {ignored.get(t.id)!.total} in the last {warnings.data?.sinceDays ?? 30} days (last{' '}
                        {timeAgo(ignored.get(t.id)!.lastSeen)})
                      </summary>
                      <ul className="mt-1.5 space-y-0.5">
                        {ignored.get(t.id)!.commands.map((c) => (
                          <li key={c.command}>
                            <Mono>{c.command}</Mono> → {c.keys.map((k) => `${k.keyPath} (${k.count})`).join(', ')}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </Td>
                <Td className="whitespace-nowrap">{t.workspaceName}</Td>
                {admin && <Td>{t.ownerName}</Td>}
                <Td className="hidden max-w-[360px] lg:table-cell">
                  <span className="flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <Tag key={s}>{s}</Tag>
                    ))}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">{t.lastUsedAt ? timeAgo(t.lastUsedAt) : 'Never'}</Td>
                <Td className="hidden whitespace-nowrap md:table-cell">{t.expiresAt ? formatDate(t.expiresAt) : 'Never'}</Td>
                <Td>
                  <TokenStatus t={t} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
      {creating && (
        <CreateTokenDrawer
          allowed={workspace.you.permissions}
          memberships={memberships}
          currentWorkspaceId={workspace.id}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            void list.reload();
          }}
        />
      )}
      {created && (
        <Modal
          open
          onClose={() => setCreated(null)}
          title={`Token “${created.name}” created`}
          footer={
            <Button variant="primary" onClick={() => setCreated(null)}>
              I've stored it
            </Button>
          }
        >
          <p className="mb-3">
            Copy it now and store it in the tool that uses it. It is shown only once; if you lose it, revoke it and create a new one.
          </p>
          <p className="mb-3 text-[13px] text-muted">
            It acts in <strong>{created.workspaceName}</strong> only. To let a tool work in another brand, create a second token there.
          </p>
          <CodeView value={created.token} />
          <p className="mt-3 text-[13px] text-muted">
            REST: <Mono>Authorization: Bearer {created.token.slice(0, 8)}…</Mono> on <Mono>{location.origin}/v1/&lt;command&gt;</Mono>. MCP:{' '}
            <Mono>{location.origin}/mcp</Mono> with the same header.
          </p>
        </Modal>
      )}
      {openId && <TokenDrawer id={openId} onClose={() => navigate('/settings/integrations')} onChanged={() => void list.reload()} />}
    </div>
  );
}
