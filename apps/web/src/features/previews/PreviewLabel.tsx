import { cx } from '../../ui';
import { type PreviewSource, previewLabelText } from './previewSource';

/**
 * Says which source a preview shows, above the rendered output (Phase 25, #499). It is text, not
 * a hover hint or a decoration around the frame, so it is readable without pointing or opening.
 */
export function PreviewLabel({
  source,
  suffix,
  className,
}: {
  source: PreviewSource;
  /** Context after the source, e.g. "Under review" or "In this bundle". */
  suffix?: string;
  className?: string;
}) {
  const { primary, secondary } = previewLabelText(source, suffix);
  return (
    <p data-preview-source={source.kind} className={cx('text-[12px] leading-[18px] text-fg-2', className)}>
      <span className="font-medium text-fg">{primary}</span>
      {secondary && <span className="text-muted"> · {secondary}</span>}
    </p>
  );
}
