'use client';

export default function ToggleRow({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
      <div className="mr-3">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-400">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-brand' : 'bg-gray-200'}`}
      >
        <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: checked ? '22px' : '2px' }} />
      </button>
    </div>
  );
}
