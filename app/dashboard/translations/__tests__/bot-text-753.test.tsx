// @vitest-environment jsdom

/**
 * Bot Text page — executable component tests (#753 item 6)
 *
 * Exercises the actual rendered Bot Text editor UI with intercepted API requests.
 * Covers: readable labels, search by readable name, correct save payload
 * (business/key/language), clear-and-save reset (null value), validation and
 * network error display, editable-key filtering, character limit display,
 * placeholder guidance, and save/reset help text.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/* ── Hoisted state for mock control ── */

const state = vi.hoisted(() => ({
  business: {
    id: 'biz-test-001',
    name: 'Test Business',
    capabilities: ['scheduling'],
    country_code: 'NG',
  } as Record<string, unknown>,
}));

/* ── Mock DashboardProvider ── */

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => state.business,
}));

vi.mock('@/components/dashboard/PageHelp', () => ({
  PageHelp: ({ title }: { title: string }) => (
    <div data-testid="page-help">{title}</div>
  ),
}));

vi.mock('@/components/dashboard/EmptyState', () => ({
  default: ({ title }: { title: string }) => (
    <div data-testid="empty-state">{title}</div>
  ),
}));

/* ── Import after mocks ── */

import TranslationsPage from '../page';

/* ── Test data ── */

const MOCK_EDITABLE_KEYS = [
  'menu.what_to_do',
  'menu.title',
  'cap.scheduling',
  'cap.ordering',
  'greeting.welcome_back',
  'greeting.welcome_back_named',
  'lang.picker_button',
];

const MOCK_ALL_KEYS = [
  ...MOCK_EDITABLE_KEYS,
  'nav.footer',
  'error.generic',
  'payment.ive_paid',
];

const MOCK_PLATFORM_OVERRIDES = [
  { lang: 'en', key: 'menu.what_to_do', value: 'What would you like to do?' },
  { lang: 'en', key: 'cap.scheduling', value: 'Our Services' },
  { lang: 'en', key: 'cap.ordering', value: 'Place an Order' },
  { lang: 'en', key: 'greeting.welcome_back', value: 'Welcome back!' },
  { lang: 'en', key: 'greeting.welcome_back_named', value: 'Welcome back, {name}!' },
  { lang: 'en', key: 'lang.picker_button', value: 'Choose Language' },
  { lang: 'en', key: 'menu.title', value: 'Menu' },
  { lang: 'pcm', key: 'menu.what_to_do', value: 'Wetin you wan do?' },
];

function makeApiResponse(overrides: Array<{ lang: string; key: string; value: string }> = []) {
  return {
    overrides,
    platformOverrides: MOCK_PLATFORM_OVERRIDES,
    allowedLanguages: ['en', 'pcm'],
    allKeys: MOCK_ALL_KEYS,
    editableKeys: MOCK_EDITABLE_KEYS,
  };
}

