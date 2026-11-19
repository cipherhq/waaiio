/**
 * Encodes a value as a QR code and renders it in Waaiio's rounded style
 * (see shared/styled-qr.ts). Safe for the browser, Node and the edge runtime.
 *
 * The encoder is the `qrcode` package, so the payload is exactly the string
 * passed in. Error correction is never below M.
 */
import { create } from 'qrcode';
import { styledQrSvg, type QrMatrix, type StyledQrColors, type StyledQrOptions } from '@/shared/styled-qr';

export type QrLevel = 'M' | 'Q' | 'H';

export interface StyledQrRenderOptions extends StyledQrOptions, StyledQrColors {
  level?: QrLevel;
}

export function qrMatrix(value: string, level: QrLevel = 'M'): QrMatrix {
  return create(value, { errorCorrectionLevel: level }).modules;
}

/** Standalone SVG document, `size` pixels square. */
export function styledQrSvgString(value: string, size: number, options: StyledQrRenderOptions = {}): string {
  return styledQrSvg(qrMatrix(value, options.level), size, options);
}

/** `data:` URL of the SVG, for `<img src>` (e.g. next/og images). */
export function styledQrSvgDataUrl(value: string, size: number, options: StyledQrRenderOptions = {}): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(styledQrSvgString(value, size, options))}`;
}
