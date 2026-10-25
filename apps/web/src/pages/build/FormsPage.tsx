import { Field } from '../../ui';
import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';
import { ArtifactSelect } from '../../features/artifacts/ArtifactSelect';

export default function FormsPage() {
  return (
    <ArtifactListPage<{ confirmationTemplate?: string }>
      type="form"
      title="Forms"
      description="Signup forms with consent text and double opt-in. Your site posts to them; the hosted confirm pages use your brand."
      emptyTitle="No forms yet"
      emptyText="Create a signup form for your newsletter. You need a published confirmation e-mail (with {{ confirm_url }}) for double opt-in."
      create={{
        label: 'New form',
        initial: {},
        fields: (s, set, errors) => (
          <Field label="Confirmation e-mail" hint="Sent for double opt-in; it must contain {{ confirm_url }}. You can change this later." error={errors.confirmationTemplate} required>
            <ArtifactSelect type="email_template" value={s.confirmationTemplate} onChange={(v) => set({ confirmationTemplate: v })} />
          </Field>
        ),
        validate: (s): Record<string, string> => (s.confirmationTemplate ? {} : { confirmationTemplate: 'Choose the confirmation e-mail.' }),
        content: (_n, s) => ({
          purposes: ['marketing_email'],
          doubleOptIn: true,
          confirmationTemplate: s.confirmationTemplate,
          consentText: 'Send me the newsletter. I can unsubscribe at any time.',
          traits: ['firstName'],
          successUrl: '/thanks',
        }),
      }}
    />
  );
}
