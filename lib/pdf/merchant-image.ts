/**
 * Fetching merchant-supplied images for PDFs (tickets and receipts), shared so both apply the
 * same limits: the business logo comes only from the public business-documents bucket, downloads
 * are capped at 5 MB, and images are re-encoded (PDFKit draws only PNG/JPEG) and downscaled.
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function fetchImageBuffer(url: string, init: RequestInit = {}): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const declared = Number(res.headers?.get?.('content-length') || 0);
    if (declared > MAX_IMAGE_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_IMAGE_BYTES ? null : buf;
  } catch {
    return null;
  }
}

/**
 * Only fetch logos uploaded through /api/business/upload-logo (public business-documents bucket),
 * so a hand-edited logo_url can't make the server fetch an arbitrary address.
 * Returns the normalised URL to fetch, or null. Parsing resolves `..` and `%2e%2e` before the check.
 */
export function allowedBusinessLogoUrl(url: string | undefined): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !base) return null;
  try {
    const u = new URL(url);
    const b = new URL(base);
    const prefix = `${b.pathname.replace(/\/+$/, '')}/storage/v1/object/public/business-documents/`;
    if (u.origin !== b.origin || u.username || u.password || !u.pathname.startsWith(prefix)) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Re-encode an image for PDFKit: it draws only PNG and JPEG (uploads may be WebP), and a full-size
 * merchant image would make generation slow and the PDF huge, so cap its dimensions too.
 */
export async function toPdfImage(buf: Buffer, maxPx: number, format: 'png' | 'jpeg'): Promise<Buffer | null> {
  try {
    const sharp = (await import('sharp')).default;
    const img = sharp(buf, { limitInputPixels: 40_000_000 })
      .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true });
    return format === 'png'
      ? await img.png().toBuffer()
      : await img.flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
  } catch {
    return null;
  }
}

/** The business logo from businesses.logo_url, ready for PDFKit (PNG, at most 256 px), or null. */
export async function loadBusinessLogo(url: string | undefined): Promise<Buffer | null> {
  const safeUrl = allowedBusinessLogoUrl(url);
  if (!safeUrl) return null;
  const raw = await fetchImageBuffer(safeUrl, { redirect: 'error' });
  return raw ? toPdfImage(raw, 256, 'png') : null;
}
