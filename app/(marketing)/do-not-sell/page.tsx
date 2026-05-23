import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Do Not Sell My Personal Information',
  description: 'Learn about your rights under CCPA and how Waaiio handles your personal information.',
};

export default function DoNotSellPage() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-20">
      <h1 className="text-3xl font-bold text-gray-900 sm:text-4xl">
        Do Not Sell or Share My Personal Information
      </h1>
      <p className="mt-2 text-sm text-gray-500">
        California Consumer Privacy Act (CCPA) / California Privacy Rights Act (CPRA)
      </p>

      <div className="mt-8 space-y-6 text-gray-700 leading-relaxed">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6">
          <div className="flex items-start gap-3">
            <svg className="mt-0.5 h-6 w-6 flex-shrink-0 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <div>
              <h2 className="text-lg font-semibold text-emerald-800">Waaiio does not sell your personal information</h2>
              <p className="mt-1 text-sm text-emerald-700">
                We have never sold personal information and have no plans to do so.
                Your data is used solely to provide and improve the Waaiio service.
              </p>
            </div>
          </div>
        </div>

        <h2 className="text-xl font-semibold text-gray-900">Your Rights Under CCPA</h2>
        <p>
          As a California resident, you have the right to:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li><strong>Know</strong> what personal information we collect, use, and disclose</li>
          <li><strong>Delete</strong> your personal information (subject to certain exceptions)</li>
          <li><strong>Opt-out</strong> of the sale or sharing of your personal information</li>
          <li><strong>Non-discrimination</strong> for exercising your privacy rights</li>
          <li><strong>Correct</strong> inaccurate personal information</li>
          <li><strong>Limit</strong> the use of sensitive personal information</li>
        </ul>

        <h2 className="text-xl font-semibold text-gray-900">How We Use Your Data</h2>
        <p>
          Waaiio collects personal information solely for the purpose of providing our
          WhatsApp business automation service. This includes:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>Account information (name, email) to manage your account</li>
          <li>Business information to configure your WhatsApp bot</li>
          <li>Customer data processed through your bot (on your behalf as a data processor)</li>
          <li>Usage analytics (with your consent) to improve our service</li>
        </ul>

        <h2 className="text-xl font-semibold text-gray-900">Third-Party Sharing</h2>
        <p>
          We share data only with service providers who help us operate Waaiio
          (payment processors, cloud hosting, email delivery). These providers are
          contractually bound to use your data only for the services they provide to us.
          We do not share your data with third parties for their own marketing purposes.
        </p>

        <h2 className="text-xl font-semibold text-gray-900">Exercise Your Rights</h2>
        <p>You can exercise your privacy rights in several ways:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Download your data:</strong> Go to{' '}
            <Link href="/dashboard/settings" className="text-brand hover:underline">
              Dashboard Settings
            </Link>{' '}
            and click &quot;Download My Data&quot;
          </li>
          <li>
            <strong>Delete your account:</strong> Go to{' '}
            <Link href="/dashboard/settings" className="text-brand hover:underline">
              Dashboard Settings
            </Link>{' '}
            and use the account deletion option
          </li>
          <li>
            <strong>Update cookie preferences:</strong> Click &quot;Your Privacy Choices&quot;
            in the footer to manage cookie settings
          </li>
          <li>
            <strong>Contact us:</strong> Email{' '}
            <a href="mailto:privacy@waaiio.com" className="text-brand hover:underline">
              privacy@waaiio.com
            </a>{' '}
            for any privacy-related requests
          </li>
        </ul>

        <div className="rounded-xl border border-gray-200 bg-gray-50 p-6">
          <h3 className="font-semibold text-gray-900">Verification</h3>
          <p className="mt-1 text-sm text-gray-600">
            To protect your privacy, we may need to verify your identity before processing
            your request. We will ask you to confirm the email address associated with your
            account.
          </p>
        </div>

        <p className="text-sm text-gray-500">
          For more information about how we handle your data, please review our{' '}
          <Link href="/privacy" className="text-brand hover:underline">Privacy Policy</Link>{' '}
          and{' '}
          <Link href="/dpa" className="text-brand hover:underline">Data Processing Agreement</Link>.
        </p>

        <p className="text-sm text-gray-500">
          Last updated: May 2026
        </p>
      </div>
    </section>
  );
}
