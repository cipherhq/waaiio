/**
 * Platform Campaigns — QR generation contract tests (#439)
 *
 * Proves:
 * - QR uses proven qrcode.react library (not a custom encoder)
 * - QR value is the canonical tracked URL (VITE_API_URL/go/<token>)
 * - QR does NOT encode direct wa.me URLs
 * - Copy Link and QR use the same tracked URL authority (getTrackedUrl)
 * - PNG download references the QRCodeCanvas element
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../pages/PlatformCampaigns.tsx'),
  'utf-8',
);

describe('Platform Campaigns — QR generation (#439)', () => {
  it('imports QRCodeCanvas from qrcode.react (proven library)', () => {
    expect(SRC).toContain("from 'qrcode.react'");
    expect(SRC).toContain('QRCodeCanvas');
  });

  it('does NOT contain a custom generateQRMatrix function', () => {
    expect(SRC).not.toContain('generateQRMatrix');
  });

  it('does NOT contain a custom renderQRCode function', () => {
    expect(SRC).not.toContain('renderQRCode');
  });

  it('QRCodeCanvas value is getTrackedUrl (canonical /go/<token>)', () => {
    // The QRCodeCanvas component must use getTrackedUrl for its value prop
    expect(SRC).toMatch(/QRCodeCanvas[\s\S]*?value=\{getTrackedUrl\(/);
  });

  it('getTrackedUrl produces canonical /go/<token> URL from VITE_API_URL', () => {
    // getTrackedUrl must reference VITE_API_URL and /go/
    expect(SRC).toMatch(/function getTrackedUrl/);
    expect(SRC).toContain('VITE_API_URL');
    expect(SRC).toContain('/go/');
  });

  it('getTrackedUrl does NOT contain wa.me', () => {
    // Extract the getTrackedUrl function body
    const fnStart = SRC.indexOf('function getTrackedUrl');
    const fnEnd = SRC.indexOf('}', SRC.indexOf('{', fnStart)) + 1;
    const fnBody = SRC.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain('wa.me');
  });

  it('Copy Link uses the same getTrackedUrl authority as QR', () => {
    // copyTrackedLink must also call getTrackedUrl
    expect(SRC).toMatch(/function copyTrackedLink[\s\S]*?getTrackedUrl\(/);
  });

  it('QR and Copy Link both derive from getTrackedUrl (single authority)', () => {
    // Count references to getTrackedUrl — QR value + Copy Link + display text
    const matches = SRC.match(/getTrackedUrl\(/g) || [];
    // At least 3: QRCodeCanvas value, copyTrackedLink, and display text
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('PNG download reads from the QRCodeCanvas element', () => {
    // downloadQR must getElementById to find the canvas rendered by QRCodeCanvas
    expect(SRC).toContain('getElementById');
    expect(SRC).toContain('toDataURL');
    expect(SRC).toContain('.png');
  });

  it('QRCodeCanvas uses error correction level M', () => {
    expect(SRC).toMatch(/QRCodeCanvas[\s\S]*?level="M"/);
  });
});
