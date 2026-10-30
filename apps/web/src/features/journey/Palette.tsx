import { CATEGORIES, KINDS, type NodeKind, PALETTE_ORDER } from './model';

export const DND_TYPE = 'application/x-am-node-kind';

/**
 * Step palette (#33): drag a step onto the canvas, or press it (Enter/Space) to add it after the
 * selected step. Grouped by category, in the category colours.
 */
export function Palette({ onAdd, disabled }: { onAdd: (k: NodeKind) => void; disabled?: boolean }) {
  return (
    <nav aria-label="Steps" className="h-full overflow-y-auto p-2">
      <p className="px-1.5 pb-2 text-[11px] text-muted">Drag onto the canvas, or press to add after the selected step.</p>
      {CATEGORIES.map((c) => {
        const kinds = PALETTE_ORDER.filter((k) => KINDS[k].category === c.key);
        return (
          <div key={c.key} className="mb-3">
            <p className="flex items-center gap-1.5 px-1.5 pb-1 text-[11px] font-medium text-muted">
              <span className="size-2 rounded-sm" style={{ background: `var(--cat-${c.key})` }} aria-hidden />
              {c.label}
            </p>
            <ul className="space-y-0.5">
              {kinds.map((k) => {
                const m = KINDS[k];
                const Icon = m.icon;
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
                      title={m.hint}
                      className="flex h-8 w-full cursor-grab items-center gap-2 rounded-md px-1.5 text-left text-[13px] text-fg-2 hover:bg-surface-2 hover:text-fg active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span
                        className="flex size-6 shrink-0 items-center justify-center rounded"
                        style={{ color: `var(--cat-${c.key})`, background: `color-mix(in srgb, var(--cat-${c.key}) 14%, transparent)` }}
                      >
                        <Icon size={13} aria-hidden />
                      </span>
                      {m.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
