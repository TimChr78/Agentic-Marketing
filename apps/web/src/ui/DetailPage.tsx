import type { ReactNode } from 'react';
import { Alert, EmptyState } from './display';
import type { PageNotice, PageReadState } from './ListPage';
import { pageWidth } from './layout';
import { DetailSkeleton, Skeleton } from './Skeleton';
import { Tabs } from './tabs';

// The v2 detail template (Phase 24, #448). It owns the shared geometry of a detail page: one h1
// with its kind and operational pill, the metadata line, the primary action on the right, the
// consequence inset before the tabs, the selected panel and the context panel. Primary content is
// 800 px with a 320 px context beside it at 1280 px and wider; below that the context follows the
// panel. Only the selected panel is mounted. The template never fetches, mutates or decides which
// action is primary; the caller supplies every node.

export interface DetailPageTab {
  key: string;
  label: string;
  panel: ReactNode;
}

export interface DetailPageProps {
  title: string;
  /** The family's words, e.g. "Broadcast". */
  kind: string;
  /** The operational pill, already derived by the family. */
  statePill?: ReactNode;
  /** Publication/author/identifier metadata, after the kind and pill. */
  metadata: ReactNode;
  /** Exactly one primary action, chosen by the caller's runtime state. */
  primaryAction?: ReactNode;
  /** Secondary actions, to the left of the primary. */
  secondaryActions?: ReactNode;
  /** The who/when/next inset, before the tabs. */
  consequence: ReactNode;
  tabs: DetailPageTab[];
  activeTab: string;
  onTabChange: (key: string) => void;
  /** Right-hand context at 1280 px and wider, below the panel otherwise. */
  context?: ReactNode;
  state: PageReadState;
  notice?: PageNotice;
  /** Keeps the panel's space while the read is loading. Omit for the shared detail geometry. */
  loadingContent?: ReactNode;
}

function HeaderSkeleton() {
  return (
    <div className="mb-6 space-y-3 lg:mb-8" aria-hidden>
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="h-16 w-full max-w-[800px] rounded-lg" />
    </div>
  );
}

/**
 * A detail page on the v2 template. A loading read keeps the header and consequence space; an
 * error or restricted read replaces the content with its notice and never renders hidden tabs.
 */
export function DetailPage({
  title,
  kind,
  statePill,
  metadata,
  primaryAction,
  secondaryActions,
  consequence,
  tabs,
  activeTab,
  onTabChange,
  context,
  state,
  notice,
  loadingContent,
}: DetailPageProps) {
  if (state === 'loading') {
    if (loadingContent === undefined)
      return (
        <div className={pageWidth('default')}>
          <DetailSkeleton label={`Loading ${title.toLowerCase()}`} />
        </div>
      );
    return (
      <div className={pageWidth('default')}>
        <HeaderSkeleton />
        <div className="am-frame overflow-hidden rounded-lg border border-line bg-surface" aria-busy="true">
          {loadingContent}
        </div>
      </div>
    );
  }

  const header = (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 lg:mb-8">
      <div className="min-w-0 flex-1">
        <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.02em] break-words">{title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-muted">
          {kind && <span>{kind}</span>}
          {statePill}
          {metadata}
        </div>
      </div>
      {state === 'ready' && (primaryAction || secondaryActions) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {secondaryActions}
          {primaryAction}
        </div>
      )}
    </div>
  );

  if (state !== 'ready') {
    return (
      <div className={pageWidth('default')}>
        {header}
        <div className="am-frame overflow-hidden rounded-lg border border-line bg-surface">
          {state === 'error' ? (
            <Alert tone="bad" title={notice?.title ?? 'Couldn’t open this item'} action={notice?.action} className="m-3">
              {notice?.body}
            </Alert>
          ) : (
            <EmptyState title={notice?.title ?? ''} action={notice?.action}>
              {notice?.body}
            </EmptyState>
          )}
        </div>
      </div>
    );
  }

  const selected = tabs.find((tab) => tab.key === activeTab) ?? tabs[0];
  return (
    <div className={pageWidth('default')}>
      {header}
      {consequence && <div className="mb-6">{consequence}</div>}
      <div className={context ? 'grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,800px)_320px] xl:items-start' : undefined}>
        <div className="min-w-0">
          <Tabs
            label="Sections"
            value={selected?.key ?? ''}
            onChange={onTabChange}
            items={tabs.map((tab) => ({ key: tab.key, label: tab.label }))}
          >
            {selected?.panel ?? null}
          </Tabs>
        </div>
        {context && (
          <aside className="min-w-0 rounded-lg bg-surface-2 p-4 xl:p-5" aria-label="Context">
            {context}
          </aside>
        )}
      </div>
    </div>
  );
}
