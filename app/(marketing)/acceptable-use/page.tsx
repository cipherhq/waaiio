import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Acceptable Use Policy — Waaiio',
  description:
    'Rules governing acceptable use of the Waaiio WhatsApp automation platform.',
};

export default function AcceptableUsePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-bold text-gray-900">
        Acceptable Use &amp; Anti-Spam Policy
      </h1>
      <p className="mt-2 text-sm text-gray-400">Last updated: April 2026</p>

      <div className="prose-pages mt-10 space-y-8 text-gray-700">
        <section>
          <h2 className="text-xl font-semibold text-gray-900">Overview</h2>
          <p className="mt-2 leading-relaxed">
            This policy outlines the rules for using Waaiio&rsquo;s WhatsApp
            automation platform. By using our services, you agree to comply with
            these rules, Meta&rsquo;s WhatsApp Business Policy, and all
            applicable laws.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">
            Prohibited Content &amp; Conduct
          </h2>
          <p className="mt-2 leading-relaxed">You must not use Waaiio to:</p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">
            <li>Send unsolicited messages (spam) to recipients who have not opted in</li>
            <li>
              Transmit illegal, defamatory, threatening, harassing, or
              discriminatory content
            </li>
            <li>
              Distribute malware, phishing links, or deceptive content
            </li>
            <li>
              Sell or promote prohibited goods (weapons, drugs, counterfeit items)
            </li>
            <li>
              Impersonate another person, brand, or organisation
            </li>
            <li>Violate intellectual property or data protection rights</li>
            <li>
              Attempt to circumvent platform rate limits, security controls, or
              WhatsApp policies
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">
            WhatsApp Messaging Guidelines
          </h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">
            <li>
              <strong>24-hour customer service window:</strong> You may send
              free-form replies within 24 hours of a customer&rsquo;s last
              message. Outside this window, only pre-approved WhatsApp message
              templates may be used.
            </li>
            <li>
              <strong>Template messages:</strong> All template messages must be
              approved by Meta before use and must comply with WhatsApp&rsquo;s
              commerce and business policies.
            </li>
            <li>
              <strong>Opt-in required:</strong> You must obtain clear, informed
              consent from each recipient before sending them messages via
              WhatsApp. Records of consent must be maintained.
            </li>
            <li>
              <strong>Easy opt-out:</strong> Every broadcast must include clear
              instructions for recipients to unsubscribe. Opt-out requests must
              be honoured immediately.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">
            Recipient Consent Requirements
          </h2>
          <p className="mt-2 leading-relaxed">
            Before messaging any contact, you must have documented evidence that
            the recipient has:
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">
            <li>
              Voluntarily provided their phone number for the purpose of
              receiving WhatsApp messages from your business
            </li>
            <li>
              Been clearly informed of the types of messages they will receive
              (e.g., booking confirmations, promotions, order updates)
            </li>
            <li>Been told how to opt out at any time</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">
            CASL Compliance (Canada)
          </h2>
          <p className="mt-2 leading-relaxed">
            If you send messages to recipients in Canada, you must also comply
            with Canada&rsquo;s Anti-Spam Legislation (CASL):
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">
            <li>
              Obtain express consent before sending commercial electronic
              messages (CEMs)
            </li>
            <li>
              Include your business name, mailing address, and contact
              information in every message
            </li>
            <li>
              Provide a working unsubscribe mechanism; process opt-outs within
              10 business days
            </li>
            <li>
              Implied consent expires after 2 years (existing business
              relationship) or 6 months (inquiry)
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">
            Consequences of Violations
          </h2>
          <p className="mt-2 leading-relaxed">
            Waaiio reserves the right to take the following actions if you
            violate this policy:
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">
            <li>Issue a warning with a deadline to remedy the violation</li>
            <li>
              Temporarily suspend your account and messaging capabilities
            </li>
            <li>
              Permanently terminate your account without refund
            </li>
            <li>
              Report illegal activity to the relevant authorities
            </li>
          </ul>
          <p className="mt-3 leading-relaxed">
            We may also be required to report violations to Meta, which may
            independently restrict or ban your WhatsApp Business account.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">Contact</h2>
          <p className="mt-2 leading-relaxed">
            To report a violation or ask about this policy, email{' '}
            <a href="mailto:abuse@waaiio.com" className="text-brand underline">
              abuse@waaiio.com
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
