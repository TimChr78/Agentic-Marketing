import { Alert, LoadingBlock } from '../../ui';
import type { BlockPin } from '../approvals/bundleSummary';
import { BlockPreview } from './BlockPreview';

/** Everything a nested template renderer needs to honor the reviewed block pins. */
export interface BlockGuard {
  pins: BlockPin[];
  loading: boolean;
  error: string | null;
  /** The combined server render (which always expands published blocks) reproduces every pin. */
  reproducible: boolean;
  /** At least one pin has no exact version to render at all. */
  unavailable: boolean;
  /** The template content the blocks were resolved from, for the withheld-render fallback. */
  templateContent?: unknown;
  templateVersion?: number;
  onRetry: () => void;
}

/**
 * Each reusable block at the exact version a review would use: the bundle override when there is
 * one, otherwise its published version. Shared by the template review and the nested template
 * inside a broadcast review, so both show the same exact block previews and the same unavailable
 * state (#498 review).
 */
export function BundledBlocks({
  pins,
  loading,
  error,
  onRetry,
  showHeading = true,
}: {
  pins: BlockPin[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  showHeading?: boolean;
}) {
  if (!pins.length && !loading && !error) return null;
  return (
    <section aria-labelledby={showHeading ? 'review-blocks-heading' : undefined} className="space-y-3">
      {showHeading && (
        <>
          <h3 id="review-blocks-heading" className="text-[15px] leading-6 font-semibold">
            Reusable blocks
          </h3>
          <p className="text-[12px] leading-[18px] text-muted">
            Each block is shown at the exact version this review would use: the bundle override when there is one, otherwise its published
            version.
          </p>
        </>
      )}
      {loading && <LoadingBlock lines={4} label="Resolving reusable blocks" />}
      {error && !loading && (
        <Alert tone="bad" title="Some reusable blocks could not be read" onRetry={onRetry}>
          {error}
        </Alert>
      )}
      {pins.map((pin) =>
        pin.version == null ? (
          <Alert key={pin.id} tone="bad" title={`Reusable block ${pin.id} is unavailable`}>
            This block has no published version and is not in this bundle, so there is no exact version to render.
          </Alert>
        ) : (
          <BlockPreview
            key={pin.id}
            artifactId={pin.id}
            version={pin.version}
            compact
            source={pin.bundled ? { kind: 'saved', version: pin.version } : { kind: 'published', version: pin.version }}
            {...(pin.bundled ? { sourceSuffix: 'In this bundle' } : {})}
            reportId={`block:${pin.id}`}
          />
        ),
      )}
    </section>
  );
}
