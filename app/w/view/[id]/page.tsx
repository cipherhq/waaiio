import { notFound } from 'next/navigation';
import { createServiceClient } from '@/lib/supabase/service';
import type { Metadata } from 'next';
import { PrintButton } from './PrintButton';

export const metadata: Metadata = {
  title: 'Signed Waiver',
  robots: 'noindex',
};

export default async function SignedWaiverView({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token } = await searchParams;
  const supabase = createServiceClient();

  // Fetch signed waiver — verify access_token
  const { data: signed } = await supabase
    .from('signed_waivers')
    .select('*')
    .eq('id', id)
    .eq('access_token', token || '')
    .single();

  if (!signed) notFound();

  // Fetch template + business separately (nested joins can fail with PostgREST)
  const { data: template } = await supabase
    .from('waiver_templates')
    .select('title, body')
    .eq('id', signed.template_id)
    .single();

  const { data: business } = await supabase
    .from('businesses')
    .select('name, logo_url')
    .eq('id', signed.business_id)
    .single();

  if (!template || !business) notFound();
  const meta = (signed.metadata || {}) as Record<string, string>;
  const signedDate = new Date(signed.signed_at).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const refCode = `WAI-${signed.id.slice(0, 6).toUpperCase()}`;

  // Get signature image URL
  let signatureImgUrl: string | null = null;
  if (signed.signature_url) {
    const { data: urlData } = supabase.storage.from('contracts').getPublicUrl(signed.signature_url);
    signatureImgUrl = urlData?.publicUrl || null;
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="mx-auto max-w-2xl">
        {/* Print button */}
        <div className="mb-4 flex justify-end print:hidden">
          <PrintButton />
        </div>

        {/* Document */}
        <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm print:shadow-none print:border-none print:rounded-none">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-200 pb-6">
            <div className="flex items-center gap-3">
              {business.logo_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={business.logo_url} alt="" className="h-12 w-12 rounded-lg object-contain" />
              )}
              <div>
                <p className="text-lg font-bold text-gray-900">{business.name}</p>
                <p className="text-xs text-gray-400">Signed Waiver</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs font-mono text-gray-400">{refCode}</p>
              <p className="text-xs text-gray-400">{signedDate}</p>
            </div>
          </div>

          {/* Waiver Title */}
          <h1 className="mt-6 text-xl font-bold text-gray-900">{template.title}</h1>

          {/* Waiver Body */}
          <div className="mt-4 rounded-lg bg-gray-50 p-5">
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-gray-700">
              {template.body}
            </pre>
          </div>

          {/* Signer Details */}
          <div className="mt-6 grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs font-medium uppercase text-gray-400">Full Name</p>
              <p className="mt-1 font-medium text-gray-900">{signed.customer_name}</p>
            </div>
            {signed.customer_email && (
              <div>
                <p className="text-xs font-medium uppercase text-gray-400">Email</p>
                <p className="mt-1 text-gray-700">{signed.customer_email}</p>
              </div>
            )}
            {signed.customer_phone && (
              <div>
                <p className="text-xs font-medium uppercase text-gray-400">Phone</p>
                <p className="mt-1 text-gray-700">{signed.customer_phone}</p>
              </div>
            )}
            <div>
              <p className="text-xs font-medium uppercase text-gray-400">Date Signed</p>
              <p className="mt-1 text-gray-700">{signedDate}</p>
            </div>
          </div>

          {/* Custom Fields */}
          {(meta.emergency_contact_name || meta.medical_conditions || meta.allergies) && (
            <div className="mt-6 rounded-lg border border-gray-200 p-4">
              <p className="text-xs font-semibold uppercase text-gray-400 mb-3">Additional Information</p>
              <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                {meta.emergency_contact_name && (
                  <div>
                    <p className="text-xs text-gray-400">Emergency Contact</p>
                    <p className="text-gray-700">{meta.emergency_contact_name} {meta.emergency_contact_phone ? `(${meta.emergency_contact_phone})` : ''}</p>
                  </div>
                )}
                {meta.medical_conditions && (
                  <div>
                    <p className="text-xs text-gray-400">Medical Conditions</p>
                    <p className="text-gray-700">{meta.medical_conditions}</p>
                  </div>
                )}
                {meta.allergies && (
                  <div>
                    <p className="text-xs text-gray-400">Allergies</p>
                    <p className="text-gray-700">{meta.allergies}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Signature */}
          <div className="mt-8 border-t border-gray-200 pt-6">
            <p className="text-xs font-medium uppercase text-gray-400 mb-2">Signature</p>
            {signatureImgUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={signatureImgUrl}
                alt="Signature"
                className="h-24 w-auto border-b-2 border-gray-900"
              />
            ) : (
              <div className="h-24 w-48 rounded border border-dashed border-gray-300 flex items-center justify-center">
                <span className="text-xs text-gray-400">Signature on file</span>
              </div>
            )}
            <p className="mt-2 text-sm font-medium text-gray-900">{signed.customer_name}</p>
            <p className="text-xs text-gray-500">{signedDate}</p>
          </div>

          {/* Footer */}
          <div className="mt-8 border-t border-gray-100 pt-4 text-center">
            <p className="text-[10px] text-gray-400">
              This document was electronically signed via Waaiio. Reference: {refCode}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
