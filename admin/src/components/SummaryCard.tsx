import type { LucideIcon } from 'lucide-react';

const cardColors: Record<string, string> = {
  blue: 'bg-blue-50 border-blue-100',
  green: 'bg-green-50 border-green-100',
  yellow: 'bg-yellow-50 border-yellow-100',
  purple: 'bg-purple-50 border-purple-100',
  red: 'bg-red-50 border-red-100',
  indigo: 'bg-indigo-50 border-indigo-100',
  pink: 'bg-pink-50 border-pink-100',
  gray: 'bg-gray-50 border-gray-100',
};

const iconColors: Record<string, string> = {
  blue: 'bg-blue-100 text-blue-600',
  green: 'bg-green-100 text-green-600',
  yellow: 'bg-yellow-100 text-yellow-600',
  purple: 'bg-purple-100 text-purple-600',
  red: 'bg-red-100 text-red-600',
  indigo: 'bg-indigo-100 text-indigo-600',
  pink: 'bg-pink-100 text-pink-600',
  gray: 'bg-gray-100 text-gray-600',
};

interface SummaryCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  color?: string;
}

export function SummaryCard({ label, value, icon: Icon, color = 'blue' }: SummaryCardProps) {
  return (
    <div className={`rounded-xl border p-5 ${cardColors[color] || cardColors.blue}`}>
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconColors[color] || iconColors.blue}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500">{label}</p>
          <p className="text-lg font-bold text-gray-900">{value}</p>
        </div>
      </div>
    </div>
  );
}
