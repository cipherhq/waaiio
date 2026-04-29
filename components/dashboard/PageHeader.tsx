'use client';

import { Tooltip } from './Tooltip';

interface PageHeaderProps {
  title: string;
  description?: string;
  tooltip?: string;
  children?: React.ReactNode; // right-side actions
}

/**
 * Consistent page header for dashboard pages.
 * Includes optional tooltip for explaining the feature.
 */
export function PageHeader({ title, description, tooltip, children }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
          {tooltip && <Tooltip text={tooltip} />}
        </div>
        {description && (
          <p className="mt-1 text-sm text-gray-500">{description}</p>
        )}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
