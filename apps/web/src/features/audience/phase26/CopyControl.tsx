import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// The profile id and an unavailable purpose key are values to copy, not table text. Keeping them
// behind a named control means a screen-reader label never has to repeat hidden personal data.

function CopyValue({
  value,
  label,
  copiedLabel,
  className,
}: {
  value: string;
  /** Visible and accessible name, e.g. "Copy person ID". */
  label: string;
  /** Polite announcement after a successful copy, e.g. "Person ID copied". */
  copiedLabel: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    // Inside a clickable row, a copy must not also open the person.
    event.stopPropagation();
    setFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  };

  return (
    <span className={className}>
      <button
        type="button"
        onClick={copy}
        className="inline-flex min-h-10 items-center gap-1 rounded-sm text-[12px] leading-[18px] text-fg-2 underline-offset-2 hover:underline pointer-coarse:min-h-10 md:min-h-0"
      >
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        {label}
      </button>
      {failed && (
        <code className="ml-1 break-all font-mono text-[11px] text-fg-2 select-all" data-volatile>
          {value}
        </code>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? copiedLabel : failed ? `Could not copy ${label.replace(/^Copy /, '')}` : ''}
      </span>
    </span>
  );
}

export function CopyPersonId({ id }: { id: string }) {
  return <CopyValue value={id} label="Copy person ID" copiedLabel="Person ID copied" />;
}

/** A purpose key whose human name is unavailable, kept behind its own named copy control. */
export function CopyPurposeKey({ purposeKey }: { purposeKey: string }) {
  return <CopyValue value={purposeKey} label={`Copy purpose key ${purposeKey}`} copiedLabel="Purpose key copied" />;
}
