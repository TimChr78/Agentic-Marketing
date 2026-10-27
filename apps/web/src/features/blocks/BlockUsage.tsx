import { api } from '../../app/api';
import { Link } from '../../app/router';
import { useApi } from '../../app/useApi';
import { Alert, LoadingBlock } from '../../ui';

/** "Used by N templates", so a reviewer sees what publishing a block change affects. */
export function BlockUsage({ artifactId }: { artifactId: string }) {
  const usage = useApi(() => api.call('blocks.usage', { artifactId }), [artifactId]);
  if (usage.loading) return <LoadingBlock lines={2} label="Looking up where the block is used" />;
  if (usage.error)
    return (
      <Alert tone="bad" onRetry={usage.reload}>
        {usage.error}
      </Alert>
    );
  const templates = usage.data?.templates ?? [];
  return (
    <section aria-label="Used by" className="rounded-lg border border-line bg-surface-2 px-4 py-3">
      <p className="text-[13px] font-medium">
        Used by {templates.length} {templates.length === 1 ? 'template' : 'templates'}
      </p>
      {templates.length === 0 ? (
        <p className="mt-1 text-[12px] text-muted">Nothing uses this block yet.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {templates.map((t) => (
            <li key={t.artifactId} className="text-[13px]">
              <Link to={`/design/templates/${t.artifactId}`} className="text-fg hover:underline">
                {t.name}
              </Link>{' '}
              <span className="text-muted">
                {t.usesPublished ? `live v${t.publishedVersion}` : 'draft'} · latest v{t.latestVersion}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
