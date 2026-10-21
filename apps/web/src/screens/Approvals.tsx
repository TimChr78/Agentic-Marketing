import { useState } from 'react';
import { Check, Mail, Workflow, X } from 'lucide-react';
import { useStore } from '../mock/store';
import { exec } from '../api/commands';
import type { ApprovalPolicy } from '../api/types';
import { AuthorBadge, Button, Card, PageHeader, Pill, cx, timeAgo } from '../components/ui';

const policies: { id: ApprovalPolicy; label: string; text: string }[] = [
  { id: 'none', label: 'No approvals', text: 'Single-person workspace: publish directly.' },
  { id: 'agent_changes', label: 'Agent changes need a human', text: 'People publish directly; anything an agent wrote waits for review.' },
  { id: 'all_publishes', label: 'Every publish needs approval', text: 'Teams with a review step for all changes.' },
];

export function Approvals() {
  const { approvals, approvalPolicy, toast, navigate } = useStore();
  const [openId, setOpenId] = useState<string | null>(approvals.find((a) => a.status === 'pending')?.id ?? null);
  const open = approvals.find((a) => a.id === openId);

  async function decide(approve: boolean) {
    if (!open) return;
    const res = await exec<{ status: string }>(approve ? 'artifacts.approve' : 'artifacts.reject', { approvalId: open.id });
    toast(approve ? `${open.artifactName} v${open.toVersion} published` : `Rejected; ${open.artifactName} v${open.toVersion} is a draft again`, approve ? 'good' : 'neutral');
    if (res.status) setOpenId(approvals.find((a) => a.status === 'pending' && a.id !== open.id)?.id ?? null);
  }

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader eyebrow="Versioning & governance" title="Approvals" />

      <Card title="Workspace approval policy" className="mb-5">
        <div className="grid gap-2 p-3 md:grid-cols-3">
          {policies.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                useStore.setState({ approvalPolicy: p.id });
                toast(`Approval policy: ${p.label}`, 'neutral');
              }}
              className={cx('rounded-md border p-3 text-left', approvalPolicy === p.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}
            >
              <div className={cx('text-[13px] font-semibold', approvalPolicy === p.id && 'text-accent')}>{p.label}</div>
              <div className="mt-0.5 text-[12px] text-muted">{p.text}</div>
            </button>
          ))}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card title="Requests">
          <ul className="divide-y divide-line">
            {approvals.map((a) => (
              <li key={a.id}>
                <button onClick={() => setOpenId(a.id)} className={cx('flex w-full items-start gap-3 px-4 py-3 text-left', a.id === openId ? 'bg-surface-2' : 'hover:bg-surface-2')}>
                  {a.artifactType === 'journey' ? <Workflow size={15} className="mt-0.5 text-muted" /> : <Mail size={15} className="mt-0.5 text-muted" />}
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      {a.artifactName} <span className="num font-normal text-muted">v{a.fromVersion ?? '–'} → v{a.toVersion}</span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <AuthorBadge author={a.requestedBy} />
                      <span className="text-[11px] text-muted">{timeAgo(a.createdAt)}</span>
                    </span>
                  </span>
                  <Pill tone={a.status === 'pending' ? 'agent' : a.status === 'approved' ? 'good' : 'neutral'}>{a.status}</Pill>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        {open ? (
          <Card
            title={
              <span>
                {open.artifactName}: v{open.fromVersion ?? '–'} → v{open.toVersion}
              </span>
            }
            action={<AuthorBadge author={open.requestedBy} />}
          >
            <div className="border-b border-line px-4 py-3">
              <div className="eyebrow mb-1">Why</div>
              <p className="max-w-[70ch] text-[14px]">{open.summary}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-[13px]">
                <thead className="text-[11px] uppercase tracking-wider text-muted">
                  <tr className="border-b border-line">
                    <th className="w-[90px] px-4 py-2 font-semibold">Change</th>
                    <th className="px-4 py-2 font-semibold">Path</th>
                    <th className="px-4 py-2 font-semibold">Before</th>
                    <th className="px-4 py-2 font-semibold">After</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {open.changes.map((c, i) => (
                    <tr key={i} className="align-top">
                      <td className="px-4 py-2">
                        <Pill tone={c.kind === 'added' ? 'good' : c.kind === 'removed' ? 'bad' : 'accent'}>{c.kind}</Pill>
                      </td>
                      <td className="px-4 py-2 font-mono text-[12px] text-muted">{c.path}</td>
                      <td className="break-words px-4 py-2 font-mono text-[12px] [overflow-wrap:anywhere]">{c.before ? <span className="rounded bg-bad-soft px-1 text-bad line-through decoration-1">{c.before}</span> : '—'}</td>
                      <td className="break-words px-4 py-2 font-mono text-[12px] [overflow-wrap:anywhere]">{c.after ? <span className="rounded bg-good-soft px-1 text-good">{c.after}</span> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
              {open.status === 'pending' ? (
                <>
                  <Button variant="primary" onClick={() => decide(true)}>
                    <Check size={14} /> Approve & publish
                  </Button>
                  <Button onClick={() => decide(false)}>
                    <X size={14} /> Reject
                  </Button>
                </>
              ) : (
                <Pill tone={open.status === 'approved' ? 'good' : 'neutral'}>{open.status}</Pill>
              )}
              {open.artifactType === 'journey' && (
                <Button variant="ghost" onClick={() => navigate('journeys', { journeyId: open.artifactId })}>
                  Open in journey builder
                </Button>
              )}
              <span className="ml-auto text-[11px] text-muted">Agents can request publishes but can never approve.</span>
            </div>
          </Card>
        ) : (
          <Card>
            <div className="p-6 text-[13px] text-muted">Select a request to see its diff.</div>
          </Card>
        )}
      </div>
    </div>
  );
}
