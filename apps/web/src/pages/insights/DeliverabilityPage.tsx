import { useCrumbs } from '../../app/page';
import { DeliverabilityView } from '../../features/deliverability/DeliverabilityView';
import { PageHeader } from '../../ui';
import { pageWidth } from '../../ui/layout';

/** Deliverability (#508): can this stream send safely under current policy, before DNS configuration? */
export default function DeliverabilityPage() {
  useCrumbs([{ label: 'Deliverability' }]);
  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Deliverability"
        description="Can this stream send safely under current policy? Bounce and complaint rates use today’s thresholds, not historic pause decisions; the DNS checks show the fix beside each failure."
      />
      <DeliverabilityView />
    </div>
  );
}
