/**
 * Validate file content by checking magic bytes (file signature).
 * Prevents malware disguised as images — file.type is client-supplied and spoofable.
 */

// Magic byte signatures for supported file types
const SIGNATURES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  // JPEG: FF D8 FF
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  // PNG: 89 50 4E 47
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  // GIF87a / GIF89a: 47 49 46 38
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  // WebP: RIFF....WEBP (bytes 8-11 = WEBP)
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  // PDF: %PDF
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  // HEIC/HEIF: ftyp at offset 4
  { mime: 'image/heic', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { mime: 'image/heif', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  // OGG audio: OggS
  { mime: 'audio/ogg', bytes: [0x4F, 0x67, 0x67, 0x53] },
  // MP3: ID3 or FF FB/FF F3/FF F2
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  // MP4/M4A: ftyp at offset 4
  { mime: 'audio/mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { mime: 'video/mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  // WebM: 1A 45 DF A3 (EBML header)
  { mime: 'audio/webm', bytes: [0x1A, 0x45, 0xDF, 0xA3] },
  { mime: 'video/webm', bytes: [0x1A, 0x45, 0xDF, 0xA3] },
];

// Map of equivalent MIME types
const MIME_ALIASES: Record<string, string[]> = {
  'image/jpeg': ['image/jpeg', 'image/jpg'],
  'image/png': ['image/png', 'image/x-png'],
  'image/heic': ['image/heic', 'image/heif'],
  'audio/mpeg': ['audio/mpeg', 'audio/mp3'],
  'audio/mp4': ['audio/mp4', 'audio/m4a', 'video/mp4'],
  'audio/webm': ['audio/webm', 'video/webm'],
};

/**
 * Validate that a file's actual content matches its claimed MIME type.
 * Returns the detected MIME type, or null if the file is invalid/unrecognized.
 *
 * @param buffer - The file content as a Buffer or Uint8Array
 * @param claimedMime - The MIME type claimed by the client
 * @returns The detected MIME type if valid, null if invalid
 */
export function validateFileSignature(
  buffer: Buffer | Uint8Array,
  claimedMime: string,
): string | null {
  if (buffer.length < 12) return null; // Too small to validate

  // Find matching signature
  for (const sig of SIGNATURES) {
    const offset = sig.offset || 0;
    if (buffer.length < offset + sig.bytes.length) continue;

    const matches = sig.bytes.every((byte, i) => buffer[offset + i] === byte);
    if (!matches) continue;

    // Check if detected type matches or is an alias of claimed type
    const aliases = MIME_ALIASES[sig.mime] || [sig.mime];
    const claimedAliases = Object.entries(MIME_ALIASES)
      .find(([, v]) => v.includes(claimedMime));
    const claimedGroup = claimedAliases ? claimedAliases[1] : [claimedMime];

    // Accept if detected type overlaps with claimed type's group
    if (aliases.some(a => claimedGroup.includes(a)) || claimedGroup.includes(sig.mime)) {
      return sig.mime;
    }
  }

  return null; // No matching signature found — file is suspicious
}

/**
 * Convenience: validate an uploaded File object.
 * Returns { valid: true, detectedMime } or { valid: false, error }.
 */
export async function validateUploadedFile(
  file: File,
  allowedMimes: string[],
): Promise<{ valid: true; detectedMime: string } | { valid: false; error: string }> {
  // 1. Check claimed MIME against allowed list
  if (!allowedMimes.includes(file.type)) {
    return { valid: false, error: `File type "${file.type}" is not supported.` };
  }

  // 2. Read file bytes and validate magic signature
  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = validateFileSignature(buffer, file.type);

  if (!detected) {
    return { valid: false, error: 'File content does not match its type. The file may be corrupted or invalid.' };
  }

  return { valid: true, detectedMime: detected };
}
