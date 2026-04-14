import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Waaiio — AI-Powered WhatsApp Automation for Every Business';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: 'linear-gradient(135deg, #7c3aed 0%, #4f46e5 50%, #2563eb 100%)',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '60px 80px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            marginBottom: '32px',
          }}
        >
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '14px',
              background: 'rgba(255,255,255,0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '28px',
              color: 'white',
              fontWeight: 700,
            }}
          >
            W
          </div>
          <span
            style={{
              fontSize: '48px',
              fontWeight: 700,
              color: 'white',
              letterSpacing: '-1px',
            }}
          >
            waaiio
          </span>
        </div>

        <div
          style={{
            fontSize: '36px',
            fontWeight: 700,
            color: 'white',
            textAlign: 'center',
            lineHeight: 1.3,
            maxWidth: '800px',
          }}
        >
          AI-Powered WhatsApp Automation for Every Business
        </div>

        <div
          style={{
            fontSize: '20px',
            color: 'rgba(255,255,255,0.8)',
            textAlign: 'center',
            marginTop: '20px',
            maxWidth: '700px',
            lineHeight: 1.5,
          }}
        >
          Bookings, payments, orders, ticketing, loyalty, broadcasts &amp; more — 40+ industries, 5 countries
        </div>

        <div
          style={{
            display: 'flex',
            gap: '24px',
            marginTop: '40px',
          }}
        >
          {['Nigeria', 'US', 'UK', 'Canada', 'Ghana'].map((c) => (
            <div
              key={c}
              style={{
                background: 'rgba(255,255,255,0.15)',
                borderRadius: '8px',
                padding: '8px 16px',
                fontSize: '14px',
                color: 'rgba(255,255,255,0.9)',
              }}
            >
              {c}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
