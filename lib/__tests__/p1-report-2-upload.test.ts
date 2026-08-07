/**
 * P1-REPORT-2 — Document upload validation tests
 *
 * Verifies that the upload route accepts PDF, PNG, and JPEG files (as the UI
 * advertises), rejects files whose magic bytes don't match their claimed type,
 * and preserves all existing security controls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock infrastructure ──────────────────────────────────────────────────

const mockUser = { id: 'user-1' };
const mockBiz = { id: 'biz-1', subscription_tier: 'free' };

// Storage & DB mock state
let mockUploadError: Error | null = null;
let mockInsertResult: { data: any; error: any } = { data: { id: 'report-1' }, error: null };

const mockRemove = vi.fn();
const mockUpload = vi.fn().mockImplementation(() => ({ error: mockUploadError }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockImplementation(async () => ({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }) },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: mockBiz, error: null }),
        };
      }
      if (table === 'customer_reports') {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue(mockInsertResult),
            }),
          }),
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    }),
    storage: {
      from: vi.fn().mockReturnValue({
        upload: mockUpload,
        remove: mockRemove,
      }),
    },
  })),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    }),
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test'),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a File with specific header bytes and claimed MIME type */
function makeFile(
  headerBytes: number[],
  claimedMime: string,
  filename: string,
  totalSize?: number,
): File {
  const size = totalSize ?? Math.max(headerBytes.length, 64);
  const buf = new Uint8Array(size);
  headerBytes.forEach((b, i) => { buf[i] = b; });
  return new File([buf], filename, { type: claimedMime });
}

/** Construct a FormData-bearing NextRequest to the upload endpoint */
function buildRequest(file: File, overrides?: Record<string, string>): NextRequest {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('title', overrides?.title ?? 'Test Doc');
  fd.append('customerPhone', overrides?.customerPhone ?? '+2341234567890');
  fd.append('customerName', overrides?.customerName ?? 'Test User');
  fd.append('businessId', overrides?.businessId ?? 'biz-1');
  return new NextRequest('http://localhost/api/reports/upload', {
    method: 'POST',
    body: fd,
  });
}

// ── Magic byte constants ─────────────────────────────────────────────────

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47]; // \x89PNG
const JPEG_MAGIC = [0xFF, 0xD8, 0xFF, 0xE0]; // JPEG/JFIF
const EXE_MAGIC = [0x4D, 0x5A]; // MZ (PE executable)
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38]; // GIF8

// ── Tests ────────────────────────────────────────────────────────────────

describe('P1-REPORT-2: Document upload validation', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUploadError = null;
    mockInsertResult = { data: { id: 'report-1' }, error: null };
    const mod = await import('@/app/api/reports/upload/route');
    POST = mod.POST;
  });

  // ── 1. Valid PDF accepted ──────────────────────────────────────────────

  it('accepts a valid PDF file', async () => {
    const file = makeFile(PDF_MAGIC, 'application/pdf', 'document.pdf');
    const res = await POST(buildRequest(file));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe('report-1');

    // Verify storage was called with correct content type and .pdf extension
    expect(mockUpload).toHaveBeenCalledOnce();
    const [path, , opts] = mockUpload.mock.calls[0];
    expect(path).toMatch(/\.pdf$/);
    expect(opts.contentType).toBe('application/pdf');
  });

  // ── 2. Valid PNG accepted ──────────────────────────────────────────────

  it('accepts a valid PNG file', async () => {
    const file = makeFile(PNG_MAGIC, 'image/png', 'scan.png');
    const res = await POST(buildRequest(file));
    expect(res.status).toBe(200);

    expect(mockUpload).toHaveBeenCalledOnce();
    const [path, , opts] = mockUpload.mock.calls[0];
    expect(path).toMatch(/\.png$/);
    expect(opts.contentType).toBe('image/png');
  });

  // ── 3. Valid JPEG accepted ─────────────────────────────────────────────

  it('accepts a valid JPEG file', async () => {
    const file = makeFile(JPEG_MAGIC, 'image/jpeg', 'photo.jpg');
    const res = await POST(buildRequest(file));
    expect(res.status).toBe(200);

    expect(mockUpload).toHaveBeenCalledOnce();
    const [path, , opts] = mockUpload.mock.calls[0];
    expect(path).toMatch(/\.jpg$/);
    expect(opts.contentType).toBe('image/jpeg');
  });

  // ── 4. .png filename with non-PNG bytes rejected ───────────────────────

  it('rejects a .png file with non-PNG bytes (e.g. EXE)', async () => {
    const file = makeFile(EXE_MAGIC, 'image/png', 'malware.png');
    const res = await POST(buildRequest(file));
    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 5. .jpg filename with non-JPEG bytes rejected ─────────────────────

  it('rejects a .jpg file with non-JPEG bytes', async () => {
    const file = makeFile(PDF_MAGIC, 'image/jpeg', 'fake.jpg');
    const res = await POST(buildRequest(file));
    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 6. .pdf filename with non-PDF bytes rejected ───────────────────────

  it('rejects a .pdf file with non-PDF bytes (e.g. PNG content)', async () => {
    const file = makeFile(PNG_MAGIC, 'application/pdf', 'report.pdf');
    const res = await POST(buildRequest(file));
    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 7. Executable/binary file rejected ─────────────────────────────────

  it('rejects an EXE file regardless of claimed MIME', async () => {
    const file = makeFile(EXE_MAGIC, 'application/pdf', 'virus.pdf');
    const res = await POST(buildRequest(file));
    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 8. File size limit enforced ────────────────────────────────────────

  it('rejects files exceeding 10 MB', async () => {
    const oversize = 11 * 1024 * 1024;
    const file = makeFile(PDF_MAGIC, 'application/pdf', 'huge.pdf', oversize);
    const res = await POST(buildRequest(file));
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toContain('10MB');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 9. Unsupported MIME type rejected ──────────────────────────────────

  it('rejects unsupported MIME types (e.g. GIF)', async () => {
    const file = makeFile(GIF_MAGIC, 'image/gif', 'animation.gif');
    const res = await POST(buildRequest(file));
    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 10. Existing PDF behavior unchanged ────────────────────────────────

  it('preserves PDF upload behavior end-to-end', async () => {
    const file = makeFile(PDF_MAGIC, 'application/pdf', 'invoice.pdf');
    const res = await POST(buildRequest(file));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBeDefined();

    // Verify the upload path and content type
    const [storagePath, , opts] = mockUpload.mock.calls[0];
    expect(storagePath).toContain('biz-1/');
    expect(storagePath).toMatch(/\.pdf$/);
    expect(opts.contentType).toBe('application/pdf');
    expect(opts.upsert).toBe(false);
  });

  // ── 11. Missing required fields ────────────────────────────────────────

  it('rejects upload with missing required fields', async () => {
    const fd = new FormData();
    fd.append('title', 'Test');
    // No file, no phone, no businessId
    const req = new NextRequest('http://localhost/api/reports/upload', {
      method: 'POST',
      body: fd,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Missing');
  });
});
