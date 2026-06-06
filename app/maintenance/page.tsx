import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Under Maintenance — Waaiio',
  robots: 'noindex',
};

export default function MaintenancePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <div className="mx-auto max-w-md">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-brand/10">
          <svg className="h-10 w-10 text-brand" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <h1 className="mt-6 text-2xl font-bold text-gray-900">We&apos;ll be right back</h1>
        <p className="mt-3 text-gray-500">
          Waaiio is currently undergoing scheduled maintenance to improve your experience.
          We&apos;ll be back online shortly.
        </p>
        <p className="mt-6 text-sm text-gray-400">
          If you need urgent assistance, contact us at{' '}
          <a href="mailto:hello@waaiio.com" className="text-brand hover:underline">hello@waaiio.com</a>
        </p>
        <div className="mt-8">
          <a
            href="/"
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-medium text-white hover:bg-brand/90 transition inline-block"
          >
            Try Again
          </a>
        </div>
      </div>
    </div>
  );
}
