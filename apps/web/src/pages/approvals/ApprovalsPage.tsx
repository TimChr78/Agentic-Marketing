import { CheckCheck, Eye } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type Out } from '../../app/api';
import { typeLabel } from '../../app/artifactRoutes';
import { useCrumbs } from '../../app/page';
import { Link, navigate, useLocation } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { ApprovalDrawer } from '../../features/approvals/ApprovalDrawer';
import { RequesterView } from '../../features/approvals/requester';
import { useViewedTick, wasViewed } from '../../features/approvals/viewed';
import { Button, Checkbox, cx, EmptyState, PageHeader, StatusPill, Table, TableFrame, Tabs, Tag, Td, Th, THead, timeAgo, Tr, useConfirm, useToast } from '../../ui';

type Approval = Out<'approvals.list'>['approvals'][number];
type Status = 'pending' | 'approved' | 'rejected';

/** Approvals (#41): the queue of changes waiting for a person, each opened in a review drawer. */
export default function ApprovalsPage({ params }: { params: Record<string, string> }) {
  useCrumbs([{ label: 'Approvals', to: '/approvals' }, ...(params.id ? [{ label: 'Review' }] : [])]);
  const { can, user, refreshPending } = useSession();
  const { search } = useLocation();
  const status = (search.get('status') as Status) || 'pending';
  const list = useApi(() => api.call('approvals.list', { status, limit: 200 }), [status]);
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batching, setBatching] = useState(false);
  useViewedTick();

  const items = list.data?.approvals ?? [];
  const canApprove = can('artifacts:approve');
  const viewed = (a: Approval) => wasViewed(user!.id, a.id, a.version);
  const selectable = items.filter((a) => a.status === 'pending' && viewed(a));
  const chosen = items.filter((a) => selected.has(a.id) && viewed(a));
  const notViewed = items.filter((a) => a.status === 'pending' && !viewed(a)).length;

  const reload = () => {
    void list.reload();
    refreshPending();
  };
  const batchApprove = async () => {
    const ok = await confirm({
      title: `Approve ${chosen.length} ${chosen.length === 1 ? 'change' : 'changes'}?`,
      body: (
        <>
          <p>Each one is published at once:</p>
          <ul className="mt-2 list-disc pl-5">
            {chosen.map((a) => (
              <li key={a.id}>
                {a.artifactName} <span className="text-muted">({typeLabel(a.artifactType)}, v{a.version})</span>
              </li>
            ))}
          </ul>
        </>
      ),
      confirmLabel: `Approve ${chosen.length}`,
    });
    if (!ok) return;
    setBatching(true);
    const failed: string[] = [];
    for (const a of chosen) {
      try {
        await api.call('approvals.approve', { approvalId: a.id });
      } catch (e) {
        failed.push(`${a.artifactName}: ${(e as Error).message}`);
      }
    }
    setBatching(false);
    setSelected(new Set());
    if (failed.length) toast.error(<>Some approvals failed:<br />{failed.join('; ')}</>);
    else toast.success(`Approved ${chosen.length} ${chosen.length === 1 ? 'change' : 'changes'}; they are live.`);
    reload();
  };

  const tabs = useMemo(
    () => [
      { key: 'pending' as const, label: 'Pending', count: status === 'pending' ? items.length : undefined },
      { key: 'approved' as const, label: 'Approved' },
      { key: 'rejected' as const, label: 'Rejected' },
    ],
    [status, items.length],
  );

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Changes waiting for a person. Open each one to see the actual e-mail, form, journey, segment or broadcast before you approve it."
        actions={
          canApprove && status === 'pending' && items.length > 0 ? (
            <Button variant="primary" icon={<CheckCheck size={15} />} disabled={!chosen.length} loading={batching} onClick={batchApprove}>
              {chosen.length ? `Approve ${chosen.length} selected` : 'Approve selected'}
            </Button>
          ) : undefined
        }
      />
      <Tabs label="Status" items={tabs} value={status} onChange={(k) => navigate(k === 'pending' ? '/approvals' : `/approvals?status=${k}`, { replace: true })} />
      {canApprove && status === 'pending' && notViewed > 0 && items.length > 1 && (
        <p className="mt-3 text-[12px] text-muted">
          <Eye size={13} className="mr-1 inline align-[-2px]" aria-hidden />
          You can select a change for batch approval after you have opened its preview. {notViewed} not yet viewed.
        </p>
      )}
      <div className="mt-4">
        <TableFrame
          loading={list.loading}
          error={list.error}
          onRetry={list.reload}
          columns={5}
          isEmpty={items.length === 0}
          empty={
            <EmptyState title={status === 'pending' ? 'Nothing waiting for review' : `No ${status} changes`}>
              {status === 'pending'
                ? 'When an agent or a teammate submits a change for review, it appears here. You get the link in their request too.'
                : 'Decisions appear here once someone approves or rejects a change.'}
            </EmptyState>
          }
        >
          {/* Cards on phones, a table from 640 px. */}
          <ul className="divide-y divide-line sm:hidden">
            {items.map((a) => (
              <li key={a.id}>
                <Link to={`/approvals/${a.id}${status === 'pending' ? '' : `?status=${status}`}`} className="block px-4 py-3 hover:bg-surface-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-fg">{a.artifactName}</span>
                    <ViewedPill a={a} viewed={viewed(a)} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                    <Tag>{typeLabel(a.artifactType)}</Tag>
                    <RequesterView r={a.requester} />
                    <span>{timeAgo(a.createdAt)}</span>
                  </div>
                  {a.note && <p className="mt-1.5 line-clamp-2 text-[13px] text-fg-2">{a.note}</p>}
                </Link>
              </li>
            ))}
          </ul>
          <Table label="Approval requests" className="hidden sm:table">
            <THead>
              <tr>
                {canApprove && status === 'pending' && (
                  <Th className="w-10 pr-0">
                    <span className="sr-only">Select</span>
                    <input
                      type="checkbox"
                      aria-label="Select all viewed changes"
                      className="size-4 accent-[var(--accent)]"
                      checked={selectable.length > 0 && selectable.every((a) => selected.has(a.id))}
                      disabled={!selectable.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((a) => a.id)) : new Set())}
                    />
                  </Th>
                )}
                <Th>Change</Th>
                <Th>Requested by</Th>
                <Th className="hidden lg:table-cell">Note</Th>
                <Th>{status === 'pending' ? 'Waiting' : 'Requested'}</Th>
                <Th>{status === 'pending' ? 'Review' : 'Decision'}</Th>
              </tr>
            </THead>
            <tbody>
              {items.map((a) => (
                <Tr key={a.id} onClick={() => navigate(`/approvals/${a.id}${status === 'pending' ? '' : `?status=${status}`}`)} selected={params.id === a.id}>
                  {canApprove && status === 'pending' && (
                    <Td className="pr-0" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        label={<span className="sr-only">Select {a.artifactName}</span>}
                        checked={selected.has(a.id)}
                        disabled={!viewed(a)}
                        title={viewed(a) ? undefined : 'Open the preview first'}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(a.id);
                          else next.delete(a.id);
                          setSelected(next);
                        }}
                      />
                    </Td>
                  )}
                  <Td>
                    <Link to={`/approvals/${a.id}${status === 'pending' ? '' : `?status=${status}`}`} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                      {a.artifactName}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
                      {typeLabel(a.artifactType)} · v{a.version} · {a.artifactPublishedVersion ? `changes live v${a.artifactPublishedVersion}` : 'new'}
                    </div>
                  </Td>
                  <Td>
                    <RequesterView r={a.requester} />
                  </Td>
                  <Td className="hidden max-w-[320px] lg:table-cell">
                    <span className="line-clamp-2">{a.note}</span>
                  </Td>
                  <Td className="whitespace-nowrap">{timeAgo(a.createdAt)}</Td>
                  <Td>
                    {a.status === 'pending' ? (
                      <ViewedPill a={a} viewed={viewed(a)} />
                    ) : (
                      <StatusPill tone={a.status === 'approved' ? 'good' : 'bad'}>{a.status === 'approved' ? 'Approved' : 'Rejected'}</StatusPill>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      </div>
      {confirmDialog}
      {params.id && (
        <ApprovalDrawer
          id={params.id}
          queue={items.filter((a) => a.status === 'pending').map((a) => a.id)}
          onClose={() => navigate(status === 'pending' ? '/approvals' : `/approvals?status=${status}`)}
          onDecided={reload}
        />
      )}
    </div>
  );
}

function ViewedPill({ a, viewed }: { a: Approval; viewed: boolean }) {
  if (a.status !== 'pending') return null;
  return viewed ? (
    <StatusPill tone="neutral" className={cx('bg-transparent')}>
      Viewed
    </StatusPill>
  ) : (
    <StatusPill tone="warn">Not yet viewed</StatusPill>
  );
}
