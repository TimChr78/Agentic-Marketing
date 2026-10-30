import { useCrumbs } from '../../app/page';
import { EmailProviders } from '../../features/providers/EmailProviders';
import { OtherProviders } from '../../features/providers/OtherProviders';
import { PageHeader } from '../../ui';
import { pageWidth } from '../../ui/layout';

export default function ProvidersPage() {
  useCrumbs([{ label: 'Providers' }]);
  return (
    <div className={pageWidth('default', 'space-y-5')}>
      <PageHeader
        title="Providers"
        description="Services that deliver your messages and run AI steps. Credentials are encrypted and can be replaced, never read back."
      />
      <EmailProviders />
      <OtherProviders />
    </div>
  );
}
