import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

// Pages tell the shell their breadcrumb trail (and so the document title).
export interface Crumb {
  label: string;
  to?: string;
}
const Ctx = createContext<(c: Crumb[]) => void>(() => {});

export function CrumbsProvider({ children, onChange }: { children: ReactNode; onChange: (c: Crumb[]) => void }) {
  return <Ctx.Provider value={onChange}>{children}</Ctx.Provider>;
}

/** Sets the breadcrumbs after the nav group (e.g. [{label:'Journeys', to:'/build/journeys'}, {label: name}]). */
export function useCrumbs(crumbs: Crumb[]) {
  const set = useContext(Ctx);
  const key = JSON.stringify(crumbs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content
  useEffect(() => {
    set(crumbs);
    const last = crumbs[crumbs.length - 1]?.label;
    document.title = last ? `${last} · Agentic Marketing` : 'Agentic Marketing';
  }, [key, set]);
}

export function useCrumbState() {
  return useState<Crumb[]>([]);
}
