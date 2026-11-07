import { api, errText } from '../../../app/api';
import { TextLink } from '../../../app/links';
import { useApi } from '../../../app/useApi';
import { Alert, LoadingBlock, StatusPill, Table, Td, THead, Th, Tr } from '../../../ui';
import { formatDateTime } from '../../../ui/time';
import type { LocalDayPeriod } from '../period';
import {
  type CampaignControl,
  type CampaignMembership,
  controlGroupOf,
  type HoldoutResult,
  holdoutVerdict,
  moneyMap,
  pct,
  points,
  signedPercent,
} from './model';

// The campaign's own assignment cohort (#500). A campaign control group is measured once for the
// whole campaign; the report never merges campaigns and never presents a subject test as uplift.

type ControlRead =
  | { campaign: CampaignMembership; control: CampaignControl; error: null }
  | { campaign: CampaignMembership; control: null; error: string | null };

export function useCampaignControls(campaigns: CampaignMembership[]) {
  const key = campaigns.map((campaign) => campaign.id).join(',');
  return useApi<ControlRead[]>(async () => {
    return Promise.all(
      campaigns.map(async (campaign): Promise<ControlRead> => {
        try {
          let artifact = await api.call('artifacts.get', { artifactId: campaign.id });
          if (artifact.publishedVersion === null) {
            return { campaign, control: null, error: null };
          }
          // Edition after publishing keeps the live control group authoritative; the draft's
          // control is never used for measurement.
          if (artifact.version.number !== artifact.publishedVersion) {
            artifact = await api.call('artifacts.get', { artifactId: campaign.id, version: artifact.publishedVersion });
          }
          return { campaign, control: controlGroupOf(artifact.version.content), error: null };
        } catch (error) {
          return { campaign, control: null, error: errText(error) };
        }
      }),
    );
  }, [key]);
}

const rateText = (rate: number, entered: number) => (entered > 0 ? pct(rate) : 'Unavailable');

function ArmCells({ arm }: { arm: HoldoutResult['control'] }) {
  return (
    <>
      <Td align="right">{arm.entered.toLocaleString()}</Td>
      <Td align="right">{arm.converted.toLocaleString()}</Td>
      <Td align="right">{rateText(arm.conversionRate, arm.entered)}</Td>
      <Td align="right">{arm.unsubscribed.toLocaleString()}</Td>
      <Td align="right">{rateText(arm.unsubscribeRate, arm.entered)}</Td>
      <Td align="right">{moneyMap(arm.revenue)}</Td>
    </>
  );
}

