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
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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
it('uploads verification files under the existing business-first storage prefix', async () => {
  const { container } = render(<VerificationPage />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'Upload', exact: true }))[0]);
  const file = new File(['document'], 'proof.pdf', { type: 'application/pdf' });
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });
  await waitFor(() => expect(state.upload).toHaveBeenCalled());
  expect(state.upload.mock.calls[0][0]).toMatch(/^business-785\/verification\/[^/]+\.pdf$/);
  expect(state.upload.mock.calls[0][1]).toBe(file);
  expect(state.upload.mock.calls[0][2]).toEqual({ upsert: false });
  await waitFor(() => expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({ business_id: 'business-785', status: 'pending' })));
});
