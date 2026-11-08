import { ChevronDown } from 'lucide-react';
import {
  type AriaAttributes,
  createContext,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useContext,
  useId,
} from 'react';
import { useCapabilities } from '../app/capabilities';
import { cx } from './cx';

// Form controls (DESIGN.md → Components): every control sits in a Field with a visible label,
// optional helper text and unit, and an error line. Field passes ids to its control through
// context, so labels, aria-describedby and aria-invalid are always wired.

interface FieldCtx {
  id: string;
  describedBy?: string;
  invalid: boolean;
}
const FieldContext = createContext<FieldCtx | null>(null);

export interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  /** Shown under the control; keep it to one sentence. */
  hint?: ReactNode;
  error?: string | null;
  /** Unit shown inside the control's right edge, e.g. "MB" or "days". */
  unit?: string;
  required?: boolean;
  /** Visually hide the label (it stays for screen readers). Use only when the context labels it. */
  hideLabel?: boolean;
  className?: string;
  /** Override the generated id (to link from elsewhere). */
  id?: string;
}

export function Field({ label, children, hint, error, unit, required, hideLabel, className, id: idProp }: FieldProps) {
  const auto = useId();
  const id = idProp ?? `f${auto.replace(/:/g, '')}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={id} className={cx('mb-1 block text-[12px] leading-[18px] font-medium text-fg-2', hideLabel && 'sr-only')}>
        {label}
        {required && (
          <span className="ml-0.5 text-muted" aria-hidden>
            *
          </span>
        )}
      </label>
      <FieldContext.Provider value={{ id, describedBy, invalid: !!error }}>
        {unit ? (
          <div className="relative">
            {children}
            <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[12px] text-muted">{unit}</span>
          </div>
        ) : (
          children
        )}
      </FieldContext.Provider>
      {error && (
        <p id={errId} className="mt-1 text-[12px] leading-[18px] text-bad">
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="mt-1 text-[12px] leading-[18px] text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

function useField(p: { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: AriaAttributes['aria-invalid'] }) {
  const f = useContext(FieldContext);
  return {
    id: p.id ?? f?.id,
    'aria-describedby': [p['aria-describedby'], f?.describedBy].filter(Boolean).join(' ') || undefined,
    'aria-invalid': p['aria-invalid'] ?? (f?.invalid || undefined),
  };
}

export const controlClass =
  'w-full rounded-md border border-control bg-surface text-[16px] leading-6 text-fg pointer-coarse:text-[16px] pointer-coarse:leading-6 placeholder:text-muted transition-colors duration-[120ms] hover:border-fg-2 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted aria-[invalid=true]:border-bad read-only:bg-surface-2 md:text-[13px] md:leading-5';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { compact?: boolean }>(function Input(
  { className, compact, ...p },
  ref,
) {
  return (
    <input
      ref={ref}
      {...p}
      {...useField(p)}
      className={cx(
        controlClass,
        compact ? 'h-10 pointer-coarse:h-10 md:h-7' : 'h-10 pointer-coarse:h-10 md:h-8',
        // A caller's left padding (room for a search icon) must win at every breakpoint, so the
        // responsive default only sets the sides the caller leaves alone.
        /(^|\s)pl-/.test(className ?? '') ? (compact ? 'pr-3 md:pr-2' : 'pr-3 md:pr-2.5') : compact ? 'px-3 md:px-2' : 'px-3 md:px-2.5',
        className,
      )}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(function Textarea(
  { className, mono, rows = 4, ...p },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      {...p}
      {...useField(p)}
      className={cx(
        controlClass,
        'min-h-[120px] px-3 py-2 leading-6 pointer-coarse:min-h-[120px] pointer-coarse:px-3 pointer-coarse:py-2 md:min-h-[96px] md:px-3 md:py-2.5 md:leading-5',
        mono && 'font-mono text-[12px] leading-[18px]',
        className,
      )}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & {
    compact?: boolean;
    /** Marks a dropdown that changes data as soon as it changes; disabled with the reason in a restricted surface. */
    mutation?: boolean;
  }
>(function Select({ className, compact, mutation, children, ...p }, ref) {
  const { mutations, reason } = useCapabilities();
  const blocked = mutation === true && !mutations;
  return (
    <div className={cx('relative', className?.includes('w-auto') ? 'inline-block' : 'block')}>
      <select
        ref={ref}
        {...p}
        {...useField(p)}
        title={blocked ? (reason ?? undefined) : p.title}
        aria-description={blocked ? (reason ?? undefined) : undefined}
        data-demo-blocked={blocked || undefined}
        disabled={p.disabled || blocked}
        className={cx(
          controlClass,
          'appearance-none pr-9 md:pr-8',
          compact ? 'h-10 pl-3 pointer-coarse:h-10 md:h-7 md:pl-2' : 'h-10 pl-3 pointer-coarse:h-10 md:h-8 md:pl-2.5',
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted md:right-2.5"
        aria-hidden
      />
    </div>
  );
});

export function Checkbox({
  label,
  hint,
  className,
  ...p
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; hint?: ReactNode }) {
  const auto = useId();
  const id = p.id ?? `c${auto.replace(/:/g, '')}`;
  return (
    <div className={cx('flex min-w-0 items-start gap-2', className)}>
      <input
        {...p}
        id={id}
        type="checkbox"
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-2 size-5 shrink-0 cursor-pointer rounded-sm border-control accent-[var(--accent)] pointer-coarse:size-5 disabled:cursor-not-allowed md:mt-0.5 md:size-4"
      />
      <div className="min-w-0">
        {/* The label itself is a 40 px target on touch layouts; the hint stays outside it, so the
            accessible name is unchanged and only linked through aria-describedby. */}
        <label
          htmlFor={id}
          className="flex min-h-10 cursor-pointer items-start text-[13px] leading-5 text-fg pointer-coarse:min-h-10 md:min-h-0"
        >
          {label}
        </label>
        {hint && (
          <p id={`${id}-hint`} className="text-[12px] leading-[18px] text-muted">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

/** An on/off switch (`role="switch"`). Use for settings that apply at once; use Checkbox inside forms. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  hideLabel,
  id,
  mutation,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  hideLabel?: boolean;
  id?: string;
  /** Marks a switch that changes data; disabled with the reason in a restricted surface. */
  mutation?: boolean;
}) {
  const { mutations, reason } = useCapabilities();
  const blocked = mutation === true && !mutations;
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      title={blocked ? (reason ?? undefined) : undefined}
      aria-description={blocked ? (reason ?? undefined) : undefined}
      data-demo-blocked={blocked || undefined}
      disabled={disabled || blocked}
      onClick={() => onChange(!checked)}
      className="inline-flex min-h-10 min-w-10 items-center gap-2 text-[13px] pointer-coarse:min-h-10 pointer-coarse:min-w-10 disabled:cursor-not-allowed md:min-h-0 md:min-w-0"
    >
      <span
        className={cx(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-[120ms] pointer-coarse:h-5 pointer-coarse:w-9 md:h-[18px] md:w-8',
          checked ? 'border-accent bg-accent' : 'border-control bg-surface-3',
        )}
      >
        <span
          className={cx(
            'absolute size-3.5 rounded-full transition-transform duration-[120ms] pointer-coarse:size-3.5 md:size-3',
            checked ? 'translate-x-[18px] bg-accent-fg md:translate-x-[15px]' : 'translate-x-[2px] bg-fg-2',
          )}
        />
      </span>
      {!hideLabel && <span>{label}</span>}
    </button>
  );
}

/** A fieldset with a legend, for grouping related fields (radio groups, credentials). */
export function FieldGroup({
  legend,
  hint,
  children,
  className,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cx('min-w-0 space-y-3', className)}>
      <legend className="mb-1 text-[12px] font-medium text-fg-2">{legend}</legend>
      {hint && <p className="-mt-2 text-[12px] text-muted">{hint}</p>}
      {children}
    </fieldset>
  );
}

/** Radio cards for a small set of exclusive options (e.g. "Use for"). */
export function RadioCards<T extends string>({
  name,
  value,
  onChange,
  options,
  className,
}: {
  name: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; hint?: string }[];
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cx('grid gap-2 sm:grid-cols-3', className)}>
      {options.map((o) => (
        <label
          key={o.value}
          className={cx(
            'flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 text-[13px] transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
            value === o.value ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-surface-2',
          )}
        >
          <span className="flex items-center gap-2 font-medium">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="accent-[var(--accent)]"
            />
            {o.label}
          </span>
          {o.hint && <span className="pl-5 text-[12px] text-muted">{o.hint}</span>}
        </label>
      ))}
    </div>
  );
}

/**
 * Maps a server validation error (`z.treeifyError` details from `ApiError.details`) to field errors,
 * keyed by dotted path (e.g. "secrets.apiKey"). Unknown shapes return {}.
 */
export function fieldErrors(details: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { errors?: string[]; properties?: Record<string, unknown>; items?: unknown[] };
    if (n.errors?.length && path) out[path] = n.errors.join(' ');
    for (const [k, v] of Object.entries(n.properties ?? {})) walk(v, path ? `${path}.${k}` : k);
    (n.items ?? []).forEach((v, i) => {
      walk(v, path ? `${path}.${i}` : String(i));
    });
  };
  walk(details, prefix);
  return out;
}

/** Top-level messages of a treeified error (not tied to a field). */
export function formErrors(details: unknown): string[] {
  const n = details as { errors?: string[] } | null;
  return Array.isArray(n?.errors) ? n.errors : [];
}
