import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/adminApi', () => ({ adminApiGet: api.get, adminApiFetch: api.post }));

import CustomerOnboarding from '@/pages/CustomerOnboarding';

describe('#551 Admin customer onboarding journey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', { randomUUID: () => '9f96271c-6715-4e20-ab96-fce6409ed4cd' });
    api.get.mockImplementation(async () => new Response(JSON.stringify({
      onboardings: [],
      options: {
        countries: [{ code: 'NG', name: 'Nigeria', dialing_code: '+234' }],
        categories: [{ key: 'restaurant', name: 'Restaurant' }],
      },
    }), { status: 200 }));
    api.post.mockImplementation(async () => new Response(JSON.stringify({ onboarding: { id: 'onboarding-1' } }), { status: 201 }));
  });

  it('reviews exact owner/business data before sending an idempotent server request', async () => {
    render(<CustomerOnboarding />);
    await screen.findByRole('option', { name: 'Restaurant' });
    const values: Record<string, string> = {
      'Owner first name': 'Ada', 'Owner last name': 'Lovelace', 'Owner email': 'ada@example.test',
      'Business name': 'Exact Business', 'Business phone': '+2348012345678', 'Country code': 'NG',
      'Category key': 'restaurant', City: 'Lagos', Address: '1 Test Street',
    };
    for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Review onboarding' }));
    expect(screen.getByText('Review before creation')).toBeInTheDocument();
    expect(screen.getByText(/Exact Business/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create and send invite' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith('/api/admin/onboarding', expect.objectContaining({
      request_key: '9f96271c-6715-4e20-ab96-fce6409ed4cd', owner_email: 'ada@example.test', business_name: 'Exact Business',
    }));
    expect(await screen.findByText('Activation invitation sent. Customer action is now required.')).toBeInTheDocument();
  });
});
