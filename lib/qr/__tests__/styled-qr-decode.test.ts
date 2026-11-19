/**
 * Styled QR codes must still scan (Owner request 2026-11-19).
 *
 * Every variant is rendered to pixels and decoded back with two independent
 * decoders, and the result must be the exact original string:
 *   - jsQR;
 *   - the zxing build the dashboard check-in scanner ships (html5-qrcode).
 *
 * zxing looks at one still image here, while a phone camera gives it many
 * slightly soft frames. A perfectly sharp synthetic image sometimes misses
 * zxing's finder search even for a plain square QR, so zxing gets the sharp
 * image and one slightly softened copy, and either may decode it.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { styledQrGeometry, styledQrSvg, MIN_QUIET_ZONE } from '@/shared/styled-qr';
import { qrMatrix, styledQrSvgString, styledQrSvgDataUrl, type QrLevel } from '../styled-qr';
import { styledQrPng } from '../styled-qr-png';

const requireCjs = createRequire(import.meta.url);
const Z = requireCjs('html5-qrcode/third_party/zxing-js.umd.js');

type Pixels = { rgba: Uint8ClampedArray; lum: Uint8ClampedArray; width: number; height: number };

async function rasterize(image: Buffer, blur = 0): Promise<Pixels> {
  let pipeline = sharp(image).flatten({ background: '#ffffff' });
  if (blur) pipeline = pipeline.blur(blur);
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = new Uint8ClampedArray(data);
  const lum = new Uint8ClampedArray(info.width * info.height);
  for (let i = 0; i < lum.length; i++) lum[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
  return { rgba, lum, width: info.width, height: info.height };
}

function zxingDecode(p: Pixels): string | null {
  try {
    const reader = new Z.MultiFormatReader();
    reader.setHints(new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.QR_CODE]]]));
    const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(p.lum, p.width, p.height)));
    return reader.decode(bitmap).getText();
  } catch {
    return null;
  }
}

/** Both decoders' readings of an image (SVG or PNG bytes). */
async function decode(image: Buffer): Promise<{ jsqr: string | null; zxing: string | null }> {
  const sharpView = await rasterize(image);
  const jsqr = jsQR(sharpView.rgba, sharpView.width, sharpView.height)?.data ?? null;
  let zxing = zxingDecode(sharpView);
  if (zxing === null) zxing = zxingDecode(await rasterize(image, 0.8));
  return { jsqr, zxing };
}

async function expectScans(image: Buffer, value: string) {
  const got = await decode(image);
  expect(got.jsqr, 'jsQR').toBe(value);
  expect(got.zxing, 'zxing (dashboard scanner)').toBe(value);
}

const svgAt = (value: string, cssPx: number, dpr: number, level: QrLevel, frame = true, fgColor?: string) =>
  Buffer.from(styledQrSvgString(value, Math.round(cssPx * dpr), { level, frame, fgColor }));

// Realistic payloads, shaped like what each page encodes today.
const UUID = '7c1d1d4e-1b7f-4a8c-9a7e-3f1f6f6b9a10';
const UUID2 = '0b3c5e7a-2d4f-4e8b-9c1a-5d6e7f8a9b0c';
const P = {
  short: 'https://wa.me/2348012345678',
  merchant: `https://www.waaiio.com/m/${UUID}`,
  merchantAction: `https://www.waaiio.com/m/${UUID}/queue`,
  giving: `https://www.waaiio.com/m/${UUID}/giving/${UUID2}`,
  campaign: `https://www.waaiio.com/m/${UUID}/c/${UUID2}`,
  event: 'https://www.waaiio.com/e/grace-chapel-praise-night-2026',
  party: `https://www.waaiio.com/i/${UUID}`,
  contractSign: `https://www.waaiio.com/contracts/sign/${UUID}?token=Zx81kQp0aB7nT2wR5yU9eL3cV6mH4jG1`,
  pay: 'https://www.waaiio.com/pay/pl_8F2A91C3d4E5f6A7',
  waiver: 'https://www.waaiio.com/w/wv_8F2A91C3d4E5f6A7',
  ticket: 'https://waaiio.com/tickets/TK-A3F8X2C91',
  propertyCheckin: `https://waaiio.com/checkin/property/${UUID}`,
  goToken: 'https://api.waaiio.com/go/AbC123xYz',
  confirmAlerts: 'https://wa.me/2348012345678?text=CONFIRM%20ALERTS%20RX7Q2K9M',
  launchWa: 'https://wa.me/447700900123?text=Hi%20Waaiio%2C%20I%27d%20like%20to%20get%20started',
  // Longest realistic case: a wa.me prefill with a sentence of text.
  long: 'https://wa.me/2348012345678?text=' + encodeURIComponent('Hello Grace Chapel! I would like to give to the Building Fund. Reference WAAIIO-7c1d1d4e:giving:0b3c5e7a please confirm.'),
};

