const defaultColorMap: Record<string, string> = {
  // Green
  success: 'bg-green-100 text-green-700',
  paid: 'bg-green-100 text-green-700',
  active: 'bg-green-100 text-green-700',
  resolved: 'bg-green-100 text-green-700',
  completed: 'bg-green-100 text-green-700',
  published: 'bg-green-100 text-green-700',
  sent: 'bg-green-100 text-green-700',
  // Yellow
  pending: 'bg-yellow-100 text-yellow-700',
  open: 'bg-yellow-100 text-yellow-700',
  waiting: 'bg-yellow-100 text-yellow-700',
  trial: 'bg-yellow-100 text-yellow-700',
  // Blue
  processing: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-blue-100 text-blue-700',
  confirmed: 'bg-blue-100 text-blue-700',
  sending: 'bg-blue-100 text-blue-700',
  approved: 'bg-blue-100 text-blue-700',
  // Red
  failed: 'bg-red-100 text-red-700',
  rejected: 'bg-red-100 text-red-700',
  closed: 'bg-red-100 text-red-700',
  suspended: 'bg-red-100 text-red-700',
  expired: 'bg-red-100 text-red-700',
  refunded: 'bg-red-100 text-red-700',
  // Gray
  draft: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-gray-100 text-gray-600',
  inactive: 'bg-gray-100 text-gray-600',
};

interface StatusBadgeProps {
  status: string;
  colorMap?: Record<string, string>;
}

export function StatusBadge({ status, colorMap }: StatusBadgeProps) {
  const s = status || 'unknown';
  const map = colorMap || defaultColorMap;
  const cls = map[s] || 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}>
      {s.replace(/_/g, ' ')}
    </span>
  );
}
