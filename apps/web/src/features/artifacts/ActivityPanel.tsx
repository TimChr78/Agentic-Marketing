import { api } from '../../app/api';
import { Link } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Card, EmptyState, formatDateTime, LoadingBlock, StatusPill, Table, TableFrame, Td, Th, THead, timeAgo, Tr } from '../../ui';

const verb: Record<string, string> = {
  'artifacts.create': 'Created',
  'artifacts.updateDraft': 'Edited the draft',
  'artifacts.requestPublish': 'Asked to publish',
  'approvals.approve': 'Approved',
  'approvals.reject': 'Rejected',
  'templates.sendTest': 'Sent a test',
  'broadcasts.sendTest': 'Sent a test',
  'broadcasts.cancel': 'Cancelled sending',
};

/** Who did what to this artifact: approval requests and decisions, and the audit log for roles that may read it. */
export function ActivityPanel({ artifactId }: { artifactId: string }) {
  const { can } = useSession();
  const approvals = useApi(
    async () => (await Promise.all((['pending', 'approved', 'rejected'] as const).map((status) => api.call('approvals.list', { status, artifactId, limit: 50 })))).flatMap((r) => r.approvals).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [artifactId],
  );
  const audit = useApi(() => api.call('audit.list', { target: artifactId, limit: 100 }), [artifactId], { skip: !can('audit:read') });
  return (
    <div className="space-y-4">
      <Card title="Reviews">
        {approvals.loading ? (
          <LoadingBlock lines={3} />
        ) : !approvals.data?.length ? (
          <EmptyState compact title="No reviews yet">Requests to publish and their decisions show here.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {approvals.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-[13px]">
                <StatusPill tone={r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : 'warn'}>{r.status === 'pending' ? 'Waiting' : r.status === 'approved' ? 'Approved' : 'Rejected'}</StatusPill>
                <div className="min-w-0 flex-1">
                  <p>
                    v{r.version} requested by <span className="font-medium">{r.requester.displayName}</span> <span className="text-muted">· {timeAgo(r.createdAt)}</span>
                  </p>
                  {r.note && <p className="text-fg-2">“{r.note}”</p>}
                  {r.decisionNote && <p className="text-fg-2">Decision: “{r.decisionNote}”</p>}
                </div>
                <Link to={`/approvals/${r.id}${r.status === 'pending' ? '' : `?status=${r.status}`}`} className="font-medium text-accent hover:underline">
                  Open
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {can('audit:read') ? (
        <Card title="Audit log" description="Every command run on this item, by people and agents, from the tamper-evident log.">
          <TableFrame loading={audit.loading} error={audit.error} onRetry={audit.reload} isEmpty={!audit.data?.entries.length} empty={<EmptyState compact title="No entries" />} className="rounded-none border-0">
            <Table label="Audit log">
              <THead>
                <tr>
                  <Th>When</Th>
                  <Th>Who</Th>
                  <Th>What</Th>
                  <Th>Via</Th>
                  <Th>Result</Th>
                </tr>
              </THead>
              <tbody>
                {audit.data?.entries.map((e) => (
                  <Tr key={e.seq}>
                    <Td className="whitespace-nowrap">{formatDateTime(e.at)}</Td>
                    <Td>{e.actorName ?? e.principalId}</Td>
                    <Td>{verb[e.command] ?? e.command}</Td>
                    <Td className="uppercase">{e.surface}</Td>
                    <Td>{e.ok ? <StatusPill tone="good">OK</StatusPill> : <StatusPill tone="bad">{e.error ?? 'Failed'}</StatusPill>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        </Card>
      ) : (
        <p className="text-[12px] text-muted">The full audit log needs the audit:read permission.</p>
      )}
    </div>
  );
}
