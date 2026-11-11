import { useId, useMemo, useState } from 'react';
import { api } from '../../../app/api';
import { useWorkspace } from '../../../app/session';
import { useApi } from '../../../app/useApi';
import { Alert, Button, Card, ChartSkeleton, EmptyState, Field, Select, Table, TableFrame, Td, THead, Th, Tr } from '../../../ui';
import { StatCard } from '../../insights/Stats';
import { HoldoutPanel } from './HoldoutPanel';
import {
  allHeadlineZero,
  type CampaignSummary as CampaignSummaryType,
  funnelBars,
  goalText,
  int,
  isNotFound,
  type JourneyHoldoutResult,
  latestEventText,
  type MeasuredSummary,
  type MemberRow,
  memberRateLabel,
  money,
  ownPeriod,
  type PeriodChoice,
  periodLabelOf,
  ROLE_LABEL,
  rateOrDash,
  revenuePerRecipientFor,
  targetProgressText,
  typeLabel,
  zoneOf,
} from './model';

// The campaign Evaluation tab (#511) is a results roll-up, not a new list dashboard. It reads one
// aggregate summary; member rows and journey holdouts come from that same returned summary, so a
// campaign with many members still costs one client call. The host supplies the shared period and
// only mounts this view while the tab is active.

export interface CampaignEvaluationViewProps {
  campaignId: string;
  from?: string;
  to?: string;
  active?: boolean;
  refreshKey?: number;
}

function MetricGrid({ summary }: { summary: MeasuredSummary }) {
  const h = summary.headline;
  const multiCurrency = h.revenue.length > 1;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Recipients" value={int(h.recipients)} hint="Distinct people reached on any channel" />
        <StatCard
          label="E-mails delivered"
          value={int(h.delivered)}
          hint={h.emailSent > 0 ? `${int(h.delivered)} of ${int(h.emailSent)} e-mails sent` : 'Unavailable · no e-mails sent'}
        />
        <StatCard
          label="E-mail clickers"
          value={int(h.clickers)}
          hint={h.delivered > 0 ? `${int(h.clickers)} of ${int(h.delivered)} delivered e-mails` : 'Unavailable · no delivered e-mails'}
        />
        <StatCard
          label="Converters"
          value={int(h.converters)}
          hint={`${int(h.converters)} / ${int(h.recipients)} recipients = ${rateOrDash(h.conversionRate, h.recipients)}`}
        />
        <StatCard
          label="E-mail unsubscribers"
          value={int(h.unsubscribers)}
          hint={`${int(h.unsubscribers)} / ${int(h.delivered)} delivered e-mails = ${rateOrDash(h.unsubscribeRate, h.delivered)}`}
        />
        <StatCard
          label="E-mail complaint rate"
          value={rateOrDash(h.complaintRate, h.delivered)}
          hint={h.delivered > 0 ? `of ${int(h.delivered)} delivered e-mails` : 'Unavailable · no delivered e-mails'}
        />
        <StatCard
          label="E-mail unsubscribe rate"
          value={rateOrDash(h.unsubscribeRate, h.delivered)}
          hint={h.delivered > 0 ? `${int(h.unsubscribers)} of ${int(h.delivered)} delivered e-mails` : 'Unavailable · no delivered e-mails'}
        />
        {h.revenue.length === 0 ? (
          <StatCard label="Revenue" value="—" hint="No attributed revenue" />
        ) : (
          h.revenue.map((row) => {
            const perRecipient = revenuePerRecipientFor(h, row.currency);
            return (
              <StatCard
                key={`${row.currency}-${row.amount}`}
                label={`Revenue · ${row.currency}`}
                value={money(row.amount, row.currency)}
                hint={
                  perRecipient
                    ? `${money(perRecipient.amount, row.currency)} per attributed recipient on any channel`
                    : 'Per-recipient revenue unavailable'
                }
              />
            );
          })
        )}
      </div>
      {multiCurrency && (
        <p className="text-[12px] leading-[18px] text-muted">Amounts stay separate per currency; no combined total, average or chart.</p>
      )}
      <Card title="Goal" description={`${goalText(summary.goal)} · attribution window ${int(summary.goal.attributionDays)} days`}>
        <div className="space-y-1.5 p-4 text-[13px] leading-5">
          <p>
            Target: <strong>{typeof summary.goal.target === 'number' ? int(summary.goal.target) : 'Not set'}</strong>
          </p>
          <p>
            Progress: <strong>{targetProgressText(h.targetProgress, summary.goal.target, multiCurrency)}</strong>
          </p>
          <p className="text-[12px] leading-[18px] text-muted">
            Converters are distinct people who got a campaign message and converted within {int(summary.goal.attributionDays)} days of their
            first campaign message (first touch). Member counts are not added to the distinct recipient total.
          </p>
        </div>
      </Card>
      {allHeadlineZero(h) && (
        <Alert tone="info" title="Zero recorded events">
          Zero recorded events does not prove no engagement. Latest event in period:{' '}
          {latestEventText(summary.meta.freshness, zoneOf(summary.meta.timeZone))}.
        </Alert>
      )}
    </div>
  );
}

