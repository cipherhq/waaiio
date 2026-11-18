// @vitest-environment jsdom
/**
 * Contact form errors are announced to screen readers (#1109 follow-up):
 * the error paragraph has role="alert".
 */
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ContactForm } from '../ContactForm';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('announces a failed send with role="alert"', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })));
  const { container } = render(<ContactForm />);
  fireEvent.submit(container.querySelector('form')!);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Too many requests');
});
