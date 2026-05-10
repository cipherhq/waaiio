'use client';

interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  tip?: string;
}

export default function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  tip,
}: EmptyStateProps) {
  const ActionTag = actionHref ? 'a' : 'button';
  const actionProps = actionHref
    ? { href: actionHref }
    : { type: 'button' as const, onClick: onAction };

  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-brand-50">
        <span className="text-4xl leading-none">{icon}</span>
      </div>

      <h3 className="mt-6 text-lg font-bold text-gray-900">{title}</h3>

      <p className="mt-2 text-sm leading-relaxed text-gray-500">{description}</p>

      {actionLabel && (
        <ActionTag
          {...actionProps}
          className="mt-6 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 hover:shadow-md active:scale-[0.98]"
        >
          {actionLabel}
        </ActionTag>
      )}

      {tip && (
        <div className="mt-6 w-full rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-left">
          <p className="text-xs leading-relaxed text-blue-700">
            <span className="font-semibold">Tip:</span>{' '}
            {tip.replace(/^Tip:\s*/i, '')}
          </p>
        </div>
      )}
    </div>
  );
}
