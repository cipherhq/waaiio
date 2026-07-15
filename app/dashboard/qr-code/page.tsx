'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PRICING_TIERS, type SubscriptionTier } from '@/lib/constants';
import { PageHelp } from '@/components/dashboard/PageHelp';

// ── Poster templates based on business capabilities / use case ──
const TEMPLATES = [
  { id: 'book',      label: 'Scan to Book',             subtitle: 'Book an appointment instantly',  color: '#7C3AED', emoji: '📅', capabilities: ['scheduling'] },
  { id: 'order',     label: 'Scan to Order',             subtitle: 'Browse our menu & order',        color: '#059669', emoji: '🛒', capabilities: ['ordering'] },
  { id: 'pay',       label: 'Scan to Pay',               subtitle: 'Make a quick payment',           color: '#2563EB', emoji: '💳', capabilities: ['payment'] },
  { id: 'ticket',    label: 'Scan to Buy Tickets',       subtitle: 'Get your tickets now',           color: '#DC2626', emoji: '🎟️', capabilities: ['ticketing'] },
  { id: 'donate',    label: 'Scan to Donate',            subtitle: 'Support our cause',              color: '#D97706', emoji: '🤲', capabilities: ['crowdfunding'] },
  { id: 'queue',     label: 'Scan to Check In',          subtitle: 'Join the queue',                 color: '#0891B2', emoji: '✅', capabilities: ['queue'] },
  { id: 'waitlist',  label: 'Scan to Join Waitlist',     subtitle: 'Get notified when available',    color: '#7C3AED', emoji: '⏳', capabilities: ['waitlist'] },
  { id: 'give',      label: 'Scan to Give',              subtitle: 'Tithes, offerings & donations',  color: '#059669', emoji: '🙏', capabilities: ['giving'] },
  { id: 'chat',      label: 'Scan to Chat',              subtitle: 'Chat with us on WhatsApp',       color: '#25D366', emoji: '💬', capabilities: ['chat'] },
  { id: 'generic',   label: 'Scan to Get Started',       subtitle: 'Connect with us on WhatsApp',    color: '#111827', emoji: '📱', capabilities: [] },
] as const;

type TemplateId = (typeof TEMPLATES)[number]['id'];

type PosterSize = 'a4' | 'table' | 'sticker' | 'social';

