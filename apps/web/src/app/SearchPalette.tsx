import { Bot, FileText, Search, Settings2, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchAllArtifacts } from '../features/artifacts/artifactList';
import { Badge, cx, StatePill, Tag } from '../ui';
import { useFocusTrap } from '../ui/focus';
import { api, type Out } from './api';
import { artifactPath, typeLabel } from './artifactRoutes';
import { CREATE_ACTIONS, STARTER_ACTION } from './createIntent';
import { visibleNav } from './nav';
import { clearRecents, getRecents, type Recent } from './recents';
import { navigate } from './router';
import { useSession } from './session';

type Artifact = Out<'artifacts.list'>['artifacts'][number];
type Agent = Out<'agents.list'>['agents'][number];

interface Result {
  key: string;
  label: string;
  hint: string;
  to: string;
  /** The text a query matches, lower-cased once. */
  search: string;
  /** Exact-id match, when the entry has one. */
  id?: string;
  state?: Artifact['latestState'];
  icon?: typeof FileText;
  kind: 'action' | 'page' | 'artifact' | 'recent';
}

interface Section {
  label: string;
  results: Result[];
}

/**
 * Global search (#446): ⌘K or `/` opens one labelled combobox. With no query it shows recents,
 * Create actions (same order and gate as New), the permitted destinations plus Settings, then
 * Preferences. A query groups Actions, Pages and Artifacts. Pages and actions work while the
 * artifact search is loading or failing; nothing here mutates, and a create action opens a dialog.
 */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { can } = useSession();
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [recentEntries, setRecentEntries] = useState<Recent[]>(() => getRecents());
  const [active, setActive] = useState(0);
  useFocusTrap(ref, true, onClose);

  useEffect(() => {
    if (!can('artifacts:read')) {
      setArtifacts([]);
      setAgents([]);
      return;
    }
    fetchAllArtifacts()
      .then((r) => setArtifacts(r.artifacts))
      .catch(() => {
        setArtifacts([]);
        setErr('failed');
      });
    api
      .call('agents.list', {})
      .then((r) => setAgents(r.agents))
      .catch(() => setAgents([]));
  }, [can]);

  const artifactById = useMemo(() => new Map((artifacts ?? []).map((a) => [a.id, a])), [artifacts]);
  const agentById = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);

  const recents = useMemo<Result[]>(() => {
    const results: Result[] = [];
    for (const recent of recentEntries) {
      if (recent.kind === 'artifact') {
        const a = artifactById.get(recent.id);
        if (!a) continue;
        results.push({
          key: `recent:artifact:${a.id}`,
          label: a.name,
          hint: typeLabel(a.type),
          to: artifactPath(a.type, a.id),
          search: '',
          state: a.latestState,
          icon: FileText,
          kind: 'recent',
        });
      } else if (recent.kind === 'agent') {
        if (!can('artifacts:read')) continue;
        const a = agentById.get(recent.id);
        if (!a) continue;
        results.push({
          key: `recent:agent:${a.id}`,
          label: a.name,
          hint: 'Agent',
          to: `/work/agents/${encodeURIComponent(a.id)}`,
          search: '',
          icon: Bot,
          kind: 'recent',
        });
      } else {
        if (!can('profiles:read')) continue;
        results.push({
          key: `recent:person:${recent.id}`,
          label: 'Person',
          hint: 'Recent',
          to: `/audience/people/${encodeURIComponent(recent.id)}`,
          search: '',
          icon: UserRound,
          kind: 'recent',
        });
      }
      if (results.length === 6) break;
    }
    return results;
  }, [recentEntries, artifactById, agentById, can]);

  const createResults = useMemo<Result[]>(() => {
    if (!can('artifacts:write')) return [];
    return [
      ...CREATE_ACTIONS.map((action) => ({
        key: `create:${action.type}`,
        label: action.paletteLabel,
        hint: 'Create',
        to: action.to,
        search: `${action.paletteLabel} ${action.type} create`.toLowerCase(),
        icon: action.icon,
        kind: 'action' as const,
      })),
      {
        key: 'create:starter',
        label: STARTER_ACTION.paletteLabel,
        hint: 'Library',
        to: STARTER_ACTION.to,
        search: `${STARTER_ACTION.paletteLabel} starter library create`.toLowerCase(),
        icon: STARTER_ACTION.icon,
        kind: 'action' as const,
      },
    ].slice(0, 10);
  }, [can]);

  const pages = useMemo<Result[]>(() => {
    const items = visibleNav(can).flatMap((g) =>
      g.items.map((i) => ({
        key: `page:${i.path}`,
        label: i.label,
        hint: g.label,
        to: i.path,
        search: `${i.label} ${g.label} ${i.path}`.toLowerCase(),
        icon: i.icon,
        kind: 'page' as const,
      })),
    );
    return [
      ...items,
      {
        key: 'page:/settings',
        label: 'Settings',
        hint: 'Settings',
        to: '/settings',
        search: 'settings /settings'.toLowerCase(),
        icon: Settings2,
        kind: 'page' as const,
      },
    ];
  }, [can]);

  const preferences = useMemo<Result>(
    () => ({
      key: 'page:/preferences',
      label: 'Preferences',
      hint: 'Account',
      to: '/preferences',
      search: 'preferences account theme /preferences'.toLowerCase(),
      icon: Settings2,
      kind: 'page',
    }),
    [],
  );

  const sections = useMemo<Section[]>(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) {
      return [
        ...(recents.length ? [{ label: 'Recents', results: recents }] : []),
        ...(createResults.length ? [{ label: 'Create', results: createResults }] : []),
        { label: 'Go to', results: pages },
        { label: 'Preferences', results: [preferences] },
      ];
    }
    const hit = (r: Result) => r.search.includes(needle) || (r.id ? r.id.toLowerCase() === needle : false);
    const actions = createResults.filter(hit).slice(0, 10);
    const pagesHit = [...pages, preferences].filter(hit).slice(0, 8);
    const arts: Result[] = (artifacts ?? []).map((a) => ({
      key: `artifact:${a.id}`,
      label: a.name,
      hint: typeLabel(a.type),
      to: artifactPath(a.type, a.id),
      search: `${a.name} ${typeLabel(a.type)}`.toLowerCase(),
      id: a.id,
      state: a.latestState,
      icon: FileText,
      kind: 'artifact',
    }));
    return [
      ...(actions.length ? [{ label: 'Actions', results: actions }] : []),
      ...(pagesHit.length ? [{ label: 'Pages', results: pagesHit }] : []),
      ...(arts.filter(hit).slice(0, 20).length ? [{ label: 'Artifacts', results: arts.filter(hit).slice(0, 20) }] : []),
    ];
  }, [q, recents, createResults, pages, preferences, artifacts]);

  const flat = useMemo(() => sections.flatMap((s) => s.results), [sections]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the active result resets on every new query, which the body does not read
  useEffect(() => setActive(0), [q]);

  const go = (r: Result | undefined) => {
    if (!r) return;
    onClose();
    navigate(r.to);
  };

  const clear = () => {
    clearRecents();
    setRecentEntries([]);
    setActive(0);
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
      <div className="am-fade-in absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="am-rise relative w-full max-w-[600px] overflow-hidden rounded-xl border border-line bg-surface shadow-2"
      >
        <div className="flex items-center gap-2 border-b border-line px-3.5">
          <Search size={16} className="text-muted" aria-hidden />
          <input
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls="search-results"
            aria-activedescendant={flat[active] ? `sr-${active}` : undefined}
            aria-label="Search or create"
            placeholder="Search by name, type or action…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, flat.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                go(flat[active]);
              }
            }}
            className="h-12 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted md:text-[14px]"
          />
        </div>
        <div id="search-results" role="listbox" aria-label="Results" className="max-h-[52vh] overflow-y-auto p-1.5">
          {err && <div className="px-3 py-2 text-[12px] text-bad">Couldn’t search artifacts. Pages and actions still work.</div>}
          {!err && artifacts === null && <div className="px-3 py-1 text-[12px] text-muted">Searching artifacts…</div>}
          {q.trim() && flat.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px] text-muted">No matches. Try a name or type.</div>
          )}
          {sections.map((section) => (
            <div key={section.label}>
              <div className="flex items-center gap-2 px-2 pt-2 pb-1">
                <span className="text-[11px] font-medium text-muted">{section.label}</span>
                {section.label === 'Recents' && (
                  <button type="button" onClick={clear} className="ml-auto text-[11px] text-muted hover:text-fg">
                    Clear recents
                  </button>
                )}
              </div>
              {section.results.map((r) => {
                const index = flat.indexOf(r);
                const Icon = r.icon;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the search input handles arrow keys and Enter; options use the active-descendant pattern
                  <div
                    key={r.key}
                    id={`sr-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => go(r)}
                    className={cx(
                      'flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px]',
                      index === active && 'bg-surface-2',
                    )}
                  >
                    {Icon ? <Icon size={16} className="shrink-0 text-muted" aria-hidden /> : <span className="size-4 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate text-fg">{r.label}</span>
                    {r.state && <StatePill state={r.state} />}
                    {r.kind === 'page' && <Badge tone="neutral">{r.hint}</Badge>}
                    {r.kind !== 'page' && <Tag>{r.hint}</Tag>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[11px] text-muted">
          <span>↑ ↓ Move</span>
          <span>↵ Open</span>
          <span>Esc Close</span>
          <span className="ml-auto">
            {flat.length} result{flat.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
