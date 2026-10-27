import { cx } from './cx';

/**
 * Page width tokens (#114). One place defines how wide a page may get, so screens pick a width
 * instead of hard-coding `max-w-[…]`. The Shell no longer caps the page; a page uses
 *
 *   <div className={pageWidth('default')}>…</div>
 *
 * `reading` only applies from 1280 px, so phones and tablets keep the width they had.
 */
export const PAGE_WIDTHS = {
  /** Prose and forms: a comfortable line length, left-aligned. */
  reading: 'xl:max-w-[760px]',
  /** Lists and data pages: use most of a wide window. */
  default: 'xl:max-w-[1600px]',
  /** Editors and canvases: no cap at all. */
  full: 'max-w-none',
} as const;

export type PageWidth = keyof typeof PAGE_WIDTHS;

export function pageWidth(width: PageWidth = 'default', className?: string) {
  return cx('w-full', PAGE_WIDTHS[width], className);
}
