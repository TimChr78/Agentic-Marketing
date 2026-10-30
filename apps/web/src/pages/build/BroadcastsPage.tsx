import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';
import { ArtifactSelect } from '../../features/artifacts/ArtifactSelect';
import { Field } from '../../ui';

export default function BroadcastsPage() {
  return (
    <ArtifactListPage<{ template?: string; segment?: string }>
      type="broadcast"
      title="Broadcasts"
      description="One-off sends to a segment, such as the weekly newsletter. Each one is reviewed before it goes out."
      emptyTitle="No broadcasts yet"
      emptyText="Create one to send a published e-mail template to a segment, now or at a set time. Agents can draft broadcasts too."
      create={{
        label: 'New broadcast',
        initial: {},
        fields: (s, set, errors) => (
          <>
            <Field label="Template" error={errors.template} required>
              <ArtifactSelect type="email_template" value={s.template} onChange={(v) => set({ ...s, template: v })} />
            </Field>
            <Field label="Segment" error={errors.segment} required>
              <ArtifactSelect type="segment" value={s.segment} onChange={(v) => set({ ...s, segment: v })} />
            </Field>
          </>
        ),
        validate: (s) => ({
          ...(s.template ? {} : { template: 'Choose the e-mail to send.' }),
          ...(s.segment ? {} : { segment: 'Choose who gets it.' }),
        }),
        content: (_n, s) => ({ template: s.template, segment: s.segment }),
      }}
    />
  );
}
