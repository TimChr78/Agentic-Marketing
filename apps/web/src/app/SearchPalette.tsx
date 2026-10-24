import { FileText, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx, StatePill, Tag } from '../ui';
import { useFocusTrap } from '../ui/focus';
import { api, errText, type Out } from './api';
import { artifactPath, typeLabel } from './artifactRoutes';
import { visibleNav } from './nav';
import { navigate } from './router';
import { useSession } from './session';

type Artifact = Out<'artifacts.list'>['artifacts'][number];
interface Result {
  key: string;
  label: string;
  hint: string;
  to: string;
  state?: Artifact['latestState'];
  page?: boolean;
}

/** Global search (#34): artifacts by name and type, and pages. ⌘K or / opens it. */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { can } = useSession();
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  useFocusTrap(ref, true, onClose);

  useEffect(() => {
    if (!can('artifacts:read')) return setItems([]);
    api
      .call('artifacts.list', { limit: 200 })
      .then((r) => setItems(r.artifacts))
      .catch((e) => setErr(errText(e)));
  }, [can]);

  const results = useMemo<Result[]>(() => {
    const needle = q.trim().toLowerCase();
    const pages: Result[] = visibleNav(can).flatMap((g) =>
      g.path ? [{ key: g.path, label: g.label, hint: 'Page', to: g.path, page: true }] : g.items.map((i) => ({ key: i.path, label: i.label, hint: g.label, to: i.path, page: true })),
    );
    const arts: Result[] = (items ?? []).map((a) => ({ key: a.id, label: a.name, hint: typeLabel(a.type), to: artifactPath(a.type, a.id), state: a.latestState }));
    if (!needle) return [...arts.slice(0, 8), ...pages.slice(0, 6)];
    const hit = (r: Result) => r.label.toLowerCase().includes(needle) || r.hint.toLowerCase().includes(needle) || r.key.toLowerCase() === needle;
    return [...arts.filter(hit).slice(0, 20), ...pages.filter(hit).slice(0, 8)];
  }, [q, items, can]);

  useEffect(() => setActive(0), [q]);
  const go = (r: Result | undefined) => {
    if (!r) return;
    onClose();
    navigate(r.to);
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-3 pt-[12vh]">
      <div className="am-fade-in absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Search" className="am-rise relative w-full max-w-[600px] overflow-hidden rounded-xl border border-line bg-surface shadow-2">
        <div className="flex items-center gap-2 border-b border-line px-3.5">
          <Search size={16} className="text-muted" aria-hidden />
          <input
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls="search-results"
            aria-activedescendant={results[active] ? `sr-${results[active].key}` : undefined}
            aria-label="Search artifacts and pages"
            placeholder="Search by name or type, e.g. “welcome” or “segment”"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                go(results[active]);
              }
            }}
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
          />
        </div>
        <ul id="search-results" role="listbox" aria-label="Results" className="max-h-[52vh] overflow-y-auto p-1.5">
          {err && <li className="px-3 py-2 text-[13px] text-bad">{err}</li>}
          {items === null && !err && <li className="px-3 py-2 text-[13px] text-muted">Loading…</li>}
          {items !== null && results.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">Nothing matches “{q}”.</li>}
          {results.map((r, i) => (
            <li
              key={r.key}
              id={`sr-${r.key}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
              className={cx('flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px]', i === active && 'bg-surface-2')}
            >
              {r.page ? <span className="size-4 shrink-0" /> : <FileText size={16} className="shrink-0 text-muted" aria-hidden />}
              <span className="min-w-0 flex-1 truncate text-fg">{r.label}</span>
              {r.state && <StatePill state={r.state} />}
              <Tag>{r.hint}</Tag>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
