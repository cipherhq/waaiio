/**
 * Paging for WhatsApp interactive lists.
 *
 * Meta rejects a list with more than 10 rows in total, across all sections
 * (error 131009). When there are more choices than fit, a page shows as many
 * as fit plus a "More" row, and later pages also get a "Previous" row, so every
 * choice stays reachable. Same layout as the capability menu pages in
 * capability-selection.flow.ts.
 */

/** Most rows Meta accepts in one list, across all sections. */
export const LIST_MAX_ROWS = 10;

export const LIST_PAGE_MORE = 'list_page_more';
export const LIST_PAGE_PREV = 'list_page_prev';

export function isListPageNav(input: string): boolean {
  return input === LIST_PAGE_MORE || input === LIST_PAGE_PREV;
}

/** The page to show after a "More" or "Previous" tap. */
export function nextListPage(current: unknown, input: string): number {
  const page = typeof current === 'number' && current > 0 ? current : 0;
  return input === LIST_PAGE_MORE ? page + 1 : Math.max(0, page - 1);
}

/**
 * Rows for one page. `fixed` rows (e.g. Checkout, Back) open every page; the
 * "Previous" row follows them on later pages and the "More" row closes every
 * page but the last. A page number past the end shows the last page.
 */
export function pageListRows<T>(
  rows: T[],
  page: unknown,
  nav: { prev: T; more: T; fixed?: T[] },
): { rows: T[]; page: number; totalPages: number } {
  const fixed = nav.fixed || [];
  const capacity = LIST_MAX_ROWS - fixed.length;
  // A page needs room for Previous, More and at least one row
  if (capacity < 3) throw new Error(`pageListRows: ${fixed.length} fixed rows leave no room to page`);
  if (rows.length <= capacity) return { rows: [...fixed, ...rows], page: 0, totalPages: 1 };

  const pages: Array<[number, number]> = [];
  let idx = 0;
  while (idx < rows.length) {
    const slots = capacity - (pages.length === 0 ? 0 : 1);
    // Last page: everything left fits without a "More" row
    if (rows.length - idx <= slots) {
      pages.push([idx, rows.length]);
      break;
    }
    pages.push([idx, idx + slots - 1]);
    idx += slots - 1;
  }

  const requested = typeof page === 'number' && page > 0 ? Math.floor(page) : 0;
  const current = Math.min(requested, pages.length - 1);
  const [start, end] = pages[current];
  return {
    rows: [
      ...fixed,
      ...(current > 0 ? [nav.prev] : []),
      ...rows.slice(start, end),
      ...(current < pages.length - 1 ? [nav.more] : []),
    ],
    page: current,
    totalPages: pages.length,
  };
}
