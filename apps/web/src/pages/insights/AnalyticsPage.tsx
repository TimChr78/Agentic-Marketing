import { useCrumbs } from '../../app/page';
import { usePageTab } from '../../app/useTab';
import AnalyticsPerformance from '../../features/analytics/phase26/AnalyticsPerformance';
import { Alert, Tabs } from '../../ui';
import { pageWidth } from '../../ui/layout';
import AiUsagePage from './AiUsagePage';

const ANALYTICS_TABS = ['performance', 'ai'] as const;
type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

const ANALYTICS_TAB_ITEMS: { key: AnalyticsTab; label: string }[] = [
  { key: 'performance', label: 'Performance' },
  { key: 'ai', label: 'AI usage' },
];

/** Insights → Analytics (#446, #506): the fixed-question report and the AI usage report as named tabs. */
export default function AnalyticsPage() {
  const { active, invalid, select } = usePageTab({ keys: ANALYTICS_TABS, fallback: 'performance' });
  useCrumbs([{ label: active === 'ai' ? 'AI usage' : 'Analytics' }]);

  return (
    <div className={pageWidth('default')}>
      {invalid && (
        <Alert tone="info" className="mb-4">
          This tab is unavailable.
        </Alert>
      )}
      <Tabs items={ANALYTICS_TAB_ITEMS} value={active} onChange={select} label="Analytics">
        {active === 'ai' ? <AiUsagePage /> : <AnalyticsPerformance />}
      </Tabs>
    </div>
  );
}
