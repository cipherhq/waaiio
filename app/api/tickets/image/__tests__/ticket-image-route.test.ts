/**
 * R3 Blocker 2: Ticket image route test.
 *
 * Proves:
 * - Flyer path works (event.image_url present)
 * - No-flyer fallback works
 * - Waaiio logo appears for non-white-label
 * - Waaiio logo does NOT appear for white-label/business tier
 * - QR payload remains exactly: https://waaiio.com/tickets/${ticketCode}
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the JSX tree from ImageResponse
let capturedJsx: any = null;
vi.mock('next/og', () => ({
  ImageResponse: class MockImageResponse {
    status = 200;
    constructor(jsx: unknown, _opts: unknown) { capturedJsx = jsx; }
  },
}));

// Configurable ticket data
let mockTicketData: any = null;
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({ data: mockTicketData, error: null })),
        })),
      })),
    })),
  })),
}));

const TICKET_CODE = 'TK-TEST01';
const FLYER_URL = 'https://storage.example.com/events/flyer.jpg';

function setTicket(opts: { imageUrl?: string | null; subscriptionTier?: string; logoUrl?: string | null }) {
  mockTicketData = {
    ticket_code: TICKET_CODE,
    guest_name: 'Adebayo Olumide',
    status: 'valid',
    events: {
      name: 'Praise Night 2026',
      date: '2026-09-20',
      time: '7:00 PM',
      venue: 'Citadel Arena, Lagos',
      image_url: opts.imageUrl ?? null,
    },
    businesses: {
      name: 'Citadel of Grace',
      logo_url: opts.logoUrl ?? null,
      subscription_tier: opts.subscriptionTier ?? 'free',
    },
  };
}

// Walk JSX tree
function findInJsx(node: any, predicate: (n: any) => boolean): any[] {
  const results: any[] = [];
  if (!node) return results;
  if (predicate(node)) results.push(node);
  const children = node?.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) results.push(...findInJsx(child, predicate));
  } else if (children && typeof children === 'object') {
    results.push(...findInJsx(children, predicate));
  }
  return results;
}

describe('Ticket image route', () => {
  beforeEach(() => { capturedJsx = null; });

  it('with flyer: event image used as background', async () => {
    setTicket({ imageUrl: FLYER_URL });
    const { GET } = await import('../route');
    const req = new Request(`https://waaiio.com/api/tickets/image?code=${TICKET_CODE}`);
    await GET(req as any);

    const images = findInJsx(capturedJsx, (n: any) => n?.type === 'img');
    const flyerImg = images.find((img: any) => img.props?.src === FLYER_URL);
    expect(flyerImg, 'Event flyer image should be rendered').toBeTruthy();
  });

  it('no flyer: dark gradient fallback', async () => {
    setTicket({ imageUrl: null });
    const { GET } = await import('../route');
    const req = new Request(`https://waaiio.com/api/tickets/image?code=${TICKET_CODE}`);
    await GET(req as any);

    const images = findInJsx(capturedJsx, (n: any) => n?.type === 'img');
    const flyerImg = images.find((img: any) => img.props?.src === FLYER_URL);
    expect(flyerImg).toBeFalsy();

    const rootStyle = capturedJsx?.props?.style;
    expect(rootStyle?.background).toContain('gradient');
  });

  it('non-white-label: Waaiio logo image present', async () => {
    setTicket({ imageUrl: null, subscriptionTier: 'free' });
    const { GET } = await import('../route');
    const req = new Request(`https://waaiio.com/api/tickets/image?code=${TICKET_CODE}`);
    await GET(req as any);

    const images = findInJsx(capturedJsx, (n: any) => n?.type === 'img');
    const waaiioLogo = images.find((img: any) =>
      typeof img.props?.src === 'string' && img.props.src.includes('logo.png')
    );
    expect(waaiioLogo, 'Waaiio logo should appear for non-white-label').toBeTruthy();
  });

  it('white-label (business tier): NO Waaiio logo', async () => {
    setTicket({ imageUrl: null, subscriptionTier: 'business', logoUrl: 'https://biz.com/logo.png' });
    const { GET } = await import('../route');
    const req = new Request(`https://waaiio.com/api/tickets/image?code=${TICKET_CODE}`);
    await GET(req as any);

    const images = findInJsx(capturedJsx, (n: any) => n?.type === 'img');
    const waaiioLogo = images.find((img: any) =>
      typeof img.props?.src === 'string' && img.props.src.includes('logo.png') && img.props.src.includes('waaiio')
    );
    expect(waaiioLogo, 'Waaiio logo must NOT appear for business tier').toBeFalsy();
  });

  it('QR payload is exactly https://waaiio.com/tickets/{ticketCode}', async () => {
    setTicket({ imageUrl: null });
    const { GET } = await import('../route');
    const req = new Request(`https://waaiio.com/api/tickets/image?code=${TICKET_CODE}`);
    await GET(req as any);

    const images = findInJsx(capturedJsx, (n: any) => n?.type === 'img');
    const qrImg = images.find((img: any) =>
      typeof img.props?.src === 'string' && img.props.src.includes('qrserver.com')
    );
    expect(qrImg, 'QR code image should exist').toBeTruthy();

    const expectedPayload = `https://waaiio.com/tickets/${TICKET_CODE}`;
    const qrSrc = qrImg.props.src as string;
    expect(qrSrc).toContain(encodeURIComponent(expectedPayload));
  });
});
