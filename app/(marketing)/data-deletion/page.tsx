import type { Metadata } from 'next';
import Link from 'next/link';
import AnimatedSection from '@/components/marketing/AnimatedSection';

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

export const metadata: Metadata = {
  title: 'Data Deletion — Waaiio',
  description:
    'How to delete your Waaiio account and all associated data. Self-service deletion with a 30-day grace period, or email privacy@waaiio.com.',
  openGraph: {
    title: 'Data Deletion — Waaiio',
    description:
      'How to delete your Waaiio account and all associated data. Self-service deletion with a 30-day grace period.',
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
            How to delete your Waaiio account and all associated data.
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
                You can delete your Waaiio account and all associated data directly
                from your dashboard. No need to contact support.
              </p>
              <p className="mt-2 leading-relaxed">
                Navigate to{' '}
                <strong>Dashboard &gt; Settings &gt; Account &gt; Delete Account</strong>{' '}
                to begin the process.
              </p>
            </section>

            {/* ── Step-by-Step Process ────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                How It Works
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
                  <strong>Re-authenticate</strong> your identity when prompted to
                  confirm you are the account owner.
                </li>
                <li>
                  <strong>Confirm</strong> your decision in the confirmation
                  dialog.
                </li>
                <li>
                  <strong>Wait up to 30 days</strong> for the deletion to
                  complete. You will receive a confirmation email.
                </li>
              </ol>
            </section>

            {/* ── 30-Day Grace Period ─────────────────────────── */}
            <section>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
                <div className="flex items-start gap-3">
                  <svg
                    className="mt-0.5 h-6 w-6 flex-shrink-0 text-amber-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <div>
                    <h3 className="text-lg font-semibold text-amber-800">
                      30-Day Grace Period
                    </h3>
                    <p className="mt-1 text-sm text-amber-700">
                      After you request deletion, your account enters a 30-day
                      grace period. During this time your data is retained but
                      your businesses are deactivated. If you change your mind,
                      simply log back in to cancel the deletion and reactivate
                      your account.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* ── What Is Deleted ─────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                What Is Deleted
              </h2>
              <p className="mt-3 leading-relaxed">
                Once the deletion process is complete, the following data is
                permanently removed:
              </p>
              <ul className="mt-4 list-disc space-y-2 pl-6">
                <li>
                  <strong>Account and profile</strong> &mdash; your login
                  credentials, name, email, and profile information
                </li>
                <li>
                  <strong>Businesses</strong> &mdash; all businesses you own are
                  soft-deleted (deactivated and hidden)
                </li>
                <li>
                  <strong>Bot configurations</strong> &mdash; WhatsApp bot
                  sessions, flow settings, auto-replies, and conversation history
                </li>
                <li>
                  <strong>Customer and booking data</strong> &mdash; appointments,
                  orders, reservations, tickets, and related customer records
                </li>
                <li>
                  <strong>Payment data</strong> &mdash; payment records, active
                  subscriptions (cancelled on all gateways), and payout
                  configurations
                </li>
                <li>
                  <strong>Uploaded media</strong> &mdash; logos, images, and other
                  files you uploaded to the platform
                </li>
              </ul>
            </section>

            {/* ── Legal Retention ─────────────────────────────── */}
            <section>
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-6">
                <h3 className="font-semibold text-gray-900">
                  Legal Retention
                </h3>
                <p className="mt-2 text-sm text-gray-600 leading-relaxed">
                  Certain financial, tax, and regulatory records may be retained
                  beyond the deletion date as required by applicable law. This
                  includes transaction records needed for tax reporting, fraud
                  prevention, and compliance with legal obligations. Retained
                  records are stored securely and are not used for any other
                  purpose.
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
                data deletion by emailing us at{' '}
                <a
                  href="mailto:privacy@waaiio.com"
                  className="text-brand hover:underline"
                >
                  privacy@waaiio.com
                </a>
                . Please include the email address associated with your Waaiio
                account so we can verify your identity and process your request.
              </p>
              <p className="mt-2 leading-relaxed">
                We will respond to email deletion requests within 30 days, in
                accordance with GDPR, CCPA, and other applicable data protection
                regulations.
              </p>
            </section>

            {/* ── Cancel Pending Deletion ─────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">
                Cancel a Pending Deletion
              </h2>
              <p className="mt-3 leading-relaxed">
                Changed your mind? If your account is within the 30-day grace
                period, simply{' '}
                <Link href="/login" className="text-brand hover:underline">
                  log back in
                </Link>{' '}
                to your Waaiio account. Logging in cancels the pending deletion,
                restores your profile, and reactivates your businesses.
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
