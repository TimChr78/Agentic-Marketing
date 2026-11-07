import { createContext, type ReactNode, useContext, useEffect } from 'react';

// A review is "viewed" only when the rendered artifact really succeeded (#498). Each renderer
// reports its own state; the Review panel aggregates them, so a loading or failed preview never
// marks the exact version viewed.

export type PreviewStatus = 'loading' | 'ready' | 'error';

const StatusContext = createContext<((id: string, status: PreviewStatus) => void) | null>(null);

export function PreviewStatusProvider({
  onChange,
  children,
}: {
  onChange: (id: string, status: PreviewStatus) => void;
  children: ReactNode;
}) {
  return <StatusContext.Provider value={onChange}>{children}</StatusContext.Provider>;
}

export function useReportPreviewStatus(id: string, status: PreviewStatus) {
  const report = useContext(StatusContext);
  useEffect(() => {
    report?.(id, status);
  }, [report, id, status]);
}

/** Reports a status without rendering anything (for synchronous renderers). */
export function ReportPreviewStatus({ id, status = 'ready' }: { id: string; status?: PreviewStatus }) {
  useReportPreviewStatus(id, status);
  return null;
}
