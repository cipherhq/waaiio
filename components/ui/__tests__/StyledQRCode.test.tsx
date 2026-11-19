/**
 * StyledQRCode (Owner request 2026-11-19): the markup React actually renders
 * must decode back to the exact value, and the canvas variant must keep the
 * contract the download buttons rely on (a <canvas> with the given id and ref).
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { StyledQRCode } from '../StyledQRCode';
import { drawStyledQr, styledQrGeometry } from '@/shared/styled-qr';
import { qrMatrix } from '@/lib/qr/styled-qr';

async function jsqrDecodeSvg(markup: string): Promise<string | null> {
  const { data, info } = await sharp(Buffer.from(markup)).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

const VALUE = 'https://www.waaiio.com/m/7c1d1d4e-1b7f-4a8c-9a7e-3f1f6f6b9a10/giving/0b3c5e7a-2d4f-4e8b-9c1a-5d6e7f8a9b0c';

describe('StyledQRCode (svg)', () => {
  it('rendered markup decodes to the exact value', async () => {
    const markup = renderToStaticMarkup(<StyledQRCode value={VALUE} size={360} level="H" fgColor="#1a1a2e" />);
    expect(markup.startsWith('<svg')).toBe(true);
    expect(await jsqrDecodeSvg(markup)).toBe(VALUE);
  });

  it('draws the shared geometry for the requested level, with the frame by default', () => {
    const markup = renderToStaticMarkup(<StyledQRCode value={VALUE} size={120} level="H" />);
    const g = styledQrGeometry(qrMatrix(VALUE, 'H'));
    expect(markup).toContain(`viewBox="0 0 ${g.units} ${g.units}"`);
    expect(markup).toContain(`d="${g.modulesPath}"`);
    expect(markup).toContain(`d="${g.framePath}"`);
  });

  it('title and aria-label give it an accessible name', () => {
    expect(renderToStaticMarkup(<StyledQRCode value={VALUE} size={80} title="Confirm alerts" />)).toContain('<title>Confirm alerts</title>');
    expect(renderToStaticMarkup(<StyledQRCode value={VALUE} size={80} aria-label="Permanent link QR" />)).toContain('role="img" aria-label="Permanent link QR"');
  });

  it('an empty or unencodable value renders an empty box instead of throwing', () => {
    expect(renderToStaticMarkup(<StyledQRCode value="" size={64} />)).not.toContain('<path');
    expect(renderToStaticMarkup(<StyledQRCode value={'x'.repeat(5000)} size={64} />)).not.toContain('<path');
  });
});

describe('StyledQRCode (canvas)', () => {
  it('renders a canvas with the id download code looks up, sized in CSS pixels', () => {
    const markup = renderToStaticMarkup(<StyledQRCode id="qr-canvas-x" value={VALUE} size={120} renderAs="canvas" resolution={1024} />);
    expect(markup).toMatch(/^<canvas id="qr-canvas-x" style="width:120px;height:120px"/);
  });

  it('drawStyledQr fills the same paths and scales them to the canvas resolution', () => {
    const fills: Array<[unknown, unknown]> = [];
    const strokes: unknown[] = [];
    class FakePath2D { constructor(public d: string) {} }
    vi.stubGlobal('Path2D', FakePath2D);
    const ctx = {
      save: vi.fn(), restore: vi.fn(), scale: vi.fn(), fillRect: vi.fn(),
      fill: (p: FakePath2D, rule?: string) => fills.push([p.d, rule]),
      stroke: (p: FakePath2D) => strokes.push(p.d),
    } as unknown as CanvasRenderingContext2D;
    const m = qrMatrix(VALUE, 'H');
    const g = styledQrGeometry(m);
    drawStyledQr(ctx, m, 1024);
    expect((ctx.scale as any).mock.calls[0]).toEqual([1024 / g.units, 1024 / g.units]);
    expect(fills).toEqual([[g.modulesPath, undefined], [g.findersPath, 'evenodd']]);
    expect(strokes).toEqual([g.framePath]);
    vi.unstubAllGlobals();
  });

});