function CampaignHoldoutResult({
  campaign,
  result,
  loading,
  error,
  onRetry,
}: {
  campaign: CampaignMembership;
  result: HoldoutResult | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (error)
    return (
      <Alert tone="bad" title="Campaign holdout unavailable" onRetry={onRetry}>
        {error}
      </Alert>
    );
  if (loading || !result) return <LoadingBlock lines={5} label="Loading the campaign holdout" />;

  const verdict = holdoutVerdict(result);
  const interval = result.ci95 ? `${points(result.ci95[0])} to ${points(result.ci95[1])}` : 'Unavailable';
  const assignmentPeriod =
    result.from && result.to
      ? `${formatDateTime(result.from, { zone: true })} – ${formatDateTime(result.to, { zone: true })}`
      : 'Unavailable';
  const goalEvent = result.goal.event ?? campaign.goal.event ?? 'goal event';

  return (
    <section aria-label={`${campaign.name} campaign-wide holdout`} className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[16px] leading-6 font-semibold">
            <TextLink to={`/marketing/campaigns/${campaign.id}`}>{campaign.name}</TextLink> · Campaign-wide holdout
          </h3>
          <p className="mt-1 text-[12px] leading-[18px] text-muted">
            {result.controlGroup.percent}% control · at least {result.controlGroup.minSampleSize} per arm · {goalEvent} within{' '}
            {result.goal.attributionDays} days
          </p>
        </div>
        <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
      </div>

      <div className="mt-4 overflow-x-auto">
        <Table label={`${campaign.name} holdout by arm`}>
          <THead>
            <tr>
              <Th>Arm</Th>
              <Th align="right">Assigned people</Th>
              <Th align="right">Converted</Th>
              <Th align="right">Conversion</Th>
              <Th align="right">Unsubscribed</Th>
              <Th align="right">Unsubscribe rate</Th>
              <Th align="right">Revenue</Th>
            </tr>
          </THead>
          <tbody>
            <Tr>
              <Td>
                <span className="font-medium text-fg">Control</span>
              </Td>
              <ArmCells arm={result.control} />
            </Tr>
            <Tr>
              <Td>
                <span className="font-medium text-fg">Treatment</span>
              </Td>
              <ArmCells arm={result.treatment} />
            </Tr>
          </tbody>
        </Table>
      </div>

      <p className="mt-3 text-[12px] leading-[18px] text-fg-2">
        <strong>{points(result.absoluteLift)}</strong> absolute lift · {signedPercent(result.relativeLift)} relative lift · 95% interval{' '}
        {interval} · {result.minSampleSizeMet ? 'Minimum sample met' : 'Insufficient sample'}
      </p>
      <p className="mt-1 text-[12px] leading-[18px] text-muted">{result.note}</p>
      <p className="mt-1 text-[12px] leading-[18px] text-muted">
        Assignment period: {assignmentPeriod}. Conversion events follow the campaign attribution window.
      </p>
      <p className="mt-1 text-[12px] leading-[18px] text-muted">
        Campaign-wide; includes other sending members. This does not isolate the broadcast’s effect.
      </p>
    </section>
  );
}

function ControlledCampaignSection({
  campaign,
  control,
  period,
}: {
  campaign: CampaignMembership;
  control: CampaignControl;
  period: LocalDayPeriod;
}) {
  const hasGoal = !!campaign.goal.event;
  const result = useApi(
    () => api.call('campaigns.holdoutResult', { campaignId: campaign.id, from: period.from, to: period.to }),
    [campaign.id, period.from, period.to, hasGoal],
    { skip: !hasGoal },
  );

  if (!hasGoal)
    return (
      <section aria-label={`${campaign.name} campaign-wide holdout`} className="rounded-lg border border-line bg-surface p-4">
        <h3 className="text-[16px] leading-6 font-semibold">
          <TextLink to={`/marketing/campaigns/${campaign.id}`}>{campaign.name}</TextLink> · Campaign-wide holdout
        </h3>
        <p className="mt-1 text-[12px] leading-[18px] text-muted">
          {control.percent}% control{control.minSampleSize !== null ? ` · at least ${control.minSampleSize} per arm` : ''}
        </p>
        <Alert tone="info" className="mt-3" title="No campaign goal event">
          Set a campaign goal event to measure uplift.
        </Alert>
      </section>
    );

  return (
    <CampaignHoldoutResult campaign={campaign} result={result.data} loading={result.loading} error={result.error} onRetry={result.reload} />
  );
}

export function CampaignHoldoutArea({ artifactId, period }: { artifactId: string; period: LocalDayPeriod }) {
  const campaigns = useApi(() => api.call('campaigns.of', { artifactId }), [artifactId]);
  const list = campaigns.data?.campaigns ?? [];
  const controls = useCampaignControls(list);

  if (campaigns.error)
    return (
      <Alert tone="bad" title="Campaign holdout unavailable" onRetry={campaigns.reload}>
        {campaigns.error}
      </Alert>
    );
  if (campaigns.loading) return <LoadingBlock lines={4} label="Loading campaign holdout" />;
  if (!list.length)
    return (
      <Alert tone="info" title="No campaign control group">
        Subject tests do not measure holdout uplift.
      </Alert>
    );
  if (controls.error)
    return (
      <Alert tone="bad" title="Campaign holdout unavailable" onRetry={controls.reload}>
        {controls.error}
      </Alert>
    );
  if (controls.loading || !controls.data) return <LoadingBlock lines={5} label="Loading campaign holdout" />;

  const controlled = controls.data.filter((read): read is Extract<ControlRead, { control: CampaignControl }> => !!read.control);
  const errors = controls.data.filter((read) => read.error);

  if (!controlled.length && !errors.length)
    return (
      <Alert tone="info" title="No campaign control group">
        Subject tests do not measure holdout uplift.
      </Alert>
    );

  return (
    <div className="space-y-4">
      {errors.map((read) => (
        <Alert key={read.campaign.id} tone="bad" title={`${read.campaign.name} holdout unavailable`} onRetry={controls.reload}>
          {read.error}
        </Alert>
      ))}
      {controlled.map((read) => (
        <ControlledCampaignSection key={read.campaign.id} campaign={read.campaign} control={read.control} period={period} />
      ))}
    </div>
  );
}
