import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from './Button';
import { cx } from './cx';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? 'Copied' : label}
      icon={done ? <Check size={14} /> : <Copy size={14} />}
      onClick={async () => {
        await navigator.clipboard?.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    />
  );
}

/** Read-only code or JSON (DESIGN.md → Code view): mono, scrollable, with a copy button. */
export function CodeView({
  value,
  label,
  maxHeight = 360,
  className,
}: {
  value: string;
  label?: string;
  maxHeight?: number;
  className?: string;
}) {
  return (
    <div className={cx('relative min-w-0 rounded-md border border-line bg-surface-2', className)}>
      {label && <div className="border-b border-line px-3 py-1.5 text-[12px] font-medium text-muted">{label}</div>}
      <div className="absolute top-1 right-1">
        <CopyButton value={value} />
      </div>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: pre has no role that accepts a name; the label names a scrollable code block */}
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code block must be reachable with the keyboard to scroll it
        tabIndex={0}
        aria-label={label ?? 'Code'}
        className="overflow-auto px-3 py-2 pr-10 font-mono text-[12px] leading-[18px] whitespace-pre text-fg"
        style={{ maxHeight }}
      >
        {value}
      </pre>
    </div>
  );
}

export function JsonView({ value, ...p }: { value: unknown; label?: string; maxHeight?: number; className?: string }) {
  return <CodeView value={JSON.stringify(value, null, 2) ?? 'null'} {...p} />;
}
