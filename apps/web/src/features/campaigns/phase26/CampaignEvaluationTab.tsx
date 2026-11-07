import { useMemo, useState } from 'react';
import { Button, Field, Select } from '../../../ui';
import { CampaignEvaluation } from '../../artifacts/CampaignEvaluation';
import { periodDateLabel, reportPeriod } from '../../broadcasts/period';
import { CampaignHoldoutCard } from '../CampaignHoldoutCard';
import type { CampaignArtifactView, PeriodChoice } from './model';

// The Evaluation tab host for #511. It owns the one period selector and the refresh, then passes
// the same `from`/`to` to the summary and the campaign-wide holdout so neither can drift into a
// different period. `active` keeps both unmounted (and read-free) when the tab is not showing.

export function CampaignEvaluationTab({
  campaignId,
  artifact,
  active = true,
}: {
  campaignId: string;
  artifact?: CampaignArtifactView;
  active?: boolean;
}) {
  const [choice, setChoice] = useState<PeriodChoice>(7);
  const [anchor, setAnchor] = useState(() => new Date());
  const [refreshKey, setRefreshKey] = useState(0);
  const period = useMemo(() => reportPeriod(choice, anchor), [choice, anchor]);

  if (!active) return null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
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
            setRefreshKey((value) => value + 1);
          }}
        >
          Refresh
        </Button>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        Showing {periodDateLabel(period)} in {period.zone}.
      </p>
      <CampaignEvaluation campaignId={campaignId} from={period.from} to={period.to} active refreshKey={refreshKey} />
      <CampaignHoldoutCard campaignId={campaignId} from={period.from} to={period.to} active refreshKey={refreshKey} artifact={artifact} />
    </div>
  );
}
