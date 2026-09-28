import type { Metadata } from 'next';
import Link from 'next/link';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'Delete Your Data — Waaiio',
  description:
    'How to delete your Waaiio account and all associated data. Self-service deletion, grace period, and alternative contact options.',
};

export default function DataDeletionPage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-24">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <h1 className="text-4xl font-extrabold text-white lg:text-5xl">Delete Your Data</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">
            How to delete your Waaiio account and all associated personal data.
          </p>
        </div>
      </section>

      <AnimatedSection>
        <div className="mx-auto max-w-3xl px-4 py-16">
          <div className="prose-pages mt-4 space-y-8 text-gray-700">

            {/* ── Option 1: Self-Service ──────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">Option 1: Self-Service Deletion (Recommended)</h2>
              <p className="mt-2 leading-relaxed">
                You can delete your Waaiio account directly from your dashboard. This is the fastest
                way to remove your account and all associated data.
              </p>
              <ol className="mt-4 list-decimal space-y-3 pl-6">
                <li>
                  <strong>Sign in</strong> to your Waaiio account at{' '}
                  <Link href="/login" className="text-brand underline">waaiio.com/login</Link>.
                </li>
                <li>
                  Go to <strong>Dashboard &rarr; Settings &rarr; Account</strong>.
                </li>
                <li>
                  Scroll to the <strong>&ldquo;Delete Account&rdquo;</strong> section.
                </li>
                <li>
                  Click <strong>&ldquo;Delete My Account&rdquo;</strong>.
                </li>
                <li>
                  <strong>Re-enter your password</strong> to confirm your identity.
                </li>
                <li>
                  Review the confirmation dialog and confirm the deletion.
                </li>
              </ol>
            </section>

            {/* ── What Happens ────────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">What Happens When You Delete Your Account</h2>
              <p className="mt-2 leading-relaxed">
                When you request account deletion through the dashboard:
              </p>
              <ul className="mt-4 list-disc space-y-2 pl-6">
                <li>
                  <strong>30-day grace period:</strong> Your account is scheduled for deletion in
                  30 days. During this period, you can cancel the deletion by logging back into your
                  account.
                </li>
                <li>
                  <strong>Businesses are deactivated:</strong> All businesses associated with your
                  account are immediately set to inactive status.
                </li>
                <li>
                  <strong>Confirmation email:</strong> You will receive an email confirming the
                  deletion request and the scheduled deletion date.
                </li>
                <li>
                  <strong>After the grace period:</strong> Your account and profile are permanently
                  deleted. This action cannot be undone.
                </li>
              </ul>
            </section>

            {/* ── Data That Is Deleted ────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">Data That Is Deleted</h2>
              <p className="mt-2 leading-relaxed">
                Account deletion removes the following:
              </p>
              <ul className="mt-4 list-disc space-y-2 pl-6">
                <li>Your user account and login credentials</li>
                <li>Your profile information (name, email, phone)</li>
                <li>All businesses you own and their configurations</li>
                <li>WhatsApp bot settings and conversation history</li>
                <li>Customer data associated with your businesses</li>
              </ul>
              <p className="mt-4 leading-relaxed">
                Certain records may be retained as required by law, including financial transaction
                records needed for tax, accounting, or regulatory compliance. For full details on
                data retention, see our{' '}
                <Link href="/privacy" className="text-brand underline">Privacy Policy</Link>.
              </p>
            </section>

            {/* ── Option 2: Email Request ─────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">Option 2: Request Deletion by Email</h2>
              <p className="mt-2 leading-relaxed">
                If you are unable to access your account or prefer to request deletion by email,
                contact us at:
              </p>
              <p className="mt-3 leading-relaxed">
                <a href="mailto:privacy@waaiio.com" className="text-brand underline font-medium">
                  privacy@waaiio.com
                </a>
              </p>
              <p className="mt-3 leading-relaxed">
                Include the email address associated with your Waaiio account in your request.
                We will verify your identity and process your request within 30 days, or as
                required by applicable law.
              </p>
            </section>

            {/* ── Cancel Deletion ─────────────────────────── */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900">Cancel a Pending Deletion</h2>
              <p className="mt-2 leading-relaxed">
                If you change your mind during the 30-day grace period, simply log back into your
                Waaiio account. The scheduled deletion will be cancelled automatically and your
                account and businesses will be restored.
              </p>
            </section>

            {/* ── Related Policies ─────────────────────────── */}
            <section className="border-t border-gray-200 pt-8">
              <h2 className="text-xl font-semibold text-gray-900">Related Policies</h2>
              <ul className="mt-4 space-y-2">
                <li>
                  <Link href="/privacy" className="text-brand underline">Privacy Policy</Link>
                  {' '}&mdash; how we collect, use, and protect your data
                </li>
                <li>
                  <Link href="/terms" className="text-brand underline">Terms of Service</Link>
                  {' '}&mdash; the agreement governing your use of Waaiio
                </li>
              </ul>
            </section>
          </div>
        </div>
      </AnimatedSection>
    </>
  );
}
