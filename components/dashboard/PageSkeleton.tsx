'use client';

/**
 * Reusable skeleton loading component for dashboard pages.
 * Shows while data is being fetched — prevents blank screen on slow connections.
 */

export function StatCardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-${count}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-xl border border-gray-100 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
          <div className="h-4 w-24 rounded bg-gray-200 dark:bg-gray-700" />
          <div className="mt-3 h-8 w-16 rounded bg-gray-200 dark:bg-gray-700" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="animate-pulse rounded-xl border border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-800">
      {/* Header */}
      <div className="flex gap-4 border-b border-gray-100 px-5 py-4 dark:border-gray-700">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="h-4 flex-1 rounded bg-gray-200 dark:bg-gray-700" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 border-b border-gray-50 px-5 py-4 last:border-0 dark:border-gray-800">
          {Array.from({ length: cols }).map((_, j) => (
            <div key={j} className="h-4 flex-1 rounded bg-gray-100 dark:bg-gray-700" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Title */}
      <div>
        <div className="h-7 w-48 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="mt-2 h-4 w-72 rounded bg-gray-100 dark:bg-gray-800" />
      </div>
      {/* Stat cards */}
      <StatCardSkeleton />
      {/* Table */}
      <TableSkeleton />
    </div>
  );
}

export function ChatSkeleton() {
  return (
    <div className="flex h-[70vh] animate-pulse rounded-xl border border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-800">
      {/* Sidebar */}
      <div className="w-80 border-r border-gray-100 p-4 space-y-3 dark:border-gray-700">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-700" />
            <div className="flex-1">
              <div className="h-4 w-24 rounded bg-gray-200 dark:bg-gray-700" />
              <div className="mt-1 h-3 w-32 rounded bg-gray-100 dark:bg-gray-800" />
            </div>
          </div>
        ))}
      </div>
      {/* Chat area */}
      <div className="flex-1 p-6">
        <div className="h-full flex items-center justify-center">
          <div className="h-5 w-40 rounded bg-gray-100 dark:bg-gray-800" />
        </div>
      </div>
    </div>
  );
}
