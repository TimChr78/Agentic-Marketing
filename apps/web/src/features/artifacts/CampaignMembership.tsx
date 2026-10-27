import { api } from '../../app/api';
import { TextLink } from '../../app/links';
import { useApi } from '../../app/useApi';

/** "Part of campaign X" for a broadcast or journey, from campaigns.of (#65). Renders nothing when it is in none. */
export function CampaignMembership({ artifactId }: { artifactId: string }) {
  const of = useApi(() => api.call('campaigns.of', { artifactId }), [artifactId]);
  const campaigns = of.data?.campaigns ?? [];
  if (!campaigns.length) return null;
  return (
    <span>
      Part of campaign{' '}
      {campaigns.map((c, i) => (
        <span key={c.id}>
          {i > 0 && (i === campaigns.length - 1 ? ' and ' : ', ')}
          <TextLink to={`/build/campaigns/${c.id}`}>{c.name}</TextLink>
        </span>
      ))}
    </span>
  );
}
