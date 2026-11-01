// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProductsPage from '@/app/dashboard/products/page';
import VerificationPage from '@/app/dashboard/verification/page';
const state = vi.hoisted(() => ({ upload: vi.fn(), insert: vi.fn(), imageUpload: vi.fn() }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'business-785', country_code: 'NG', category: 'retail' }), useCapabilities: () => ({ capabilities: [] }) }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { personLabelPlural: "Customers" } }) }));
vi.mock('@/lib/observability/product-events', () => ({ captureProductEvent: vi.fn() }));
vi.mock('@/app/dashboard/products/components/ProductList', async () => {
  const { EMPTY_PRODUCT } = await import('@/app/dashboard/products/components/types');
  return { default: ({ openEdit }: { openEdit: (product: unknown) => void }) => <button onClick={() => openEdit({ ...EMPTY_PRODUCT, id: 'product', image_url: 'https://example.test/primary.png' })}>Edit test product</button> };
});
vi.mock('@/app/dashboard/products/hooks/useProductGallery', async importOriginal => {
  const actual = await importOriginal<typeof import('@/app/dashboard/products/hooks/useProductGallery')>();
  return { useProductGallery: () => actual.useProductGallery(state.imageUpload) };
});
vi.mock('next/image', () => ({ default: ({ fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => <img {...props} /> }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  from: () => {
    const result = { data: [], error: null, count: 0 };
    const chain = { select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain, then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve), insert: state.insert };
    return chain;
  },
  storage: { from: () => ({ upload: state.upload, getPublicUrl: (path: string) => ({ data: { publicUrl: `https://example.test/${path}` } }) }) },
}) }));
beforeEach(() => {
  vi.clearAllMocks();
  state.upload.mockResolvedValue({ error: null });
  state.insert.mockResolvedValue({ error: null });
  state.imageUpload.mockResolvedValue('https://example.test/additional.png');
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('renders an additional product image immediately before saving and removes it', async () => {
  const { container } = render(<ProductsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit test product' }));
  await screen.findByRole('heading', { name: 'Edit Product' });
  const files = container.querySelectorAll('input[type=file]');
  fireEvent.change(files[1], { target: { files: [new File(['image'], 'additional.png', { type: 'image/png' })] } });
  expect((await screen.findByAltText('Gallery 1') as HTMLImageElement).src).toBe('https://example.test/additional.png');
  fireEvent.click(screen.getByTitle('Remove'));
  expect(screen.queryByAltText('Gallery 1')).toBeNull();
});
it('uploads verification files through the authenticated private upload route', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetcher);
  const { container } = render(<VerificationPage />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'Upload' }))[0]);
  const file = new File(['document'], 'proof.pdf', { type: 'application/pdf' });
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe('/api/verification/upload');
  expect(options.method).toBe('POST');
  expect(options.body.get('business_id')).toBe('business-785');
  expect(options.body.get('file')).toBe(file);
  expect(options.body.get('type')).toBeTruthy();
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.insert).not.toHaveBeenCalled();
});
