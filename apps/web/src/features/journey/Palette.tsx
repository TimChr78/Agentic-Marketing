import { Search } from 'lucide-react';
import { useState } from 'react';
import { Button, cx, Field, Input } from '../../ui';
import { CATEGORIES, KINDS, type NodeKind, PALETTE_ORDER } from './model';

export const DND_TYPE = 'application/x-am-node-kind';

/**
 * Step palette (#33, #528): drag a step onto the canvas, or press it (Enter/Space) to add it after
 * the selected step. Steps stay in the seven existing categories with their category colours,
 * icon, name and short purpose; the search filters that same list locally and never changes which
 * steps exist.
 */
export function Palette({ onAdd, disabled }: { onAdd: (k: NodeKind) => void; disabled?: boolean }) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = (k: NodeKind) => {
    if (!needle) return true;
    const meta = KINDS[k];
    const category = CATEGORIES.find((c) => c.key === meta.category)?.label ?? '';
    return [meta.label, meta.hint, category].some((text) => text.toLowerCase().includes(needle));
  };
  const groups = CATEGORIES.map((category) => ({
    category,
    kinds: PALETTE_ORDER.filter((k) => KINDS[k].category === category.key && matches(k)),
  })).filter((group) => group.kinds.length > 0);

  return (
    <nav aria-label="Steps" className="flex h-full min-h-0 flex-col">
      <div className="px-2 pt-2">
        <Field label="Find a step" className="[&>label]:text-[11px]">
          <div className="relative">
            <Search size={13} aria-hidden className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-7"
              placeholder="Search steps"
              aria-label="Find a step"
            />
          </div>
        </Field>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="px-1.5 pb-2 text-[11px] text-muted">Drag onto the canvas, or press to add after the selected step.</p>
        {groups.length === 0 ? (
          <div className="px-1.5 py-2">
            <p className="text-[12px] leading-[18px] text-muted">No steps match “{query.trim()}”.</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => setQuery('')}>
              Clear search
            </Button>
          </div>
        ) : (
          groups.map(({ category, kinds }) => (
            <div key={category.key} className="mb-3">
              <p className="flex items-center gap-1.5 px-1.5 pb-1 text-[11px] font-medium text-muted">
                <span className="size-2 rounded-sm" style={{ background: `var(--cat-${category.key})` }} aria-hidden />
                {category.label}
              </p>
              <ul className="space-y-0.5">
                {kinds.map((k) => {
                  const meta = KINDS[k];
                  const Icon = meta.icon;
                  return (
                    <li key={k}>
                      <button
                        type="button"
                        draggable={!disabled}
                        disabled={disabled}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(DND_TYPE, k);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onClick={() => onAdd(k)}
                        title={meta.hint}
                        className={cx(
                          'flex min-h-8 w-full cursor-grab items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-2 active:cursor-grabbing',
                          'text-fg-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50',
                        )}
                      >
                        <span
                          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded"
                          style={{
                            color: `var(--cat-${category.key})`,
                            background: `color-mix(in srgb, var(--cat-${category.key}) 14%, transparent)`,
                          }}
                        >
                          <Icon size={13} aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] leading-[18px]">{meta.label}</span>
                          <span className="block truncate text-[11px] leading-4 text-muted">{meta.hint}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </nav>
  );
}
