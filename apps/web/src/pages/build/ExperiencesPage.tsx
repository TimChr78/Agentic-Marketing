import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';

export default function ExperiencesPage() {
  return (
    <ArtifactListPage
      type="experience"
      title="Experiences"
      description="Personalised content for a placement on your site, with variants, targeting and a holdout group."
      emptyTitle="No experiences yet"
      emptyText="Create one for an element on your site marked with data-am-placement, such as a newsletter banner under articles."
      create={{
        label: 'New experience',
        content: () => ({
          placement: 'article-footer',
          description: '',
          variants: [{ id: 'a', name: 'Variant A', weight: 50, content: { html: '<p>Get the newsletter.</p>' } }],
          holdoutPercent: 0,
        }),
      }}
    />
  );
}
