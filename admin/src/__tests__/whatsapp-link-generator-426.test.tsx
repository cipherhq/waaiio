import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WhatsAppLinkGenerator } from '@/components/WhatsAppLinkGenerator';

describe('#426 reusable WhatsApp link generator UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  it('does not expose a hardcoded destination before the admin enters one', async () => {
    const user = userEvent.setup();
    render(<WhatsAppLinkGenerator onUseLink={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Generate WhatsApp Link/i }));

    expect(screen.getByLabelText(/Destination WhatsApp number/i)).toHaveValue('');
    expect(screen.queryByTestId('whatsapp-link-preview')).not.toBeInTheDocument();
  });

  it('shows a canonical preview from an entered number and message', async () => {
    const user = userEvent.setup();
    render(<WhatsAppLinkGenerator onUseLink={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Generate WhatsApp Link/i }));
    await user.type(screen.getByLabelText(/Destination WhatsApp number/i), '+1 (301) 555-0123');
    await user.type(screen.getByLabelText(/Prefilled message/i), 'Hi Waaiio & welcome');

    expect(screen.getByTestId('whatsapp-link-preview')).toHaveTextContent(
      'https://wa.me/13015550123?text=Hi%20Waaiio%20%26%20welcome',
    );
  });

  it('requires explicit Use This Link before returning the generated URL', async () => {
    const user = userEvent.setup();
    const onUseLink = vi.fn();
    render(<WhatsAppLinkGenerator onUseLink={onUseLink} />);

    await user.click(screen.getByRole('button', { name: /Generate WhatsApp Link/i }));
    await user.type(screen.getByLabelText(/Destination WhatsApp number/i), '+234 803 123 4567');

    expect(onUseLink).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Use This Link/i }));

    expect(onUseLink).toHaveBeenCalledTimes(1);
    expect(onUseLink).toHaveBeenCalledWith('https://wa.me/2348031234567');
  });

  it('opens preview without applying or saving anything', async () => {
    const user = userEvent.setup();
    const onUseLink = vi.fn();
    render(<WhatsAppLinkGenerator onUseLink={onUseLink} />);

    await user.click(screen.getByRole('button', { name: /Generate WhatsApp Link/i }));
    await user.type(screen.getByLabelText(/Destination WhatsApp number/i), '+44 20 7946 0958');
    await user.click(screen.getByRole('button', { name: /Open Preview/i }));

    expect(window.open).toHaveBeenCalledWith(
      'https://wa.me/442079460958',
      '_blank',
      'noopener,noreferrer',
    );
    expect(onUseLink).not.toHaveBeenCalled();
  });

  it('shows validation errors and withholds action buttons for invalid input', async () => {
    const user = userEvent.setup();
    render(<WhatsAppLinkGenerator onUseLink={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Generate WhatsApp Link/i }));
    await user.type(screen.getByLabelText(/Destination WhatsApp number/i), '3015550123');

    expect(screen.getByText(/starting with \+ or 00/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Use This Link/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Preview/i })).not.toBeInTheDocument();
  });
});
