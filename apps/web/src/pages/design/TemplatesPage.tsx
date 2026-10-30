import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';

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

export default function TemplatesPage() {
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
