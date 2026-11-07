import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// DNS records are long values to reuse, not table text. Each record gets its own named copy control
// so a failed copy exposes the supplied record selectively and never a generated fix.

export function CopyRecord({ value, name }: { value: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
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
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      <button
        type="button"
        onClick={copy}
        className="inline-flex min-h-10 items-center gap-1 rounded-sm text-[12px] leading-[18px] text-fg-2 underline-offset-2 hover:underline pointer-coarse:min-h-10 md:min-h-0"
      >
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        Copy {name}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? `${name} copied` : failed ? `Could not copy ${name}` : ''}
      </span>
      {failed && <code className="min-w-0 break-all font-mono text-[11px] text-fg-2 select-all">{value}</code>}
    </span>
  );
}
