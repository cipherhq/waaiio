'use client';

import { useState, useRef, useCallback } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PRICING_TIERS, type SubscriptionTier } from '@/lib/constants';

// ── Poster templates based on business capabilities / use case ──
const TEMPLATES = [
  { id: 'book',      label: 'Scan to Book',             subtitle: 'Book an appointment instantly',  color: '#7C3AED', emoji: '📅', capabilities: ['scheduling'] },
  { id: 'order',     label: 'Scan to Order',             subtitle: 'Browse our menu & order',        color: '#059669', emoji: '🛒', capabilities: ['ordering'] },
  { id: 'pay',       label: 'Scan to Pay',               subtitle: 'Make a quick payment',           color: '#2563EB', emoji: '💳', capabilities: ['payment'] },
  { id: 'ticket',    label: 'Scan to Buy Tickets',       subtitle: 'Get your tickets now',           color: '#DC2626', emoji: '🎟️', capabilities: ['ticketing'] },
  { id: 'donate',    label: 'Scan to Donate',            subtitle: 'Support our cause',              color: '#D97706', emoji: '🤲', capabilities: ['crowdfunding'] },
  { id: 'queue',     label: 'Scan to Check In',          subtitle: 'Join the queue',                 color: '#0891B2', emoji: '✅', capabilities: ['queue'] },
  { id: 'waitlist',  label: 'Scan to Join Waitlist',     subtitle: 'Get notified when available',    color: '#7C3AED', emoji: '⏳', capabilities: ['waitlist'] },
  { id: 'chat',      label: 'Scan to Chat',              subtitle: 'Chat with us on WhatsApp',       color: '#25D366', emoji: '💬', capabilities: [] },
  { id: 'generic',   label: 'Scan to Get Started',       subtitle: 'Connect with us on WhatsApp',    color: '#111827', emoji: '📱', capabilities: [] },
] as const;

type TemplateId = (typeof TEMPLATES)[number]['id'];