const POSTER_SIZES: Record<PosterSize, { width: number; height: number; name: string; label: string; description: string }> = {
  a4:      { width: 2480, height: 3508, name: 'poster',     label: 'A4 Poster',    description: 'Door / wall size' },
  table:   { width: 1200, height: 1600, name: 'table-tent', label: 'Table Tent',   description: 'Counter / table card' },
  sticker: { width: 800,  height: 800,  name: 'sticker',    label: 'Sticker',      description: 'Square QR + label' },
  social:  { width: 1080, height: 1080, name: 'social',     label: 'Social Media', description: 'Instagram / WhatsApp' },
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export default function QRCodePage() {
  const business = useBusiness();
  const [channelPhone, setChannelPhone] = useState('');
  const [channelLoaded, setChannelLoaded] = useState(false);

  // Load the actual WhatsApp channel phone number (not business.phone which is the owner's contact)
  useEffect(() => {
    async function loadChannelPhone() {
      const supabase = createClient();
      const channelId = business.assigned_channel_id || business.whatsapp_channel_id;

      // Fire all 3 queries in parallel
      const [assignedResult, dedicatedResult, sharedResult] = await Promise.all([
        channelId
          ? supabase.from('whatsapp_channels').select('phone_number').eq('id', channelId).eq('is_active', true).maybeSingle()
          : Promise.resolve({ data: null }),
        supabase.from('whatsapp_channels').select('phone_number')
          .eq('business_id', business.id).eq('channel_type', 'dedicated').eq('is_active', true).maybeSingle(),
        supabase.from('whatsapp_channels').select('phone_number')
          .eq('channel_type', 'shared').eq('is_active', true).limit(1).maybeSingle(),
      ]);

      // Priority: assigned > dedicated > shared > business.phone fallback
      const resolved = assignedResult.data?.phone_number
        || dedicatedResult.data?.phone_number
        || sharedResult.data?.phone_number
        || business.phone
        || '';

      setChannelPhone(resolved.replace(/[^0-9]/g, ''));
      setChannelLoaded(true);
    }
    loadChannelPhone();
  }, [business.id, business.assigned_channel_id, business.whatsapp_channel_id, business.phone]);

  const phone = channelPhone;
  const cleanPhone = phone;

  const isSharedNumber = !business.wa_method || business.wa_method === 'shared';
  const defaultPrefill = isSharedNumber && business.bot_code ? business.bot_code : 'Hi';
  const isWhitelabel = PRICING_TIERS[(business.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true;

  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>('generic');
  const [copied, setCopied] = useState(false);
  const [prefillText, setPrefillText] = useState(defaultPrefill);
  const [prefillManuallyEdited, setPrefillManuallyEdited] = useState(false);
  const posterRef = useRef<HTMLDivElement>(null);
  const qrOnlyRef = useRef<HTMLDivElement>(null);

  // Customization state
  const [customColor, setCustomColor] = useState('');
  const [customSubtitle, setCustomSubtitle] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);

  const template = TEMPLATES.find(t => t.id === selectedTemplate) || TEMPLATES[TEMPLATES.length - 1];

  // Derived effective values
  const effectiveColor = customColor || template.color;
  const effectiveSubtitle = customSubtitle || template.subtitle;
  const effectiveLabel = customLabel || template.label;

  // When template changes, auto-update prefill text with deep-link suffix
  function handleTemplateChange(templateId: TemplateId) {
    setSelectedTemplate(templateId);
    setCustomColor('');
    setCustomSubtitle('');
    setCustomLabel('');

    if (!prefillManuallyEdited) {
      const tmpl = TEMPLATES.find(t => t.id === templateId);
      const cap = tmpl?.capabilities?.[0];
      if (cap && isSharedNumber && business.bot_code) {
        setPrefillText(`${business.bot_code}:${cap}`);
      } else {
        setPrefillText(defaultPrefill);
      }
    }
  }

  const activeLink = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(prefillText)}`;

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

  // ── Download poster as high-res PNG ──
  async function downloadPoster(size: PosterSize = 'a4') {
    const sizeConfig = POSTER_SIZES[size];
    const { width, height } = sizeConfig;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cx = width / 2;

    // Try to load business logo
    let logoImg: HTMLImageElement | null = null;
    if (business.logo_url) {
      try {
        logoImg = await loadImage(business.logo_url);
      } catch {
        // Fall back to emoji
      }
    }

    const qrCanvas = qrOnlyRef.current?.querySelector('canvas');

    if (size === 'sticker') {
      // ── Sticker: minimal — white bg, QR centered, label below ──
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);

      // QR code centered
      if (qrCanvas) {
        const qrSize = 500;
        const qrX = (width - qrSize) / 2;
        const qrY = (height - qrSize) / 2 - 60;
        ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);
      }

      // Label below QR
      ctx.fillStyle = effectiveColor;
      ctx.font = 'bold 40px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(effectiveLabel, cx, height / 2 + 230);

      // Business name small below
      ctx.fillStyle = '#9CA3AF';
      ctx.font = '28px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(business.name || 'Your Business', cx, height / 2 + 280);

      // Powered by Waaiio
      if (!isWhitelabel) {
        ctx.fillStyle = '#D1D5DB';
        ctx.font = '18px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('Powered by Waaiio', cx, height - 30);
      }
    } else if (size === 'social') {
      // ── Social Media: colored bg, name, QR on white card, label ──
      ctx.fillStyle = effectiveColor;
      ctx.fillRect(0, 0, width, height);

      // Business name at top
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 60px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(business.name || 'Your Business', cx, 120);

      // Subtitle
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = '32px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(effectiveSubtitle, cx, 180);

      // Logo or emoji
      if (logoImg) {
        const logoSize = 100;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, 280, logoSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(logoImg, cx - logoSize / 2, 280 - logoSize / 2, logoSize, logoSize);
        ctx.restore();
      } else {
        ctx.font = '80px serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(template.emoji, cx, 290);
      }

      // White card with QR
      if (qrCanvas) {
        const qrSize = 500;
        const cardPad = 40;
        const cardW = qrSize + cardPad * 2;
        const cardH = qrSize + cardPad * 2;
        const cardX = (width - cardW) / 2;
        const cardY = 360;

        ctx.fillStyle = '#FFFFFF';
        ctx.shadowColor = 'rgba(0,0,0,0.15)';
        ctx.shadowBlur = 30;
        ctx.shadowOffsetY = 6;
        roundRect(ctx, cardX, cardY, cardW, cardH, 24);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;

        ctx.drawImage(qrCanvas, cardX + cardPad, cardY + cardPad, qrSize, qrSize);
      }

      // Label below QR
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(effectiveLabel, cx, 960);

      // WhatsApp label at bottom
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText('WhatsApp', cx, 1020);

      // Powered by Waaiio
      if (!isWhitelabel) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '20px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('Powered by Waaiio', cx, 1060);
      }
    } else {
      // ── Full layout: A4 and Table Tent ──
      // Scale factor relative to A4
      const scale = size === 'table' ? width / 2480 : 1;

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);

      // Top color bar
      const headerH = Math.round(1050 * scale);
      ctx.fillStyle = effectiveColor;
      ctx.fillRect(0, 0, width, headerH);

      // Business name
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold ${Math.round(120 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(business.name || 'Your Business', cx, Math.round(350 * scale));

      // Subtitle
      ctx.font = `${Math.round(64 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(effectiveSubtitle, cx, Math.round(500 * scale));

      // Logo or Emoji (large)
      if (logoImg) {
        const logoSize = Math.round(200 * scale);
        const logoY = Math.round(800 * scale);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, logoY, logoSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(logoImg, cx - logoSize / 2, logoY - logoSize / 2, logoSize, logoSize);
        ctx.restore();
      } else {
        ctx.font = `${Math.round(200 * scale)}px serif`;
        ctx.fillText(template.emoji, cx, Math.round(800 * scale));
      }

      // QR Code
      if (qrCanvas) {
        const qrSize = Math.round(1000 * scale);
        const qrX = (width - qrSize) / 2;
        const qrY = headerH + Math.round(120 * scale);

        // White card behind QR with shadow
        ctx.fillStyle = '#FFFFFF';
        ctx.shadowColor = 'rgba(0,0,0,0.12)';
        ctx.shadowBlur = Math.round(60 * scale);
        ctx.shadowOffsetY = Math.round(12 * scale);
        const pad = Math.round(60 * scale);
        const rad = Math.round(40 * scale);
        roundRect(ctx, qrX - pad, qrY - pad, qrSize + pad * 2, qrSize + pad * 2, rad);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;

        // Border
        ctx.strokeStyle = '#E5E7EB';
        ctx.lineWidth = Math.round(3 * scale);
        roundRect(ctx, qrX - pad, qrY - pad, qrSize + pad * 2, qrSize + pad * 2, rad);
        ctx.stroke();

        ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);
      }

      // Action label
      const actionY = headerH + Math.round(1280 * scale);
      ctx.fillStyle = effectiveColor;
      ctx.font = `bold ${Math.round(100 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(effectiveLabel, cx, actionY);

      // Divider
      const divY = actionY + Math.round(80 * scale);
      ctx.strokeStyle = '#D1D5DB';
      ctx.lineWidth = Math.round(3 * scale);
      ctx.beginPath();
      ctx.moveTo(Math.round(400 * scale), divY);
      ctx.lineTo(width - Math.round(400 * scale), divY);
      ctx.stroke();

      // Fallback text
      const fallbackY = divY + Math.round(100 * scale);
      ctx.fillStyle = '#6B7280';
      ctx.font = `${Math.round(52 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillText('Or send a message to', cx, fallbackY);

      // Phone number
      ctx.fillStyle = '#111827';
      ctx.font = `bold ${Math.round(80 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillText(phone || cleanPhone, cx, fallbackY + Math.round(120 * scale));

      // WhatsApp label
      ctx.fillStyle = '#25D366';
      ctx.font = `bold ${Math.round(48 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillText('WhatsApp', cx, fallbackY + Math.round(200 * scale));

      // Footer (hidden for whitelabel)
      if (!isWhitelabel) {
        const footerH = Math.round(280 * scale);
        const footerY = height - footerH;

        ctx.fillStyle = '#111827';
        ctx.fillRect(0, footerY, width, footerH);

        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = `${Math.round(40 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('Powered by', cx, footerY + Math.round(90 * scale));

        ctx.font = `bold ${Math.round(80 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
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
          ctx.fillText(part.text, logoX, footerY + Math.round(190 * scale));
          logoX += ctx.measureText(part.text).width;
        }
        ctx.textAlign = 'center';
      }
    }

    // Download
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${business.slug || 'poster'}-${template.id}-${sizeConfig.name}.png`;
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
        <PageHelp
          pageKey="qr-code"
          title="QR Code & Link"
          description="Share your booking link or WhatsApp QR code. Print it, add it to your website, or share on social media."
        />
      </div>

      {channelLoaded && !phone && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>No WhatsApp number found.</strong> Please connect a WhatsApp number in{' '}
          <a href="/dashboard/whatsapp/connect" className="font-medium underline hover:no-underline">WhatsApp Setup</a>{' '}
          to generate a working QR code and link.
        </div>
      )}

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
                onChange={e => { setPrefillText(e.target.value); setPrefillManuallyEdited(true); }}
                placeholder="Hi"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-gray-400">This message auto-fills when customers open the link</p>
              {isSharedNumber && business.bot_code && (
                <p className="mt-1 text-xs text-amber-600">
                  {prefillText.includes(':')
                    ? `Smart QR: Customers who scan will go straight to the ${prefillText.split(':').pop()} flow — no menu needed.`
                    : `Tip: Keep your bot code "${business.bot_code}" as the pre-filled message so customers get routed to your business automatically.`
                  }
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
                  onClick={() => handleTemplateChange(t.id)}
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

          {/* Brand Color */}
          <div className="rounded-xl border border-gray-100 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Brand Color</h2>
            <p className="mt-1 text-xs text-gray-400">Override the template color with your brand color</p>
            <div className="mt-3 flex items-center gap-3">
              <input
                type="color"
                value={effectiveColor}
                onChange={e => setCustomColor(e.target.value)}
                className="h-10 w-14 cursor-pointer rounded-lg border border-gray-200"
              />
              <span className="font-mono text-sm text-gray-500">{effectiveColor}</span>
              {customColor && (
                <button
                  onClick={() => setCustomColor('')}
                  className="text-xs text-brand hover:underline"
                >
                  Reset to template color
                </button>
              )}
            </div>
          </div>

          {/* Customize Text */}
          <div className="rounded-xl border border-gray-100 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Customize Text</h2>
            <p className="mt-1 text-xs text-gray-400">Edit the subtitle and call-to-action label on the poster</p>
            <div className="mt-3 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Subtitle</label>
                <input
                  type="text"
                  value={customSubtitle}
                  onChange={e => setCustomSubtitle(e.target.value)}
                  placeholder={template.subtitle}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">CTA Label</label>
                <input
                  type="text"
                  value={customLabel}
                  onChange={e => setCustomLabel(e.target.value)}
                  placeholder={template.label}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
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
                style={{ backgroundColor: effectiveColor }}
              >
                <h3 className="text-center text-xl font-bold text-white">{business.name}</h3>
                <p className="mt-1 text-center text-sm text-white/80">{effectiveSubtitle}</p>
                {business.logo_url ? (
                  <img
                    src={business.logo_url}
                    alt={business.name || 'Business logo'}
                    className="mt-2 h-16 w-16 rounded-full object-cover"
                  />
                ) : (
                  <span className="mt-2 text-3xl">{template.emoji}</span>
                )}
              </div>

              {/* QR code section */}
              <div className="flex flex-col items-center px-6 py-8">
                <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
                  <QRCodeCanvas value={activeLink} size={180} level="H" />
                </div>

                <p
                  className="mt-5 text-center text-lg font-bold"
                  style={{ color: effectiveColor }}
                >
                  {effectiveLabel}
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

            {/* Download buttons */}
            <div className="relative mt-4">
              <button
                onClick={() => setDownloadMenuOpen(!downloadMenuOpen)}
                className="w-full rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand-600"
              >
                Download Poster (PNG)
              </button>
              {downloadMenuOpen && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                  {(Object.entries(POSTER_SIZES) as [PosterSize, typeof POSTER_SIZES[PosterSize]][]).map(([key, cfg]) => (
                    <button
                      key={key}
                      onClick={() => {
                        setDownloadMenuOpen(false);
                        downloadPoster(key);
                      }}
                      className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-gray-50"
                    >
                      <div>
                        <p className="font-medium text-gray-900">{cfg.label}</p>
                        <p className="text-xs text-gray-400">{cfg.description} ({cfg.width}x{cfg.height})</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
