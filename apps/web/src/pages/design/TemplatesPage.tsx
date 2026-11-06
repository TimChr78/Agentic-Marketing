import { useCrumbs } from '../../app/page';
import { usePageTab } from '../../app/useTab';
import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';
import { Alert, Tabs } from '../../ui';
import { pageWidth } from '../../ui/layout';
import BlocksPage from './BlocksPage';

const STARTER = `<mjml>
  <mj-body background-color="#f4f5f7">
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>
        <mj-text font-size="22px" font-weight="700">Headline</mj-text>
        <mj-text font-size="15px" line-height="24px">Hi {{ profile.firstName | default: 'there' }},</mj-text>
        <mj-button href="https://example.com">Read more</mj-button>
        <mj-text font-size="12px" color="#6b7280"><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

export function TemplateList() {
  return (
    <ArtifactListPage
      type="email_template"
      title="E-mail templates"
      description="E-mails in MJML with Liquid placeholders. Edit visually or as code; previews render exactly what is sent."
      emptyTitle="No e-mail templates yet"
      emptyText="Create one for each newsletter issue or automated e-mail. Agents can draft templates too; you review them before they go out."
      create={{
        label: 'New template',
        content: (name) => ({ purpose: 'marketing_email', subject: name, mjml: STARTER, sampleData: { profile: { firstName: 'Ada' } } }),
      }}
    />
  );
}

const TEMPLATE_TABS = ['templates', 'blocks'] as const;
type TemplateTab = (typeof TEMPLATE_TABS)[number];

const TEMPLATE_TAB_ITEMS: { key: TemplateTab; label: string }[] = [
  { key: 'templates', label: 'Templates' },
  { key: 'blocks', label: 'Blocks' },
];

/** Templates (#446): the template gallery and the existing block library as named tabs. */
export default function TemplatesPage() {
  const { active, invalid, select } = usePageTab({ keys: TEMPLATE_TABS, fallback: 'templates' });
  useCrumbs([{ label: active === 'blocks' ? 'Blocks' : 'E-mail templates' }]);

  return (
    <div className={pageWidth('default')}>
      {invalid && (
        <Alert tone="info" className="mb-4">
          This tab is unavailable.
        </Alert>
      )}
      <Tabs items={TEMPLATE_TAB_ITEMS} value={active} onChange={select} label="Templates">
        {active === 'blocks' ? <BlocksPage /> : <TemplateList />}
      </Tabs>
    </div>
  );
}
