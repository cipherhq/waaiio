/**
 * Server-only PNG of a styled QR code, for PDFs. Kept apart from
 * lib/qr/styled-qr.ts so browser and edge bundles never pull in sharp.
 */
import sharp from 'sharp';
import { styledQrSvgString, type StyledQrRenderOptions } from './styled-qr';

export async function styledQrPng(value: string, size: number, options: StyledQrRenderOptions = {}): Promise<Buffer> {
  return sharp(Buffer.from(styledQrSvgString(value, size, options))).png().toBuffer();
}
