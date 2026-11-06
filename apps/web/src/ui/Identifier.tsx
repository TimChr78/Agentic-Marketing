import { Check, Copy } from 'lucide-react';
import { type MouseEvent, useEffect, useId, useRef, useState } from 'react';
import { cx } from './cx';

// Identifier (#437, DESIGN.md v2 → Identifier). Secondary metadata only: the short form of an id
// with a copy button. The full value is in the tooltip and the copy button's accessible name, and
// the short form expands to selectable full text on tap. Secrets never use this component.

const SHORTEN_AFTER = 16;

export function shortId(value: string): string {
  return value.length > SHORTEN_AFTER ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function Identifier({
  value,
  label = 'ID',
  className,
}: {
  value: string;
  /** Read by screen readers before the value, e.g. "Profile ID". */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tooltip, setTooltip] = useState(false);
  const tooltipId = useId();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const short = shortId(value);

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const openTooltip = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setTooltip(true), 300);
  };
  const closeTooltip = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setTooltip(false);
  };

  const copy = async (event: MouseEvent<HTMLButtonElement>) => {
    // Inside a clickable table row, copying must not also open the row.
    event.stopPropagation();
    setFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setFailed(true);
      // The failed copy must still leave the person with the exact value to select.
      setExpanded(true);
    }
  };

  return (
    <span className={cx('relative inline-flex min-w-0 max-w-full items-center gap-1.5 text-[12px] leading-[18px] text-fg-2', className)}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setExpanded((current) => !current);
        }}
        onMouseEnter={openTooltip}
        onMouseLeave={closeTooltip}
        onFocus={openTooltip}
        onBlur={closeTooltip}
        onKeyDown={(event) => {
          if (event.key === 'Escape') closeTooltip();
        }}
        aria-expanded={expanded}
        aria-describedby={tooltip ? tooltipId : undefined}
        className={cx(
          'min-w-0 rounded-sm text-left font-mono text-[12px] leading-[18px] text-fg-2 pointer-coarse:min-h-10',
          expanded ? 'break-all whitespace-normal select-all' : 'truncate',
        )}
      >
        {/* The label joins the visible text in the accessible name; the full value stays in the
            tooltip and in the copy button's name, which the spec asks for. */}
        <span className="sr-only">{label}: </span>
        {expanded ? value : short}
      </button>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ID ${value}`}
        title={`Copy ID ${value}`}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg pointer-coarse:size-10"
      >
        {copied ? <Check size={14} strokeWidth={1.75} aria-hidden /> : <Copy size={14} strokeWidth={1.75} aria-hidden />}
      </button>
      {tooltip && !expanded && (
        <span
          role="tooltip"
          id={tooltipId}
          className="absolute top-full left-0 z-[70] mt-1 max-w-[360px] rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] leading-4 break-all text-fg shadow-1"
        >
          {value}
        </span>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? 'ID copied' : failed ? 'Could not copy ID' : ''}
      </span>
      {(copied || failed) && (
        <span
          aria-hidden
          className={cx(
            'absolute -top-7 left-0 z-[70] rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] leading-4 shadow-1',
            failed ? 'text-bad' : 'text-fg-2',
          )}
        >
          {failed ? 'Could not copy ID' : 'ID copied'}
        </span>
      )}
    </span>
  );
}
