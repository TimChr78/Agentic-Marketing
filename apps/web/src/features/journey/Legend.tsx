import { CATEGORIES } from './model';

export function Legend({ className }: { className?: string }) {
  return (
    <ul aria-label="Step colours" className={className ?? 'flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-fg-2'}>
      {CATEGORIES.map((c) => (
        <li key={c.key} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: `var(--cat-${c.key})` }} aria-hidden />
          {c.label}
        </li>
      ))}
    </ul>
  );
}
