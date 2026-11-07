import { CampaignEvaluationView } from '../campaigns/phase26/CampaignEvaluationView';
import type { CampaignSummary as Summary } from '../campaigns/phase26/model';

// The campaign page's Evaluation tab (#511). The existing host export keeps its name and
// `{campaignId}` shape; the optional `from`/`to`/`active` let the host share one period with the
// campaign-wide holdout and mount both only while the tab is active.

export function CampaignEvaluation({
  campaignId,
  from,
  to,
  active = true,
  refreshKey = 0,
}: {
  campaignId: string;
  from?: string;
  to?: string;
  active?: boolean;
  refreshKey?: number;
}) {
  return <CampaignEvaluationView campaignId={campaignId} from={from} to={to} active={active} refreshKey={refreshKey} />;
}

export type { Summary };
