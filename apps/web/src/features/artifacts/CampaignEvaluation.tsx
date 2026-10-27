import { api, type Out } from '../../app/api';
import { useApi } from '../../app/useApi';
import { HoldoutCard } from '../insights/HoldoutCard';
import { StatCard, StatGrid } from '../insights/Stats';
import { Alert, EmptyState, LoadingBlock, Table, TableFrame, Td, Th, THead, Tr } from '../../ui';

// The campaign page's Evaluation tab (#66). Everything comes from analytics.campaignSummary;
// there are no local fixtures and no client-side attribution.

type Summary = Out<'analytics.campaignSummary'>;

const int = (n: number) => n.toLocaleString();
const rate = (n: number | null) => (n === null ? '—' : `${Math.round(n * 1000) / 10}%`);
const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function CampaignEvaluation({ campaignId }: { campaignId: string }) {
  const summary = useApi(() => api.call('analytics.campaignSummary', { campaignId }), [campaignId]);
  const s = summary.data;

  if (summary.loading) return <LoadingBlock lines={8} label="Loading campaign evaluation" />;
  if (summary.error) return <Alert tone="bad" title="Couldn't load the campaign evaluation" onRetry={summary.reload}>{summary.error}</Alert>;
  if (!s) return null;

  if (s.state === 'not_started') {
    const r = s.readiness;
    return (
      <div className="max-w-[900px]">
        <EmptyState title="No results yet: this campaign has not sent">
          Readiness: {r.published ? 'campaign published' : 'campaign not published'} ·{' '}
          {r.sendingMembers ? `${r.publishedSendingMembers} of ${r.sendingMembers} sending members published` : 'no sending members yet'} ·{' '}
          {r.sendingMembersScheduled ? 'a send is scheduled' : 'no send scheduled'}.
        </EmptyState>
        <p className="mt-3 text-[12px] text-muted">
          {s.meta.notes.join(' ')} Adds a broadcast or journey to the campaign and publishes it; results appear after the first send.
        </p>
      </div>
    );
  }

  const h = s.headline;
  return (
    <div className="max-w-[1100px] space-y-5">
      <StatGrid columns={6}>
        <StatCard label="Recipients" value={int(h.recipients)} hint="Unique people reached" />
        <StatCard label="Delivered" value={int(h.delivered)} hint={`${rate(h.recipients ? h.delivered / h.recipients : null)} of recipients`} />
        <StatCard label="Clickers" value={int(h.clickers)} hint={`${rate(h.delivered ? h.clickers / h.delivered : null)} click rate`} />
        <StatCard label="Unsubscribers" value={int(h.unsubscribers)} hint={`${rate(h.unsubscribeRate)} unsubscribe · ${rate(h.complaintRate)} complaint`} />
        <StatCard
          label="Converters"
          value={int(h.converters)}
          hint={`${rate(h.conversionRate)} conversion${h.targetProgress !== null ? ` · ${rate(h.targetProgress)} of target` : ''}`}
        />
        <StatCard
          label="Revenue"
          value={h.revenue.length ? h.revenue.map((r) => `${money(r.amount)} ${r.currency}`).join(' · ') : '—'}
          hint={h.revenuePerRecipient.length ? `${h.revenuePerRecipient.map((r) => `${money(r.amount)} ${r.currency}`).join(' · ')} per recipient` : 'No attributed revenue'}
        />
      </StatGrid>

      <section className="rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <p className="text-[13px] font-semibold">Funnel</p>
          <p className="text-[12px] text-muted">Recipients → delivered → clicked → converted, with each step’s share of the one before.</p>
        </div>
        <TableFrame columns={4} isEmpty={false}>
          <Table label="Campaign funnel">
            <THead>
              <tr>
                <Th>Step</Th>
                <Th align="right">People</Th>
                <Th align="right">Step %</Th>
                <Th align="right">Of recipients</Th>
              </tr>
            </THead>
            <tbody>
              {s.funnel.map((step) => (
                <Tr key={step.step}>
                  <Td>
                    <span className="font-medium text-fg">{step.step[0].toUpperCase() + step.step.slice(1)}</span>
                  </Td>
                  <Td align="right">{int(step.count)}</Td>
                  <Td align="right">{rate(step.stepRate)}</Td>
                  <Td align="right">{rate(step.shareOfRecipients)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      </section>

      <section className="rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <p className="text-[13px] font-semibold">Members</p>
          <p className="text-[12px] text-muted">Each broadcast and journey that sent for this campaign.</p>
        </div>
        <TableFrame
          columns={7}
          isEmpty={s.members.length === 0}
          empty={<EmptyState compact title="No sending members">Add a broadcast or journey, then publish the campaign and its members.</EmptyState>}
        >
          <Table label="Campaign members">
            <THead>
              <tr>
                <Th>Member</Th>
                <Th>Type</Th>
                <Th align="right">Sent</Th>
                <Th align="right">Delivered</Th>
                <Th align="right">Click rate</Th>
                <Th align="right">Unsubscribe</Th>
                <Th align="right">Converters</Th>
              </tr>
            </THead>
            <tbody>
              {s.members.map((m) => (
                <Tr key={m.artifactId}>
                  <Td>
                    <span className="font-medium text-fg">{m.name}</span>
                    <span className="ml-1.5 text-[11px] text-muted">{m.role.replace('_', ' ')}</span>
                  </Td>
                  <Td>{m.type}</Td>
                  <Td align="right">{int(m.sent)}</Td>
                  <Td align="right">{int(m.delivered)}</Td>
                  <Td align="right">{rate(m.clickRate)}</Td>
                  <Td align="right">{rate(m.unsubscribeRate)}</Td>
                  <Td align="right">{int(m.converters)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      </section>

      {s.holdouts.length > 0 && (
        <section className="space-y-3">
          <div>
            <p className="text-[13px] font-semibold">Journey holdouts</p>
            <p className="text-[12px] text-muted">Incremental effect of each journey member that has a control group.</p>
          </div>
          {s.holdouts.map((holdout) => (
            <HoldoutCard key={holdout.journeyId} title={`${holdout.name} holdout`} result={holdout} />
          ))}
        </section>
      )}

      {/* campaign holdout card */}

      <p className="text-[12px] text-muted">
        {s.meta.notes.join(' ')} Time zone {s.meta.timeZone}
        {s.meta.freshness ? ` · newest event ${new Date(s.meta.freshness).toLocaleString()}` : ''}
        {s.meta.suppressed ? ` · ${s.meta.suppressed} group${s.meta.suppressed === 1 ? '' : 's'} suppressed (k=${s.meta.k})` : ''}.
      </p>
    </div>
  );
}

export type { Summary };
