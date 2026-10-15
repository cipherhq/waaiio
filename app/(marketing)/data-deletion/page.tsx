import type { Metadata } from 'next';
import Link from 'next/link';
import AnimatedSection from '@/components/marketing/AnimatedSection';

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

export const metadata: Metadata = {
  title: 'Data Deletion — Waaiio',
  description:
    'How to delete your Waaiio account. Self-service deletion from the dashboard, with immediate or grace-period options.',
  openGraph: {
    title: 'Data Deletion — Waaiio',
    description:
      'How to delete your Waaiio account. Self-service deletion from the dashboard.',
    url: `${baseUrl}/data-deletion`,
    siteName: 'Waaiio',
    type: 'website',
  },
  alternates: {
    canonical: `${baseUrl}/data-deletion`,
  },
};

export default function DataDeletionPage() {
  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">
            Data Deletion
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">
            How to delete your Waaiio account.
          </p>
        </div>
      </section>

      {/* ── Content ───────────────────────────────────────────── */}
      <AnimatedSection>
        <div className="mx-auto max-w-3xl px-4 py-16">
          <div className="space-y-10 text-gray-700">

            {/* ── Self-Service Deletion ──────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                Self-Service Account Deletion
              </h2>
              <p className="mt-3 leading-relaxed">
                You can delete your Waaiio account directly from your dashboard.
                No need to contact support.
              </p>
              <p className="mt-2 leading-relaxed">
                Navigate to{' '}
                <strong>Dashboard &gt; Settings &gt; Account &gt; Delete Account</strong>{' '}
                to begin the process.
              </p>
            </section>

            {/* ── Deletion Options ───────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                Deletion Options
              </h2>
              <p className="mt-3 leading-relaxed">
                When you delete your account, you may choose between two options:
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-gray-200 bg-white p-5">
                  <h3 className="font-semibold text-gray-900">Immediate Deletion</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600">
                    Your authentication account and profile are removed right away.
                    Any businesses you own are deactivated. Active payment
                    subscriptions are cancelled and bot sessions are deactivated.
                  </p>
                </div>
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
                  <h3 className="font-semibold text-amber-800">30-Day Grace Period</h3>
                  <p className="mt-2 text-sm leading-relaxed text-amber-700">
                    Your account is scheduled for deletion and your businesses are
                    deactivated. Your login remains active during this period so you
                    can cancel the request if you change your mind (see below).
                  </p>
                </div>
              </div>
            </section>

            {/* ── Step-by-Step Process ────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                How to Delete Your Account
              </h2>
              <ol className="mt-4 list-decimal space-y-3 pl-6">
                <li>
                  <strong>Sign in</strong> to your Waaiio account at{' '}
                  <Link href="/login" className="text-brand hover:underline">
                    waaiio.com/login
                  </Link>.
                </li>
                <li>
                  <strong>Navigate</strong> to{' '}
                  <Link href="/dashboard/settings" className="text-brand hover:underline">
                    Dashboard &gt; Settings
                  </Link>{' '}
                  and scroll to the <em>Account</em> section.
                </li>
                <li>
                  <strong>Click &ldquo;Delete Account&rdquo;</strong> to initiate
                  the deletion process.
                </li>
                <li>
                  <strong>Choose</strong> between immediate deletion or the 30-day
                  grace period.
                </li>
                <li>
                  <strong>Confirm</strong> your decision in the confirmation dialog.
                </li>
              </ol>
            </section>

            {/* ── What Happens to Your Data ───────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                What Happens to Your Data
              </h2>
              <p className="mt-3 leading-relaxed">
                When your account is deleted:
              </p>
              <ul className="mt-4 list-disc space-y-2 pl-6">
                <li>
                  <strong>Account and profile</strong> &mdash; on the immediate
                  path, your login credentials, name, email, and profile
                  information are removed right away.
                </li>
                <li>
                  <strong>Businesses</strong> &mdash; all businesses you own are
                  deactivated (soft-deleted) and hidden from public view.
                </li>
                <li>
                  <strong>Subscriptions</strong> &mdash; active payment
                  subscriptions are cancelled on the respective gateways.
                </li>
                <li>
                  <strong>Bot sessions</strong> &mdash; active WhatsApp bot
                  sessions are deactivated.
                </li>
              </ul>
            </section>

            {/* ── Data Retention ──────────────────────────────── */}
            <section>
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-6">
                <h3 className="font-semibold text-gray-900">
                  Data Retention
                </h3>
                <p className="mt-2 text-sm text-gray-600 leading-relaxed">
                  Certain operational, transaction, and financial records associated
                  with your businesses may be retained after account deletion for
                  legal, accounting, security, fraud-prevention, compliance, or
                  referential-integrity reasons. This includes records such as
                  payment transactions, booking history, and order records. Retained
                  data is stored securely and is not used for marketing or unrelated
                  purposes.
                </p>
              </div>
            </section>

            {/* ── Email Fallback ──────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                Can&rsquo;t Access Your Account?
              </h2>
              <p className="mt-3 leading-relaxed">
                If you are unable to sign in to your account, you can request
                account deletion by emailing us at{' '}
                <a
                  href="mailto:privacy@waaiio.com"
                  className="text-brand hover:underline"
                >
                  privacy@waaiio.com
                </a>
                . Please include the email address associated with your Waaiio
                account so we can verify your identity and process your request.
              </p>
            </section>

            {/* ── Cancel Pending Deletion ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                Cancel a Pending Deletion
              </h2>
              <p className="mt-3 leading-relaxed">
                If you chose the 30-day grace period and changed your mind, sign
                in to your account and use the{' '}
                <strong>Cancel Deletion</strong> option on your dashboard. If you
                are unable to access your dashboard, contact us at{' '}
                <a
                  href="mailto:privacy@waaiio.com"
                  className="text-brand hover:underline"
                >
                  privacy@waaiio.com
                </a>{' '}
                to request cancellation.
              </p>
            </section>

            {/* ── Related Policies ────────────────────────────── */}
            <section className="border-t border-gray-200 pt-8">
              <p className="text-sm text-gray-500">
                For more information about how we handle your data, see our{' '}
                <Link href="/privacy" className="text-brand hover:underline">
                  Privacy Policy
                </Link>{' '}
                and{' '}
                <Link href="/terms" className="text-brand hover:underline">
                  Terms of Service
                </Link>
                .
              </p>
            </section>
          </div>
        </div>
      </AnimatedSection>
    </>
  );
}