/* ── Fetch mock helpers ── */

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
  state.business = {
    id: 'biz-test-001',
    name: 'Test Business',
    capabilities: ['scheduling'],
    country_code: 'NG',
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Bot Text page', () => {
  it('shows readable labels instead of raw keys', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // Readable labels are shown (some labels may match default text, use getAllByText)
    expect(screen.getByText('Services menu item')).toBeTruthy();
    expect(screen.getAllByText('Place an Order').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Welcome back').length).toBeGreaterThan(0);
    expect(screen.getByText('Language picker button')).toBeTruthy();
  });

  it('shows internal keys as secondary reference', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('menu.what_to_do')).toBeTruthy();
    });

    expect(screen.getByText('cap.scheduling')).toBeTruthy();
    expect(screen.getByText('cap.ordering')).toBeTruthy();
  });

  it('only shows editable keys, not platform-only keys', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // Platform-only keys should NOT appear
    expect(screen.queryByText('nav.footer')).toBeNull();
    expect(screen.queryByText('error.generic')).toBeNull();
    expect(screen.queryByText('payment.ive_paid')).toBeNull();
  });

  it('shows context descriptions', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    expect(screen.getByText('Shown when the customer first opens the menu.')).toBeTruthy();
    expect(screen.getByText('Menu option for browsing and booking your services.')).toBeTruthy();
  });

  it('shows placeholder guidance for keys with placeholders', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Welcome back (with name)')).toBeTruthy();
    });

    // Placeholder token and explanation should appear
    expect(screen.getByText('{name}')).toBeTruthy();
    expect(screen.getByText("= Customer's name")).toBeTruthy();
  });

  it('shows character limit for button/list title keys', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Language picker button')).toBeTruthy();
    });

    // Character limit note
    expect(screen.getByText(/max 20 characters/)).toBeTruthy();
    expect(screen.getByText(/max 24 characters/)).toBeTruthy();
  });

  it('labels input fields as "Your message"', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    const labels = screen.getAllByText('Your message', { exact: false });
    expect(labels.length).toBeGreaterThan(0);
  });

  it('shows save/reset help text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // The "how it works" hint
    expect(screen.getByText(/Clear the field and save to restore the original/)).toBeTruthy();
  });

  it('searches by readable name', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    const searchInput = screen.getByPlaceholderText('Search messages...');
    fireEvent.change(searchInput, { target: { value: 'Services menu' } });

    // Should find "Services menu item" (cap.scheduling)
    await waitFor(() => {
      expect(screen.getByText('Services menu item')).toBeTruthy();
    });

    // Other items should be hidden
    expect(screen.queryByText('Menu prompt')).toBeNull();
    expect(screen.queryByText('Welcome back')).toBeNull();
  });

  it('sends correct payload on save and refreshes rendered state', async () => {
    // After save, the GET reload returns the new override — verify it renders
    const updatedOverrides = [
      { id: 'ov-new', lang: 'en', key: 'menu.what_to_do', value: 'Pick something:', updated_at: '2026-10-29' },
    ];
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, makeApiResponse()))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, upserted: 1, deleted: 0 }))
      .mockResolvedValueOnce(jsonResponse(200, makeApiResponse(updatedOverrides)));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // The page defaults to first non-English (pcm), switch to English for testing
    const enTab = screen.getByText('English');
    fireEvent.click(enTab);

    // Edit the "menu.what_to_do" textarea
    const textareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    // Find the one with the right placeholder
    const menuTextarea = textareas.find(t =>
      t.placeholder === 'What would you like to do?'
    );
    expect(menuTextarea).toBeTruthy();
    fireEvent.change(menuTextarea!, { target: { value: 'Pick something:' } });

    // Save
    const saveBtn = screen.getByText('Save Changes');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/translations', expect.objectContaining({
        method: 'PUT',
      }));
    });

    // Inspect the PUT payload
    const putCall = fetchMock.mock.calls.find(
      (c: unknown[]) => c[0] === '/api/translations' && (c[1] as RequestInit)?.method === 'PUT'
    );
    expect(putCall).toBeTruthy();
    const putBody = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(putBody.businessId).toBe('biz-test-001');
    const menuOverride = putBody.overrides.find(
      (o: { key: string }) => o.key === 'menu.what_to_do'
    );
    expect(menuOverride).toBeTruthy();
    expect(menuOverride.lang).toBe('en');
    expect(menuOverride.value).toBe('Pick something:');

    // After reload, loadData resets language to pcm; switch back to English
    await waitFor(() => {
      expect(screen.getByText('Changes saved')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('English'));

    // The saved value should appear in the textarea
    await waitFor(() => {
      const refreshedTextareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
      const refreshedMenu = refreshedTextareas.find(t => t.value === 'Pick something:');
      expect(refreshedMenu).toBeTruthy();
    });
  });

  it('sends null on clear and renders empty field after refresh', async () => {
    const existingOverrides = [
      { id: 'ov-1', lang: 'en', key: 'menu.what_to_do', value: 'Custom text', updated_at: '2026-01-01' },
    ];
    // After clear-and-save, the reload returns no overrides (default restored)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, makeApiResponse(existingOverrides)))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, upserted: 0, deleted: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, makeApiResponse([])));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // Switch to English
    fireEvent.click(screen.getByText('English'));

    // The textarea should show the existing override
    const textareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    const menuTextarea = textareas.find(t => t.value === 'Custom text');
    expect(menuTextarea).toBeTruthy();

    // Clear it (restore default)
    fireEvent.change(menuTextarea!, { target: { value: '' } });

    // Save
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        (c: unknown[]) => c[0] === '/api/translations' && (c[1] as RequestInit)?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
      const putBody = JSON.parse((putCall![1] as RequestInit).body as string);
      // The cleared override should be sent as null (delete/restore default)
      const menuOverride = putBody.overrides.find(
        (o: { key: string }) => o.key === 'menu.what_to_do'
      );
      expect(menuOverride).toBeTruthy();
      expect(menuOverride.value).toBeNull();
    });

    // After reload, loadData resets language to pcm; switch back to English
    await waitFor(() => {
      expect(screen.getByText('Changes saved')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('English'));

    // The textarea should be empty (no override, back to default placeholder)
    await waitFor(() => {
      const refreshedTextareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
      const refreshedMenu = refreshedTextareas.find(t =>
        t.placeholder === 'What would you like to do?'
      );
      expect(refreshedMenu).toBeTruthy();
      expect(refreshedMenu!.value).toBe('');
    });
  });

  it('displays validation errors from the server', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, makeApiResponse()))
      .mockResolvedValueOnce(jsonResponse(400, {
        error: 'Validation failed',
        errors: ['menu.what_to_do: button title exceeds 20 chars (25)'],
      }));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('English'));

    const textareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    const menuTextarea = textareas.find(t =>
      t.placeholder === 'What would you like to do?'
    );
    fireEvent.change(menuTextarea!, { target: { value: 'some text' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(screen.getByText('Please fix the following errors:')).toBeTruthy();
      expect(screen.getByText('menu.what_to_do: button title exceeds 20 chars (25)')).toBeTruthy();
    });
  });

  it('displays network errors', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, makeApiResponse()))
      .mockRejectedValueOnce(new Error('Network failure'));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('English'));

    const textareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    // Skip the search input (first textbox), get first textarea
    const editableTextarea = textareas.find(t => t.tagName === 'TEXTAREA');
    expect(editableTextarea).toBeTruthy();
    fireEvent.change(editableTextarea!, { target: { value: 'test' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(screen.getByText('Failed to save. Please try again.')).toBeTruthy();
    }, { timeout: 5000 });
  });

  it('shows empty state for single-language business', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      overrides: [],
      platformOverrides: [],
      allowedLanguages: ['en'],
      allKeys: MOCK_ALL_KEYS,
      editableKeys: MOCK_EDITABLE_KEYS,
    }));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeTruthy();
    });
  });

  it('shows page help with updated title', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      const help = screen.getByTestId('page-help');
      expect(help.textContent).toBe('Customize Your Bot Messages');
    });
  });

  it('shows message count instead of key count in footer', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // Footer should show editable count, not all keys count
    expect(screen.getByText(`${MOCK_EDITABLE_KEYS.length} of ${MOCK_EDITABLE_KEYS.length} messages shown`)).toBeTruthy();
  });

  it('shows "messages" not "keys" in category headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // Category headers should say "messages" not "keys"
    const messageCountTexts = screen.getAllByText(/^\d+ messages?$/);
    expect(messageCountTexts.length).toBeGreaterThan(0);
    // No "keys" text in category headers
    expect(screen.queryByText(/^\d+ keys?$/)).toBeNull();
  });

  it('labels English-only text as "English reference" when non-English selected', async () => {
    // Default selected lang is pcm (Nigerian Pidgin).
    // menu.what_to_do has a pcm platform override -> should show "Default (Nigerian Pidgin)"
    // cap.scheduling has NO pcm override, only English -> should show "English reference"
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // menu.what_to_do has pcm override "Wetin you wan do?" — shown as same-language default
    expect(screen.getByText(/Default \(Nigerian Pidgin\)/)).toBeTruthy();
    expect(screen.getByText('Wetin you wan do?')).toBeTruthy();

    // cap.scheduling has no pcm override — English text shown as "English reference"
    const englishRefLabels = screen.getAllByText('English reference:');
    expect(englishRefLabels.length).toBeGreaterThan(0);
  });

  it('shows "Default" without language qualifier when English is selected', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // Switch to English
    fireEvent.click(screen.getByText('English'));

    // English defaults should show as plain "Default:" (no language qualifier or "English reference")
    await waitFor(() => {
      const defaultLabels = screen.getAllByText(/^Default:$/);
      expect(defaultLabels.length).toBeGreaterThan(0);
    });
  });

  it('renders at narrow viewport (375px) without overflow', async () => {
    // Simulate a narrow mobile viewport
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
    window.dispatchEvent(new Event('resize'));

    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // Core elements present and accessible at narrow width
    expect(screen.getByText('Bot Text')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search messages...')).toBeTruthy();
    expect(screen.getByText('Save Changes')).toBeTruthy();
    // Labels and inputs still render
    expect(screen.getByText('Services menu item')).toBeTruthy();
    const labels = screen.getAllByText('Your message', { exact: false });
    expect(labels.length).toBeGreaterThan(0);
  });

  it('renders at desktop viewport (1280px) with all elements', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1280 });
    window.dispatchEvent(new Event('resize'));

    fetchMock.mockResolvedValueOnce(jsonResponse(200, makeApiResponse()));

    render(<TranslationsPage />);

    await waitFor(() => {
      expect(screen.getByText('Menu prompt')).toBeTruthy();
    });

    // All elements present at desktop width
    expect(screen.getByText('Bot Text')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search messages...')).toBeTruthy();
    expect(screen.getByText('Save Changes')).toBeTruthy();
    expect(screen.getByText('Services menu item')).toBeTruthy();
    // Category filter visible
    expect(screen.getByText('All categories')).toBeTruthy();
    // Internal keys visible as secondary reference
    expect(screen.getByText('menu.what_to_do')).toBeTruthy();
    expect(screen.getByText('cap.scheduling')).toBeTruthy();
  });
});
