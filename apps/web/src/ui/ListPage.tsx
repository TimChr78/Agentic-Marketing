import type { ReactNode } from 'react';
import { Alert, EmptyState, PageHeader } from './display';
import { pageWidth } from './layout';

// The v2 list template (Phase 24, #448). It owns the shared geometry and display states of a data
// list so every family reads the same: one page header with the primary action on the right, the
// filters and count after it, then a single outer-bordered table. Phones get the caller's semantic
// summary list instead of the table (never both), and paging only appears for a ready, non-empty
// page. It never fetches, sorts or offers a table/cards switch; the caller supplies the real read,
// the native table (caption/thead/scope) and the mobile list markup.

/** The display state of a list's read. */
export type PageReadState = 'loading' | 'ready' | 'empty' | 'error' | 'restricted';

/** The body of a non-ready list, or an inline notice above a ready one. */
export interface PageNotice {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}

export interface ListPageProps {
  title: string;
  description: ReactNode;
  /** Primary action, aligned right at desktop; omit for readers without the permission. */
  primaryAction?: ReactNode;
  /** Filter controls, in the order the contract fixes them. */
  filters?: ReactNode;
  /** Count at the right of the filter row, e.g. "47 broadcasts". */
  countLabel?: string;
  state: PageReadState;
  /** Empty, error or restricted copy. A ready page shows it inline (e.g. a failed refresh). */
  notice?: PageNotice;
  /** Replaces the rows while loading; the caller supplies its row skeletons. */
  loadingContent: ReactNode;
  /** The native table, with the caller's caption, thead and scope attributes. */
  desktopTable: ReactNode;
  /** The semantic summary list shown below 768 px instead of the table. */
  mobileList: ReactNode;
  /** Paging footer; rendered only when the page is ready and non-empty. */
  pagination?: ReactNode;
}

/**
 * A data list on the v2 template. The template keeps the header and filters while empty, failed or
 * restricted so the person can retry or change the filter, and never shows a count or create action
 * for a restricted read.
 */
export function ListPage({
  title,
  description,
  primaryAction,
  filters,
  countLabel,
  state,
  notice,
  loadingContent,
  desktopTable,
  mobileList,
  pagination,
}: ListPageProps) {
  const showFilters = state !== 'restricted' && (filters !== undefined || countLabel !== undefined);
  return (
    <div className={pageWidth('default')}>
      <PageHeader title={title} description={description} actions={primaryAction} />
      {showFilters && (
        <div className="flex min-h-10 flex-wrap items-center gap-2">
          {filters}
          {countLabel && <span className="ml-auto text-[12px] leading-[18px] text-muted tabular-nums">{countLabel}</span>}
        </div>
      )}
      <div className="mt-4">
        {state === 'loading' ? (
          <div className="am-frame overflow-hidden rounded-lg border border-line bg-surface" aria-busy="true">
            {loadingContent}
          </div>
        ) : state === 'ready' ? (
          <>
            {notice && (
              <Alert tone="warn" title={notice.title} action={notice.action} className="mb-3">
                {notice.body}
              </Alert>
            )}
            <div className="am-frame overflow-hidden rounded-lg border border-line bg-surface">
              <div className="hidden overflow-x-auto md:block">{desktopTable}</div>
              <div className="md:hidden">{mobileList}</div>
              {pagination && <div className="border-t border-line px-4 py-3">{pagination}</div>}
            </div>
          </>
        ) : (
          <div className="am-frame overflow-hidden rounded-lg border border-line bg-surface">
            {state === 'error' ? (
              <Alert tone="bad" title={notice?.title ?? 'Couldn’t load this list'} action={notice?.action} className="m-3">
                {notice?.body}
              </Alert>
            ) : (
              <EmptyState title={notice?.title ?? ''} action={notice?.action}>
                {notice?.body}
              </EmptyState>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
