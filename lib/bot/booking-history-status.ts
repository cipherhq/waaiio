/** Customer-facing status from the current booking record. */
export function bookingHistoryStatus(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Pending', confirmed: 'Confirmed', cancelled: 'Cancelled',
    checked_in: 'Checked in', checked_out: 'Checked out',
    in_progress: 'In progress', completed: 'Completed', no_show: 'No show',
  };
  return labels[status] || status || 'Unknown';
}

/** Keep every history item while respecting WhatsApp’s ten-row list limit. */
export function bookingHistoryPages<T>(items: T[]): T[][] {
  const pages: T[][] = [];
  for (let offset = 0; offset < items.length; offset += 10) pages.push(items.slice(offset, offset + 10));
  return pages;
}

/** A cancellation between reads must not duplicate a record in the menu. */
export function mergeBookingHistory<T extends { id: string }>(active: T[], cancelled: T[]): T[] {
  return [...new Map([...active, ...cancelled].map(record => [record.id, record])).values()];
}
