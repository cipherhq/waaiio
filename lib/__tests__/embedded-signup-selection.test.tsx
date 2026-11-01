// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EmbeddedSignupSelection } from '@/components/whatsapp/EmbeddedSignupSelection';
afterEach(cleanup);
const accounts = ['a', 'b'].map(id => ({ waba_id: id, waba_name: `Account ${id}`, phones: [{ id: `phone-${id}`, display_phone_number: `+123${id}`, verified_name: id, quality_rating: 'GREEN' }] }));
it('requires explicit account and number and clears the number when account changes', () => {
  const confirm = vi.fn();
  render(<EmbeddedSignupSelection accounts={accounts} busy={false} onConfirm={confirm} onCancel={vi.fn()} />);
  const submit = screen.getByRole('button', { name: 'Connect selected number' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('WhatsApp account'), { target: { value: 'b' } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('WhatsApp number'), { target: { value: 'phone-b' } });
  fireEvent.click(submit);
  expect(confirm).toHaveBeenCalledWith('b', 'phone-b');
  fireEvent.change(screen.getByLabelText('WhatsApp account'), { target: { value: 'a' } });
  expect(submit.disabled).toBe(true);
});
it('cancel never confirms or activates a number', () => {
  const confirm = vi.fn(), cancel = vi.fn();
  render(<EmbeddedSignupSelection accounts={accounts} busy={false} onConfirm={confirm} onCancel={cancel} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(cancel).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
});
it('explains empty shared accounts and prevents submission', () => {
  render(<EmbeddedSignupSelection accounts={[{ ...accounts[0], phones: [] }]} busy={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('WhatsApp account'), { target: { value: 'a' } });
  expect(screen.getByRole('status').textContent).toContain('No numbers were shared');
  expect((screen.getByRole('button', { name: 'Connect selected number' }) as HTMLButtonElement).disabled).toBe(true);
});
