import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, errText, type In } from '../../app/api';
import type { Autonomy } from './labels';

/** Only the keys that changed; the server merges them into the stored settings. */
export type AutonomyPatch = In<'workspace.setAutonomy'>;

interface AutonomyValue {
  settings: Autonomy | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  save: (patch: AutonomyPatch) => Promise<Autonomy>;
}

const AutonomyContext = createContext<AutonomyValue | null>(null);

/**
 * The workspace autonomy settings, loaded once for the shell and the Agents page. The top-bar
 * badge reads the same value, so a save on the page updates the badge at once (#215).
 */
export function AutonomyProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Autonomy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await api.call('workspace.autonomy', {}));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<AutonomyValue>(
    () => ({
      settings,
      loading,
      error,
      reload,
      save: async (patch) => {
        const next = await api.call('workspace.setAutonomy', patch);
        setSettings(next);
        setError(null);
        return next;
      },
    }),
    [settings, loading, error, reload],
  );

  return <AutonomyContext.Provider value={value}>{children}</AutonomyContext.Provider>;
}

export function useAutonomy(): AutonomyValue {
  const ctx = useContext(AutonomyContext);
  if (!ctx) throw new Error('useAutonomy outside AutonomyProvider');
  return ctx;
}
