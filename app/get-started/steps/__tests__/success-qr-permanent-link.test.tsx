// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { StepSuccess } from '../StepSuccess';
import type { StepSuccessProps } from '../types';

// Capture the value each QR code encodes.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: (p: { value: string }) => <span data-testid="qr-svg" data-value={p.value} />,
  QRCodeCanvas: (p: { value: string }) => <canvas data-testid="qr-canvas" data-value={p.value} />,
}));

const UUID_LINK = 'https://www.waaiio.com/m/123e4567-e89b-12d3-a456-426614174000';
const SHORT_LINK = 'https://www.waaiio.com/m/CITADEL';
const props: StepSuccessProps = {
  loading: false,
  successData: { bot_code: 'CITADEL', business_id: '123e4567-e89b-12d3-a456-426614174000' },
  waMethod: 'shared', waLink: SHORT_LINK, qrLink: UUID_LINK, category: 'shop', selectedCapabilities: ['ordering'],
  error: '', setStep: vi.fn(), setError: vi.fn(), fbConnectionData: null,
};
afterEach(cleanup);

describe('printed QR codes stay on the permanent link', () => {
  it('success screen: QR and downloadable QR encode the UUID link while the text shows the short link', async () => {
    render(<StepSuccess {...props} />);
    await waitFor(() => expect(screen.getByTestId('qr-svg')).toBeTruthy());
    expect(screen.getByTestId('qr-svg').getAttribute('data-value')).toBe(UUID_LINK);
    expect(screen.getByTestId('qr-canvas').getAttribute('data-value')).toBe(UUID_LINK);
    expect(screen.getByText(SHORT_LINK)).toBeTruthy();
  });

  it('success screen: never encodes a short link in a QR, even without qrLink', async () => {
    render(<StepSuccess {...props} qrLink={undefined} />);
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByTestId('qr-svg')).toBeNull();
    expect(screen.queryByTestId('qr-canvas')).toBeNull();
  });

  it('dashboard home: QR card encodes the permanent link, text uses the short link', () => {
    const src = readFileSync('app/dashboard/page.tsx', 'utf8');
    expect(src).toContain('const qrLink = buildMerchantLink(business.id);');
    expect(src).toContain('<QRCodeCanvas value={qrLink}');
    expect(src).not.toContain('<QRCodeCanvas value={whatsappLink}');
  });
});
