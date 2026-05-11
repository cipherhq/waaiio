'use client';

import React from 'react';
import dynamic from 'next/dynamic';

const OnboardingWizard = dynamic(
  () => import('./OnboardingWizard').then(mod => mod.OnboardingWizard),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    ),
  }
);

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
          <p className="text-4xl font-bold text-red-500">Oops</p>
          <p className="mt-2 text-sm text-gray-600">Something went wrong loading this page.</p>
          <pre className="mt-4 max-w-lg overflow-auto rounded bg-gray-100 p-4 text-xs text-left text-red-700">
            {this.state.error.message}
          </pre>
          <button onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white">
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function GetStartedPage() {
  return (
    <ErrorBoundary>
      <OnboardingWizard />
    </ErrorBoundary>
  );
}