export default function QRCodePage() {
  const business = useBusiness();
  const phone = business.phone?.replace(/[^0-9+]/g, '') || '';
  const cleanPhone = phone.startsWith('+') ? phone.slice(1) : phone;
  const waLink = `https://wa.me/${cleanPhone}?text=Hi`;

  const isSharedNumber = !business.wa_method || business.wa_method === 'shared';
  const defaultPrefill = isSharedNumber && business.bot_code ? business.bot_code : 'Hi';
  const isWhitelabel = PRICING_TIERS[(business.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true;

  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>('generic');
  const [copied, setCopied] = useState(false);
  const [prefillText, setPrefillText] = useState(defaultPrefill);
  const posterRef = useRef<HTMLDivElement>(null);
  const qrOnlyRef = useRef<HTMLDivElement>(null);

  const activeLink = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(prefillText)}`;
  const template = TEMPLATES.find(t => t.id === selectedTemplate) || TEMPLATES[TEMPLATES.length - 1];

  // Filter templates to show relevant ones first (matching capabilities), then generic
  const relevantTemplates = TEMPLATES.filter(t =>
    t.capabilities.length === 0 || t.capabilities.some(c => business.capabilities?.includes(c as never))
  );

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(activeLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [activeLink]);

  // ── Download QR only as PNG ──
  function downloadQROnly() {
    const canvas = qrOnlyRef.current?.querySelector('canvas');
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${business.slug || 'qr-code'}-whatsapp.png`;
    a.click();
  }

  // ── Download poster as high-res PNG (A4 door-size: 2480x3508 @ 300dpi) ──
  function downloadPoster() {
    // A4 at 300 DPI = 2480 x 3508 pixels — large enough to print and paste on a door
    const width = 2480;
    const height = 3508;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cx = width / 2;

    // ── Background ──
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    // ── Top color bar (30% of height) ──
    const headerH = 1050;
    ctx.fillStyle = template.color;
    ctx.fillRect(0, 0, width, headerH);

    // Business name
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 120px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(business.name || 'Your Business', cx, 350);

    // Subtitle
    ctx.font = '64px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(template.subtitle, cx, 500);

    // Emoji (large)
    ctx.font = '200px serif';
    ctx.fillText(template.emoji, cx, 800);

    // ── QR Code (large, centered) ──
    const qrCanvas = qrOnlyRef.current?.querySelector('canvas');
    if (qrCanvas) {
      const qrSize = 1000;
      const qrX = (width - qrSize) / 2;
      const qrY = headerH + 120;

      // White card behind QR with shadow
      ctx.fillStyle = '#FFFFFF';
      ctx.shadowColor = 'rgba(0,0,0,0.12)';
      ctx.shadowBlur = 60;
      ctx.shadowOffsetY = 12;
      roundRect(ctx, qrX - 60, qrY - 60, qrSize + 120, qrSize + 120, 40);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      // Border around QR card
      ctx.strokeStyle = '#E5E7EB';
      ctx.lineWidth = 3;
      roundRect(ctx, qrX - 60, qrY - 60, qrSize + 120, qrSize + 120, 40);
      ctx.stroke();

      ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);
    }

    // ── Action label (big & bold) ──
    const actionY = headerH + 1280;
    ctx.fillStyle = template.color;
    ctx.font = 'bold 100px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(template.label, cx, actionY);

    // ── Divider line ──
    const divY = actionY + 80;
    ctx.strokeStyle = '#D1D5DB';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(400, divY);
    ctx.lineTo(width - 400, divY);
    ctx.stroke();

    // ── Fallback text ──
    const fallbackY = divY + 100;
    ctx.fillStyle = '#6B7280';
    ctx.font = '52px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('Or send a message to', cx, fallbackY);

    // Phone number (large)
    ctx.fillStyle = '#111827';
    ctx.font = 'bold 80px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(phone || cleanPhone, cx, fallbackY + 120);

    // WhatsApp label
    ctx.fillStyle = '#25D366';
    ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('WhatsApp', cx, fallbackY + 200);

    // ── Bottom bar — Powered by Waaiio (hidden for whitelabel) ──
    if (!isWhitelabel) {
      const footerH = 280;
      const footerY = height - footerH;

      // Footer background
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, footerY, width, footerH);

      // "Powered by" text
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '40px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Powered by', cx, footerY + 90);

      // Waaiio logo text (large, bold, colored)
      ctx.font = 'bold 80px -apple-system, BlinkMacSystemFont, sans-serif';
      const parts = [
        { text: 'wa', color: '#25D366' },
        { text: 'ai', color: '#E5993E' },
        { text: 'io', color: '#B5A3E0' },
      ];
      const fullWidth = ctx.measureText('waaiio').width;
      let logoX = cx - fullWidth / 2;
      for (const part of parts) {
        ctx.fillStyle = part.color;
        ctx.textAlign = 'left';
        ctx.fillText(part.text, logoX, footerY + 190);
        logoX += ctx.measureText(part.text).width;
      }
      ctx.textAlign = 'center';
    }

    // ── Download ──
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${business.slug || 'poster'}-${template.id}-print.png`;
    a.click();
  }

  return (
    <div>
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">QR Code & WhatsApp Link</h1>
        <p className="mt-1 text-sm text-gray-500">
          Share your QR code or link so customers can reach you on WhatsApp instantly
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* ── Left: Settings ── */}
        <div className="space-y-6">
          {/* WhatsApp Link */}
          <div className="rounded-xl border border-gray-100 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Your WhatsApp Link</h2>
            <p className="mt-1 text-xs text-gray-400">Share this link on your website, social media, or email</p>
            <div className="mt-3 flex gap-2">
              <div className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
                <p className="truncate font-mono text-sm text-gray-700">{activeLink}</p>
              </div>
              <button
                onClick={copyLink}
                className={`shrink-0 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
                  copied
                    ? 'bg-green-500 text-white'
                    : 'bg-brand text-white hover:bg-brand-600'
                }`}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-500">Pre-filled message</label>
              <input
                type="text"
                value={prefillText}
                onChange={e => setPrefillText(e.target.value)}
                placeholder="Hi"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-gray-400">This message auto-fills when customers open the link</p>
              {isSharedNumber && business.bot_code && (
                <p className="mt-1 text-xs text-amber-600">
                  Tip: Keep your bot code &quot;{business.bot_code}&quot; as the pre-filled message so customers get routed to your business automatically.
                </p>
              )}
            </div>
          </div>

          {/* QR Code Download (plain) */}
          <div className="rounded-xl border border-gray-100 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Plain QR Code</h2>
            <p className="mt-1 text-xs text-gray-400">Download just the QR code to use in your own designs</p>
            <div className="mt-4 flex items-center gap-4">
              <div ref={qrOnlyRef} className="rounded-lg border border-gray-100 p-3">
                <QRCodeCanvas value={activeLink} size={120} level="H" />
              </div>
              <button
                onClick={downloadQROnly}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Download PNG
              </button>
            </div>
          </div>

          {/* Template selector */}
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Poster Template</h2>
            <p className="mt-1 text-xs text-gray-400">Pick a design based on what you want customers to do</p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {relevantTemplates.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTemplate(t.id)}
                  className={`rounded-lg border p-3 text-left transition ${
                    selectedTemplate === t.id
                      ? 'border-brand bg-brand-50 ring-1 ring-brand/20'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <span className="text-lg">{t.emoji}</span>
                  <p className="mt-1 text-xs font-semibold text-gray-900">{t.label}</p>
                  <p className="mt-0.5 text-xs text-gray-400 line-clamp-1">{t.subtitle}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: Poster Preview ── */}
        <div>
          <div className="sticky top-6">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">Poster Preview</h2>

            {/* Preview card */}
            <div
              ref={posterRef}
              className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg"
              style={{ maxWidth: 380 }}
            >
              {/* Color header */}
              <div
                className="flex flex-col items-center justify-center px-6 py-8"
                style={{ backgroundColor: template.color }}
              >
                <h3 className="text-center text-xl font-bold text-white">{business.name}</h3>
                <p className="mt-1 text-center text-sm text-white/80">{template.subtitle}</p>
                <span className="mt-2 text-3xl">{template.emoji}</span>
              </div>

              {/* QR code section */}
              <div className="flex flex-col items-center px-6 py-8">
                <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
                  <QRCodeCanvas value={activeLink} size={180} level="H" />
                </div>

                <p
                  className="mt-5 text-center text-lg font-bold"
                  style={{ color: template.color }}
                >
                  {template.label}
                </p>
              </div>

              {/* Divider + fallback */}
              <div className="border-t border-gray-100 px-6 py-4 text-center">
                <p className="text-xs text-gray-400">Or send a message to</p>
                <p className="mt-1 text-lg font-bold text-gray-900">{phone || cleanPhone}</p>
                <p className="mt-0.5 text-xs font-medium text-green-500">WhatsApp</p>
              </div>

              {/* Footer — hidden for whitelabel */}
              {!isWhitelabel && (
                <div className="bg-gray-50 px-6 py-3 text-center">
                  <p className="text-xs text-gray-400">Powered by Waaiio</p>
                </div>
              )}
            </div>

            {/* Download button */}
            <button
              onClick={downloadPoster}
              className="mt-4 w-full rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand-600"
            >
              Download Poster (PNG)
            </button>
            <p className="mt-2 text-center text-xs text-gray-400">
              Print this and place it at your counter, storefront, or on flyers
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// Canvas helper for rounded rectangles
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
