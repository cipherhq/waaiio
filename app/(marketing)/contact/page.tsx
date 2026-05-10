import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Contact Us',
  description:
    'Get in touch with the Waaiio team. Reach us via email or WhatsApp for support, partnerships, or general enquiries.',
};

export default async function ContactPage() {
  const supabase = await createClient();
  const { data } = await supabase.from('platform_settings').select('value').eq('key', 'contact_emails').single();
  const emails = (data?.value as Record<string, string>) || {};
  const generalEmail = emails.general || '{generalEmail}';
  const dpoEmail = emails.dpo || 'dpo@waaiio.com';
  const abuseEmail = emails.abuse || 'abuse@waaiio.com';
  return (
    <div className="mx-auto max-w-3xl px-4 py-24 sm:py-32">
      <h1 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
        Contact Us
      </h1>
      <p className="mt-4 text-lg text-gray-600">
        Have a question, need support, or want to explore a partnership?
        We&apos;d love to hear from you.
      </p>

      <div className="mt-12 grid gap-8 sm:grid-cols-2">
        {/* Email */}
        <div className="rounded-2xl border border-gray-200 bg-white p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand/10">
            <svg className="h-6 w-6 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-semibold text-gray-900">Email</h2>
          <p className="mt-1 text-sm text-gray-500">
            For general enquiries, support, or partnership requests.
          </p>
          <a
            href={`mailto:${generalEmail}`}
            className="mt-4 inline-block text-sm font-medium text-brand hover:underline"
          >
            {generalEmail}
          </a>
        </div>

        {/* WhatsApp */}
        <div className="rounded-2xl border border-gray-200 bg-white p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#25D366]/10">
            <svg className="h-6 w-6 text-[#25D366]" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-semibold text-gray-900">WhatsApp</h2>
          <p className="mt-1 text-sm text-gray-500">
            Chat with us directly on WhatsApp for quick support.
          </p>
          <a
            href="https://wa.me/2349060009740"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-block text-sm font-medium text-[#25D366] hover:underline"
          >
            Message us on WhatsApp
          </a>
        </div>
      </div>

      {/* Additional info */}
      <div className="mt-12 rounded-2xl border border-gray-100 bg-gray-50 p-6">
        <h3 className="font-semibold text-gray-900">Specific enquiries</h3>
        <ul className="mt-3 space-y-2 text-sm text-gray-600">
          <li>
            <strong>Data protection:</strong>{' '}
            <a href={`mailto:${dpoEmail}`} className="text-brand hover:underline">{dpoEmail}</a>
          </li>
          <li>
            <strong>Abuse reports:</strong>{' '}
            <a href={`mailto:${abuseEmail}`} className="text-brand hover:underline">{abuseEmail}</a>
          </li>
          <li>
            <strong>Partnerships:</strong>{' '}
            <a href={`mailto:${generalEmail}`} className="text-brand hover:underline">{generalEmail}</a>
          </li>
        </ul>
      </div>

      <div className="mt-12 text-center">
        <p className="text-sm text-gray-500">
          We typically respond within 24 hours on business days.
        </p>
      </div>
    </div>
  );
}
