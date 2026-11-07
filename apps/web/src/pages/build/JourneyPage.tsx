import { setSearchParam, useLocation } from '../../app/router';
import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { CampaignMembership } from '../../features/artifacts/CampaignMembership';
import { JourneyBuilder } from '../../features/journey/Builder';
import { JourneyReport } from '../insights/JourneyStatsPage';

const TABS = new Set(['content', 'preview', 'versions', 'activity', 'report']);

/**
 * A journey's page. Its Report tab holds what Insights → Journey stats used to show (Phase 24): the
 * old `/insights/journeys?journey=` links redirect to `?tab=report` here.
 */
export default function JourneyPage({ params }: { params: Record<string, string> }) {
  const { search } = useLocation();
  const urlTab = search.get('tab');
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'Journeys', to: '/marketing/journeys' }]}
      wide
      autosave
      description={<CampaignMembership artifactId={params.id} />}
      editor={(p) => <JourneyBuilder {...p} />}
      extraTabs={[{ key: 'report', label: 'Report', render: (a) => <JourneyReport journeyId={a.id} active={urlTab === 'report'} /> }]}
      tab={urlTab && TABS.has(urlTab) ? urlTab : 'content'}
      onTabChange={(tab) => setSearchParam('tab', tab === 'content' ? null : tab)}
    />
  );
}
