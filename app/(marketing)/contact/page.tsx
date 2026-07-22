import type { Metadata } from 'next';
import { ContactForm } from './ContactForm';
import { getSupportWhatsAppLink, getSupportWhatsAppNumber } from '@/lib/support-contact';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Contact Us',
  description:
    'Get in touch with the Waaiio team. Reach us via email, WhatsApp, or our contact form for support, partnerships, or general enquiries.',
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-24 sm:py-32">
      <div className="text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-brand">Contact</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
          Get in Touch
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-gray-500">
          Have a question, need support, or want to explore a partnership?
          We&apos;d love to hear from you.
        </p>
      </div>

      <div className="mt-16 grid gap-12 lg:grid-cols-5">
        {/* Contact Form */}
        <div className="lg:col-span-3">
          <h2 className="text-xl font-semibold text-gray-900">Send us a message</h2>
          <p className="mt-1 text-sm text-gray-500">
            We typically respond within 24 hours on business days.
          </p>
          <ContactForm />
        </div>

        {/* Contact Info Sidebar */}
        <div className="lg:col-span-2 space-y-6">
          {/* Email */}
          <div className="rounded-2xl border border-gray-100 bg-white p-6 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-brand/5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/10">
              <svg aria-hidden="true" className="h-5 w-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
              </svg>
            </div>
            <h3 className="mt-3 font-semibold text-gray-900">Email</h3>
            <p className="mt-1 text-sm text-gray-500">General enquiries & support</p>
            <a href="mailto:hello@waaiio.com" className="mt-2 inline-block text-sm font-medium text-brand hover:underline">
              hello@waaiio.com
            </a>
          </div>

          {/* WhatsApp */}
          <div className="rounded-2xl border border-gray-100 bg-white p-6 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-brand/5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-whatsapp/10">
              <svg aria-hidden="true" className="h-5 w-5 text-whatsapp" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
            </div>
            <h3 className="mt-3 font-semibold text-gray-900">WhatsApp</h3>
            <p className="mt-1 text-sm text-gray-500">Quick support via chat</p>
            <a
              href={getSupportWhatsAppLink() || '#'}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-2 inline-block text-sm font-medium text-whatsapp hover:underline ${!getSupportWhatsAppNumber() ? 'hidden' : ''}`}
            >
              Chat on WhatsApp
            </a>
          </div>

          {/* Office */}
          <div className="rounded-2xl border border-gray-100 bg-white p-6 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-brand/5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100">
              <svg aria-hidden="true" className="h-5 w-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
              </svg>
            </div>
            <h3 className="mt-3 font-semibold text-gray-900">Location</h3>
            <p className="mt-1 text-sm text-gray-500">
              United States & Nigeria
            </p>
          </div>

          {/* Specific emails */}
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-6">
            <h3 className="text-sm font-semibold text-gray-900">Specific enquiries</h3>
            <ul className="mt-3 space-y-2 text-sm text-gray-600">
              <li>
                <strong>Data protection:</strong>{' '}
                <a href="mailto:dpo@waaiio.com" className="text-brand hover:underline">dpo@waaiio.com</a>
              </li>
              <li>
                <strong>Abuse reports:</strong>{' '}
                <a href="mailto:abuse@waaiio.com" className="text-brand hover:underline">abuse@waaiio.com</a>
              </li>
              <li>
                <strong>Partnerships:</strong>{' '}
                <a href="mailto:hello@waaiio.com" className="text-brand hover:underline">hello@waaiio.com</a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
