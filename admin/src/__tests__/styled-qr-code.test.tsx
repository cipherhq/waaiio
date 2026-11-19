/**
 * Admin StyledQRCode (Owner request 2026-11-19): the admin copy must draw the
 * same geometry as the shared renderer for the exact value it is given, so the
 * main app's decode tests (lib/qr/__tests__/styled-qr-decode.test.ts) cover it.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { create } from 'qrcode';
import { styledQrGeometry } from '@shared/styled-qr';
import { StyledQRCode } from '@/components/StyledQRCode';

const VALUE = 'https://api.waaiio.com/go/AbC123xYz';

describe('admin StyledQRCode', () => {
  it('svg: draws the shared geometry for the exact value at level M', () => {
    const { container } = render(<StyledQRCode value={VALUE} size={76} aria-label="QR" />);
    const svg = container.querySelector('svg')!;
    const g = styledQrGeometry(create(VALUE, { errorCorrectionLevel: 'M' }).modules);
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${g.units} ${g.units}`);
    const paths = Array.from(svg.querySelectorAll('path')).map(p => p.getAttribute('d'));
    expect(paths).toEqual([g.modulesPath, g.findersPath, g.framePath]);
    expect(svg.getAttribute('aria-label')).toBe('QR');
  });

  it('level H changes the encoding (not just the look)', () => {
    const { container } = render(<StyledQRCode value={VALUE} size={76} level="H" />);
    const g = styledQrGeometry(create(VALUE, { errorCorrectionLevel: 'H' }).modules);
    expect(container.querySelector('path')!.getAttribute('d')).toBe(g.modulesPath);
  });

  it('canvas: keeps the id the PNG download looks up', () => {
    const { container } = render(<StyledQRCode id="qr-canvas-abc" value={VALUE} size={128} renderAs="canvas" resolution={1024} />);
    const canvas = container.querySelector('canvas')!;
    expect(canvas.id).toBe('qr-canvas-abc');
    expect(canvas.style.width).toBe('128px');
  });
});
