import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getBusinessTerms } from './business-terms';

// The bot links here from payment summaries ("📎 Terms:"), see
// getBusinessTermsUrl in lib/bot/flows/shared/terms.ts.

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const terms = await getBusinessTerms(slug);
  if (!terms) return { title: 'Not Found | Waaiio' };
  return {
    title: `${terms.name} — Terms & Conditions | Waaiio`,
    robots: { index: false },
  };
}

export default async function BusinessTermsPage({ params }: PageProps) {
  const { slug } = await params;
  const terms = await getBusinessTerms(slug);

  if (!terms) notFound();
  // No terms of its own: show Waaiio's standard terms instead of an empty page.
  if (!terms.termsText) redirect('/terms');

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <article className="mx-auto max-w-2xl rounded-2xl bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">Terms &amp; Conditions</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900">{terms.name}</h1>
        <div className="mt-6 whitespace-pre-line break-words text-sm leading-relaxed text-gray-700">
          {terms.termsText}
        </div>
        <p className="mt-8 border-t border-gray-100 pt-4 text-xs text-gray-500">
          These terms are set by {terms.name}. See also Waaiio&apos;s{' '}
          <Link href="/terms" className="text-brand underline">
            Terms of Service
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
