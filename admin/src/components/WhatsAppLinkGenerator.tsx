import { useMemo, useState } from 'react';
import { Check, ExternalLink, Link2, MessageCircle } from 'lucide-react';
import { buildWhatsAppLink } from '@/lib/whatsappLink';

export function WhatsAppLinkGenerator({
  onUseLink,
}: {
  onUseLink: (url: string) => void;
}) {
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);

  const generated = useMemo(() => {
    if (!phone.trim()) return { url: null as string | null, error: null as string | null };
    try {
      return { url: buildWhatsAppLink({ phone, message }).url, error: null };
    } catch (error) {
      return {
        url: null,
        error: error instanceof Error ? error.message : 'Unable to generate WhatsApp link.',
      };
    }
  }, [phone, message]);

  function handlePreview() {
    if (!generated.url) return;
    window.open(generated.url, '_blank', 'noopener,noreferrer');
  }

  function handleUseLink() {
    if (!generated.url) return;
    onUseLink(generated.url);
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-800 hover:bg-green-100"
      >
        <MessageCircle className="h-3.5 w-3.5" />
        {open ? 'Hide WhatsApp Link Generator' : 'Generate WhatsApp Link'}
      </button>

      {open && (
        <div className="mt-3 space-y-3 rounded-xl border border-green-200 bg-green-50/40 p-4">
          <div>
            <label htmlFor="whatsapp-link-phone" className="mb-1 block text-xs font-semibold text-gray-700">
              Destination WhatsApp number
            </label>
            <input
              id="whatsapp-link-phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+1 301 555 0123"
              autoComplete="off"
              className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Include country code and start with + or 00. No number is hardcoded or saved by this helper.
            </p>
          </div>

          <div>
            <label htmlFor="whatsapp-link-message" className="mb-1 block text-xs font-semibold text-gray-700">
              Prefilled message <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              id="whatsapp-link-message"
              rows={2}
              maxLength={1000}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Hi Waaiio, I want launch updates."
              className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[11px] text-gray-400">{message.length}/1000 characters</p>
          </div>

          {generated.error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {generated.error}
            </div>
          )}

          {generated.url && (
            <div className="space-y-2">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Preview
                </p>
                <div
                  data-testid="whatsapp-link-preview"
                  className="break-all rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs text-gray-700"
                >
                  {generated.url}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handlePreview}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open Preview
                </button>
                <button
                  type="button"
                  onClick={handleUseLink}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-800"
                >
                  <Check className="h-3.5 w-3.5" />
                  Use This Link
                </button>
              </div>

              <p className="flex items-start gap-1.5 text-[11px] text-gray-500">
                <Link2 className="mt-0.5 h-3 w-3 shrink-0" />
                Using the link only updates the CTA draft field. It does not save or make the announcement live.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