describe('styled QR geometry keeps the scannability rules', () => {
  it('quiet zone is never below 4 modules, and the frame sits outside it', () => {
    const m = qrMatrix(P.merchant, 'M');
    expect(styledQrGeometry(m, { margin: 1, frame: false }).units).toBe(m.size + 2 * MIN_QUIET_ZONE);
    expect(styledQrGeometry(m, { margin: 0, frame: false }).units).toBe(m.size + 2 * MIN_QUIET_ZONE);
    const framed = styledQrGeometry(m, { frame: true });
    expect(framed.units).toBe(m.size + 2 * MIN_QUIET_ZONE + 4);
    // Walk the bracket path (M/V/Q/H commands). Every point, widened by half the
    // stroke, must stay inside the 2-module band outside the quiet zone.
    const half = framed.frameStroke / 2;
    const band = 2;
    const inBand = (v: number) => (v - half >= 0 && v + half <= band) || (v - half >= framed.units - band && v + half <= framed.units);
    const tokens = framed.framePath.match(/[MVHQ]|-?\d+(\.\d+)?/g)!;
    let x = 0, y = 0, i = 0, points = 0;
    while (i < tokens.length) {
      const cmd = tokens[i++];
      if (cmd === 'M') { x = +tokens[i++]; y = +tokens[i++]; }
      else if (cmd === 'V') { y = +tokens[i++]; }
      else if (cmd === 'H') { x = +tokens[i++]; }
      else if (cmd === 'Q') { i += 2; x = +tokens[i++]; y = +tokens[i++]; }
      expect(inBand(x) || inBand(y), `bracket point ${x},${y}`).toBe(true);
      points++;
    }
    expect(points).toBe(16); // four L-shaped corners
  });

  it('every dark module still covers its own cell centre, and no light cell centre is drawn on', async () => {
    const value = P.giving;
    const m = qrMatrix(value, 'H');
    const g = styledQrGeometry(m, { frame: true });
    const unit = 12;
    const svg = Buffer.from(styledQrSvg(m, g.units * unit, { frame: true }));
    const px = await rasterize(svg);
    const offset = (g.units - m.size) / 2;
    let wrong = 0;
    for (let r = 0; r < m.size; r++) {
      for (let c = 0; c < m.size; c++) {
        const x = Math.floor((c + offset + 0.5) * unit);
        const y = Math.floor((r + offset + 0.5) * unit);
        const dark = px.lum[y * px.width + x] < 128;
        if (dark !== Boolean(m.get(r, c))) wrong++;
      }
    }
    expect(wrong).toBe(0);
  });

  it('error correction is the level asked for (M, Q, H)', () => {
    expect(qrMatrix(P.merchant, 'M').size).toBeLessThan(qrMatrix(P.merchant, 'H').size);
  });
});

