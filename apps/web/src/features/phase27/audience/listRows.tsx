import { artifactPath } from '../../../app/artifactRoutes';
import { Link } from '../../../app/router';
import { publicationLabel, stateOfArtifact } from '../../../lib/state';
import { timeAgo } from '../../../ui';
import { OperationalPill } from '../../../ui/state';
import type { ArtifactRow } from '../../artifacts/artifactList';

/** The v2 phone summary for a family list: every desktop field, a named link and its state. */
export function AudiencePhoneRow({ artifact: a }: { artifact: ArtifactRow }) {
  const href = artifactPath(a.type, a.id);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <Link to={href} className="min-w-0 font-medium text-fg hover:underline">
          {a.name}
        </Link>
        <OperationalPill
          state={stateOfArtifact({
            type: a.type,
            latestState: a.latestState,
            latestVersion: a.latestVersion,
            publishedVersion: a.publishedVersion,
          })}
        />
      </div>
      <p className="mt-1 text-[12px] leading-[18px] text-muted">
        {publicationLabel({ latestVersion: a.latestVersion, publishedVersion: a.publishedVersion })}
      </p>
      <p className="mt-0.5 text-[12px] leading-[18px] text-muted">Updated {timeAgo(a.updatedAt)}</p>
    </li>
  );
}

/**
 * The honest count wording for a family list, including the guarded partial load. A list that did
 * not reach the end of the server's rows says how many are loaded rather than implying it is whole.
 */
export function audienceCountLabel(singular: string, plural: string) {
  return ({ total, loaded, shown, complete }: { total: number; loaded: number; shown: number; complete: boolean }) => {
    if (!complete) return `${loaded} of ${total} loaded`;
    if (shown === total) return `${total} ${total === 1 ? singular : plural}`;
    return `${shown} of ${total} ${plural}`;
  };
}
