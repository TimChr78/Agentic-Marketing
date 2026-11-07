import { CampaignHoldoutView } from './phase26/CampaignHoldoutView';
import type { CampaignArtifactView } from './phase26/model';

// The campaign's own holdout card (#67, Phase 26 #511). It stays `CampaignHoldoutCard({campaignId})`
// for existing hosts; the optional `from`/`to`/`active` share the evaluation period and the active
// state, and an optional host artifact avoids a duplicate artifacts.get.

export function CampaignHoldoutCard({
  campaignId,
  from,
  to,
  active = true,
  refreshKey = 0,
  artifact,
}: {
  campaignId: string;
  from?: string;
  to?: string;
  active?: boolean;
  refreshKey?: number;
  artifact?: CampaignArtifactView;
}) {
  return <CampaignHoldoutView campaignId={campaignId} from={from} to={to} active={active} refreshKey={refreshKey} artifact={artifact} />;
}