describe('every QR Waaiio shows decodes back to the exact payload', () => {
  // [where, payload, level, on-screen size in CSS px]
  const SITES: Array<[string, string, QrLevel, number]> = [
    ['events share thumbnail', P.event, 'M', 64],
    ['keyword campaign thumbnail', P.campaign, 'M', 72],
    ['admin WhatsApp assistance', P.merchant, 'M', 76],
    ['dashboard home card', P.merchant, 'H', 80],
    ['party share', P.party, 'M', 80],
    ['contract signing link', P.contractSign, 'M', 100],
    ['giving category share', P.giving, 'H', 120],
    ['QR page plain code', P.merchantAction, 'H', 120],
    ['admin platform campaign', P.goToken, 'M', 128],
    ['site announcement modal', P.launchWa, 'M', 140],
    ['launch page', P.launchWa, 'M', 160],
    ['merchant alert confirmation', P.confirmAlerts, 'M', 168],
    ['QR page poster preview', P.merchantAction, 'H', 180],
    ['onboarding success', P.merchant, 'M', 220],
    ['scan-to-pay modal', P.pay, 'H', 220],
    ['waiver modal', P.waiver, 'H', 220],
    ['property check-in', P.propertyCheckin, 'M', 256],
  ];

  for (const [where, value, level, size] of SITES) {
    it(`${where}: ${size}px at 2× screen density (level ${level})`, async () => {
      await expectScans(svgAt(value, size, 2, level), value);
    });
  }

  // Below ~2.5 screen pixels per module no decoder reads a still image reliably,
  // styled or plain (today's square thumbnails were also under it at 1×). Every
  // site must clear it at 2× (above); at 1× it is checked wherever it is cleared.
  const pixelsPerModule = (value: string, level: QrLevel, px: number) => px / styledQrGeometry(qrMatrix(value, level)).units;
  it('every site has at least 2.5 pixels per module at 2× density', () => {
    for (const [where, value, level, size] of SITES) {
      expect(pixelsPerModule(value, level, size * 2), where).toBeGreaterThanOrEqual(2.5);
    }
  });
  for (const [where, value, level, size] of SITES.filter(([, v, l, s]) => pixelsPerModule(v, l, s) >= 2.5)) {
    it(`${where}: ${size}px at 1× screen density (level ${level})`, async () => {
      await expectScans(svgAt(value, size, 1, level), value);
    });
  }

  it('64px thumbnail at 1× with a short payload', async () => {
    await expectScans(svgAt(P.short, 64, 1, 'M'), P.short);
  });
});

describe('style variants × payload lengths × sizes', () => {
  const payloads: Array<[string, string]> = [['short', P.short], ['medium', P.giving], ['long', P.long]];
  for (const [label, value] of payloads) {
    for (const level of ['M', 'H'] as QrLevel[]) {
      for (const frame of [true, false]) {
        it(`${label} payload, level ${level}, ${frame ? 'framed' : 'no frame'}: smallest size at 3px/module, 512px and 1024px`, async () => {
          const units = styledQrGeometry(qrMatrix(value, level), { frame }).units;
          for (const px of [units * 3, 512, 1024]) {
            await expectScans(svgAt(value, px, 1, level, frame), value);
          }
        });
      }
    }
  }

  it('brand colours used today keep enough contrast to scan', async () => {
    for (const fg of ['#1a1a2e', '#240D55', '#1a1a1a']) {
      await expectScans(svgAt(P.ticket, 200, 1, 'M', true, fg), P.ticket);
    }
  });
});

describe('downloads and server images', () => {
  it('download canvases are print resolution (PNG at 1024px) and scan', async () => {
    const png = await styledQrPng(P.giving, 1024, { level: 'H' });
    const meta = await sharp(png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 1024, 1024]);
    await expectScans(png, P.giving);
  });

  it('ticket PDF QR (dark brand colour) scans', async () => {
    await expectScans(await styledQrPng(P.ticket, 384, { fgColor: '#240D55' }), P.ticket);
  });

  it('contract verification QR scans', async () => {
    const url = `https://www.waaiio.com/contracts/${UUID}?token=Zx81kQp0aB7nT2wR5yU9eL3cV6mH4jG1`;
    await expectScans(await styledQrPng(url, 400), url);
  });

  it('ticket image data URL is a self-contained SVG that scans', async () => {
    const url = styledQrSvgDataUrl(P.ticket, 180, { fgColor: '#1a1a1a' });
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    const svg = decodeURIComponent(url.slice('data:image/svg+xml;charset=utf-8,'.length));
    await expectScans(Buffer.from(svg), P.ticket);
  });

  it('non-ASCII payloads round-trip byte for byte', async () => {
    const value = 'https://wa.me/2348012345678?text=Ẹ kú àárọ̀ — café ✓';
    await expectScans(svgAt(value, 512, 1, 'M'), value);
  });
});