function FunnelSection({ summary, bounds, zone }: { summary: MeasuredSummary; bounds: { from: string; to: string }; zone: string }) {
  const figureId = useId();
  const bars = funnelBars(summary.funnel);
  const periodLabel = periodLabelOf(bounds, zone, summary.meta);
  return (
    <Card title="Results across sending members" description="Independent counts, not a click-conditioned funnel.">
      <div className="space-y-4 p-4">
        <figure aria-labelledby={figureId}>
          <figcaption id={figureId} className="sr-only">
            Campaign funnel: {bars.map((bar) => `${bar.label} ${int(bar.count)} people`).join('; ')}. The same returned values are in the
            table below.
          </figcaption>
          <div className="space-y-3">
            {bars.map((bar) => (
              <div key={bar.step}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px] leading-[18px]">
                  <span className="font-medium text-fg">{bar.label}</span>
                  <span className="tabular-nums text-fg-2">{int(bar.count)} people</span>
                </div>
                <div
                  className="mt-1 h-3 overflow-hidden rounded bg-surface-2"
                  role="img"
                  aria-label={`${bar.label}: ${int(bar.count)} people`}
                >
                  <div className="h-3 rounded bg-[var(--viz-1)]" style={{ width: `${bar.width}%` }} />
                </div>
                <p className="mt-1 text-[11px] leading-[16px] text-muted">{bar.shareLabel}</p>
              </div>
            ))}
          </div>
        </figure>

        <TableFrame columns={4} isEmpty={false}>
          <Table label="Campaign funnel" className="max-lg:block">
            <thead className="bg-surface-2 text-[13px] leading-5 text-muted max-lg:hidden">
              <tr>
                <th scope="col" className="h-9 px-3 font-medium md:px-4">
                  Step
                </th>
                <th scope="col" className="h-9 px-3 text-right font-medium md:px-4">
                  People
                </th>
                <th scope="col" className="h-9 px-3 text-right font-medium md:px-4">
                  Step rate
                </th>
                <th scope="col" className="h-9 px-3 text-right font-medium md:px-4">
                  Share
                </th>
              </tr>
            </thead>
            <tbody className="max-lg:block">
              {bars.map((bar) => (
                <Tr key={bar.step} className="max-lg:block max-lg:border-b max-lg:border-line max-lg:py-2">
                  <Td className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
                    <span className="text-[12px] text-muted lg:hidden">Step</span>
                    <span>{bar.label}</span>
                  </Td>
                  <Td align="right" className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
                    <span className="text-[12px] text-muted lg:hidden">People</span>
                    <span>{int(bar.count)}</span>
                  </Td>
                  <Td align="right" className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
                    <span className="text-[12px] text-muted lg:hidden">Step rate</span>
                    <span>{bar.previous ? (bar.stepRate === '—' ? 'Unavailable' : `${bar.stepRate} of ${bar.previous}`) : '—'}</span>
                  </Td>
                  <Td align="right" className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
                    <span className="text-[12px] text-muted lg:hidden">Of recipients</span>
                    <span>{bar.sharePercent}</span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>

        <p className="text-[12px] leading-[18px] text-muted">
          Step rate divides by the previous stage; conversion is attributed to recipients, not conditioned on a click. Converters can exceed
          clickers. Delivered and clicked counts are e-mail; recipients and conversions cover every channel.
        </p>
        <p className="text-[12px] leading-[18px] text-muted">
          Period {periodLabel} · {zone} · Latest event in period: {latestEventText(summary.meta.freshness, zone)}
        </p>
      </div>
    </Card>
  );
}

function MemberCells({ member }: { member: MemberRow }) {
  const contentOnly = member.role === 'content';
  const hidden = member.suppressed;
  return (
    <>
      <Td className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
        <span className="text-[12px] text-muted lg:hidden">Member</span>
        <span className="min-w-0 text-right md:text-left">
          <span className="font-medium text-fg">{member.name}</span>
          <span className="ml-1.5 text-[11px] text-muted">{contentOnly ? 'Not a sending member' : ROLE_LABEL[member.role]}</span>
        </span>
      </Td>
      <Td className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
        <span className="text-[12px] text-muted lg:hidden">Type</span>
        <span>{typeLabel(member.type)}</span>
      </Td>
      <Td align="right" className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
        <span className="text-[12px] text-muted lg:hidden">E-mails sent</span>
        <span>{contentOnly ? '—' : hidden ? 'Suppressed' : int(member.sent)}</span>
      </Td>
      <Td align="right" className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
        <span className="text-[12px] text-muted lg:hidden">E-mails delivered</span>
        <span>{contentOnly ? '—' : hidden ? 'Suppressed' : int(member.delivered)}</span>
      </Td>
      <Td align="right" className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
        <span className="text-[12px] text-muted lg:hidden">Click rate</span>
        <span>{contentOnly ? 'Not a sending member' : hidden ? 'Suppressed' : memberRateLabel(member.clickRate, member.delivered)}</span>
      </Td>
      <Td align="right" className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
        <span className="text-[12px] text-muted lg:hidden">Unsubscribe rate</span>
        <span>
          {contentOnly ? 'Not a sending member' : hidden ? 'Suppressed' : memberRateLabel(member.unsubscribeRate, member.delivered)}
        </span>
      </Td>
      <Td align="right" className="max-lg:flex max-lg:items-start max-lg:justify-between max-lg:gap-3 max-lg:px-0">
        <span className="text-[12px] text-muted lg:hidden">Converters</span>
        <span>{contentOnly ? '—' : hidden ? 'Suppressed' : int(member.converters)}</span>
      </Td>
    </>
  );
}

function MembersSection({ summary }: { summary: MeasuredSummary }) {
  return (
    <Card
      title="Members"
      description={`Each broadcast and journey member of this campaign; sent and delivered count e-mail. Converters use the current published membership and ${int(summary.goal.attributionDays)}-day first-touch attribution.`}
    >
      <TableFrame
        columns={7}
        isEmpty={summary.members.length === 0}
        empty={
          <EmptyState compact title="No sending members">
            Add a broadcast or journey to the campaign, then publish the campaign and its members.
          </EmptyState>
        }
      >
        <Table label="Campaign members" className="max-lg:block">
          <thead className="bg-surface-2 text-[13px] leading-5 text-muted max-lg:hidden">
            <tr>
              <th scope="col" className="h-9 px-3 font-medium md:px-4">
                Member
              </th>
              <th scope="col" className="h-9 px-3 font-medium md:px-4">
                Type
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium md:px-4">
                E-mails sent
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium md:px-4">
                E-mails delivered
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium md:px-4">
                Click rate
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium md:px-4">
                Unsubscribe rate
              </th>
              <th scope="col" className="h-9 px-3 text-right font-medium md:px-4">
                Converters
              </th>
            </tr>
          </thead>
          <tbody className="max-lg:block">
            {summary.members.map((member) => (
              <Tr key={member.artifactId} className="max-lg:block max-lg:border-b max-lg:border-line max-lg:py-2">
                <MemberCells member={member} />
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
      <p className="px-4 py-3 text-[12px] leading-[18px] text-muted">
        People can receive several members. Member counts do not sum to distinct campaign recipients.
      </p>
    </Card>
  );
}

function JourneyHoldouts({
  holdouts,
  goalEvent,
  attributionDays,
  assignmentPeriod,
}: {
  holdouts: JourneyHoldoutResult[];
  goalEvent: string | null;
  attributionDays: number;
  assignmentPeriod: string;
}) {
  if (holdouts.length === 0) return null;
  return (
    <Card
      title="Journey holdouts"
      description="Incremental effect of each journey member that has a control group. Separate from the campaign-wide holdout."
    >
      <div className="space-y-4 p-4">
        {holdouts.map((holdout) => (
          <HoldoutPanel
            key={holdout.journeyId}
            title={`${holdout.name} · Journey holdout`}
            kind="journey"
            controlGroup={holdout.controlGroup}
            control={holdout.control}
            treatment={holdout.treatment}
            absoluteLift={holdout.absoluteLift}
            relativeLift={holdout.relativeLift}
            ci95={holdout.ci95}
            minSampleSizeMet={holdout.minSampleSizeMet}
            verdict={holdout.verdict}
            note={holdout.note}
            goalEvent={goalEvent}
            attributionDays={attributionDays}
            assignmentPeriod={assignmentPeriod}
          />
        ))}
      </div>
    </Card>
  );
}

function SuppressionNotice({ summary }: { summary: MeasuredSummary }) {
  return (
    <Alert tone="warn" title="Some member rows are suppressed">
      Member rows with fewer than k={int(summary.meta.k)} people reached have their counts and rates hidden. Campaign totals stay visible,
      and no identities or inferred values are shown.
    </Alert>
  );
}

function Readiness({ summary }: { summary: Extract<CampaignSummaryType, { state: 'not_started' }> }) {
  const r = summary.readiness;
  return (
    <Card title="No recorded campaign sends in this period" description="Choose another period; missing data is not a healthy result.">
      <div className="space-y-3 p-4">
        <Table label="Campaign readiness">
          <THead>
            <tr>
              <Th>Readiness</Th>
              <Th>State</Th>
            </tr>
          </THead>
          <tbody>
            <Tr>
              <Td>Campaign published</Td>
              <Td>{r.published ? 'Yes' : 'No'}</Td>
            </Tr>
            <Tr>
              <Td>Sending members published</Td>
              <Td>
                {int(r.publishedSendingMembers)} of {int(r.sendingMembers)}
              </Td>
            </Tr>
            <Tr>
              <Td>Sending members scheduled</Td>
              <Td>{r.sendingMembersScheduled ? 'Yes' : 'No'}</Td>
            </Tr>
          </tbody>
        </Table>
        <p className="text-[12px] leading-[18px] text-muted">
          Goal: {goalText(summary.goal)} · attribution window {int(summary.goal.attributionDays)} days.
        </p>
        {r.sendingMembers === 0 && (
          <p className="text-[12px] leading-[18px] text-muted">
            Add a broadcast or journey to the campaign and publish it; results appear after the first send.
          </p>
        )}
        {!r.published && <p className="text-[12px] leading-[18px] text-muted">The campaign is not published yet.</p>}
      </div>
    </Card>
  );
}

export function CampaignEvaluationView({ campaignId, from, to, active = true, refreshKey = 0 }: CampaignEvaluationViewProps) {
  const { can } = useWorkspace();
  const allowed = can('artifacts:read');
  const hostBounds = from && to ? { from, to } : null;
  const [choice, setChoice] = useState<PeriodChoice>(7);
  const [anchor, setAnchor] = useState(() => new Date());
  const [localRefresh, setLocalRefresh] = useState(0);
  const own = useMemo(() => ownPeriod(choice, anchor), [choice, anchor]);
  const bounds = hostBounds ?? { from: own.from, to: own.to };
  const summary = useApi(
    () => api.call('analytics.campaignSummary', { campaignId, from: bounds.from, to: bounds.to }),
    [campaignId, bounds.from, bounds.to, refreshKey, localRefresh],
    { skip: !allowed || !active },
  );
  const s = summary.data;

  if (!active) return null;
  if (!allowed) {
    return (
      <Alert tone="info" title="Results restricted">
        Your role needs artifacts:read. No campaign results have been loaded.
      </Alert>
    );
  }

  const selector = !hostBounds && (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Period" className="w-[220px]">
        <Select
          value={choice}
          onChange={(event) => {
            setAnchor(new Date());
            setChoice(Number(event.target.value) === 30 ? 30 : 7);
          }}
        >
          <option value={7}>Last 7 complete days</option>
          <option value={30}>Last 30 complete days</option>
        </Select>
      </Field>
      <Button
        variant="secondary"
        onClick={() => {
          setAnchor(new Date());
          setLocalRefresh((value) => value + 1);
        }}
      >
        Refresh
      </Button>
    </div>
  );

  if (summary.error) {
    if (isNotFound(summary.error)) {
      return (
        <Alert tone="info" title="Campaign not found">
          This item is not available at this address. It may have been deleted or belongs to another workspace.
        </Alert>
      );
    }
    return (
      <div className="space-y-4">
        {selector}
        <Alert tone="bad" title="Couldn't load the campaign evaluation" onRetry={summary.reload}>
          {summary.error}
        </Alert>
      </div>
    );
  }

  if (summary.refreshing || !s) {
    return (
      <div className="space-y-4">
        {selector}
        <section aria-busy="true" aria-label="Loading campaign evaluation">
          <ChartSkeleton label="Loading campaign evaluation" />
        </section>
      </div>
    );
  }

  const zone = zoneOf(s.meta.timeZone);
  const periodLabel = periodLabelOf(bounds, zone, s.meta);
  const latest = latestEventText(s.meta.freshness, zone);
  const periodLine = (
    <p className="text-[12px] leading-[18px] text-muted">
      {periodLabel} · {zone} · Latest event in period: {latest}
    </p>
  );

  if (s.state === 'not_started') {
    return (
      <div className="space-y-4">
        {!hostBounds && (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-[16px] leading-6 font-semibold">Campaign results</h2>
            {selector}
          </div>
        )}
        {periodLine}
        <Readiness summary={s} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {!hostBounds && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-[16px] leading-6 font-semibold">Campaign results</h2>
          {selector}
        </div>
      )}
      {periodLine}
      <MetricGrid summary={s} />
      <FunnelSection summary={s} bounds={bounds} zone={zone} />
      {s.meta.suppressed > 0 && <SuppressionNotice summary={s} />}
      <MembersSection summary={s} />
      <JourneyHoldouts
        holdouts={s.holdouts}
        goalEvent={s.goal.event}
        attributionDays={s.goal.attributionDays}
        assignmentPeriod={`${periodLabel} · ${zone}`}
      />
      {(s.meta.suppressed > 0 || s.meta.notes.length > 0) && (
        <p className="text-[12px] leading-[18px] text-muted">
          {s.meta.suppressed > 0 && <>k = {int(s.meta.k)} · </>}
          {s.meta.notes.join(' ')}
        </p>
      )}
    </div>
  );
}

// Kept for the existing host type import; the value is the same server union.
export type { CampaignSummaryType as Summary };
