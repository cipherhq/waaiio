/**
 * @vitest-environment jsdom
 *
 * #590 mounted production UI acceptance: real hook, effect, click handler and button.
 * No real provider request: global fetch is mocked for every case.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactWinnerButton, useContactWinnerActions } from '../[id]/contact-winner-controls';

type FetchMock = ReturnType<typeof vi.fn>;

function response(status: number, payload: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function readyPayload(status: string) {
  return { status: 'pending', templates: { promo_winner_status_v1: { status } } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function Harness({
  businessId = 'biz-a',
  campaignId = 'campaign-a',
  permitted = true,
}: {
  businessId?: string;
  campaignId?: string;
  permitted?: boolean;
}) {
  const state = useContactWinnerActions({ businessId, campaignId });
  return (
    <div>
      {['winner-a', 'winner-b'].map(id => (
        <div data-testid={id} key={id}>
          <ContactWinnerButton
            redemptionId={id}
            canContactWinner={permitted}
            winnerTemplateReady={state.winnerTemplateReady}
            contactingWinner={state.contactingWinner}
            contactResult={state.contactResult}
            onContact={state.contactWinner}
          />
        </div>
      ))}
    </div>
  );
}

const rowButton = (id: string) => within(screen.getByTestId(id)).getByRole('button');

describe('Contact Winner — mounted production controls', () => {
  let mockFetch: FetchMock;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hides actions entirely when the server permission flag is false', async () => {
    mockFetch.mockResolvedValue(response(200, readyPayload('ready')));
    render(<Harness permitted={false} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('disables buttons during loading and for a non-approved winner template', async () => {
    const readiness = deferred<ReturnType<typeof response>>();
    mockFetch.mockReturnValue(readiness.promise);
    render(<Harness />);
    expect(rowButton('winner-a').hasAttribute('disabled')).toBe(true);
    await act(async () => { readiness.resolve(response(200, readyPayload('pending'))); });
    expect(rowButton('winner-a').hasAttribute('disabled')).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('uses nested winner readiness, not the top-level pickup status', async () => {
    mockFetch.mockResolvedValue(response(200, {
      status: 'ready', templates: { promo_winner_status_v1: { status: 'rejected' } },
    }));
    render(<Harness />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(rowButton('winner-a').hasAttribute('disabled')).toBe(true);
    expect(rowButton('winner-b').hasAttribute('disabled')).toBe(true);
  });

  it('enables actions only for the current business and campaign', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      response(200, readyPayload(url.includes('biz-a') ? 'ready' : 'pending')));
    const view = render(<Harness businessId="biz-a" />);
    await waitFor(() => expect(rowButton('winner-a').hasAttribute('disabled')).toBe(false));

    view.rerender(<Harness businessId="biz-b" campaignId="campaign-b" />);
    expect(rowButton('winner-a').hasAttribute('disabled')).toBe(true);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(rowButton('winner-b').hasAttribute('disabled')).toBe(true);
  });

  it('ignores a late ready response from the previous business after a new 401', async () => {
    const oldReadiness = deferred<ReturnType<typeof response>>();
    mockFetch.mockImplementation((url: string) =>
      url.includes('biz-a') ? oldReadiness.promise : Promise.resolve(response(401)));
    const view = render(<Harness businessId="biz-a" />);
    expect(rowButton('winner-a').hasAttribute('disabled')).toBe(true);
    view.rerender(<Harness businessId="biz-b" campaignId="campaign-b" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await act(async () => { oldReadiness.resolve(response(200, readyPayload('ready'))); });
    expect(rowButton('winner-a').hasAttribute('disabled')).toBe(true);
  });

  it.each([401, 503, 500])('fails closed on readiness HTTP %s', async status => {
    mockFetch.mockResolvedValue(response(status));
    render(<Harness />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(rowButton('winner-a').hasAttribute('disabled')).toBe(true);
    fireEvent.click(rowButton('winner-a'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('locks multiple winners synchronously before React can commit state', async () => {
    const post = deferred<ReturnType<typeof response>>();
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === 'POST' ? post.promise : Promise.resolve(response(200, readyPayload('ready'))));
    render(<Harness />);
    await waitFor(() => expect(rowButton('winner-a').hasAttribute('disabled')).toBe(false));

    act(() => {
      fireEvent.click(rowButton('winner-a'));
      fireEvent.click(rowButton('winner-b'));
    });

    const postCalls = mockFetch.mock.calls.filter(args => args[1]?.method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0][0]).toBe('/api/promotions/winners/contact');
    expect(JSON.parse(postCalls[0][1].body)).toEqual({
      businessId: 'biz-a', campaignId: 'campaign-a', redemptionId: 'winner-a',
    });
    expect(rowButton('winner-a').hasAttribute('disabled')).toBe(true);
    expect(rowButton('winner-b').hasAttribute('disabled')).toBe(true);
    expect(within(screen.getByTestId('winner-a')).getByText('Sending…')).toBeTruthy();

    await act(async () => { post.resolve(response(200, { sent: true })); });
    await waitFor(() => expect(rowButton('winner-b').hasAttribute('disabled')).toBe(false));
    expect(within(screen.getByTestId('winner-a')).getByRole('status').textContent).toContain('notified');
    expect(within(screen.getByTestId('winner-b')).queryByRole('status')).toBeNull();
  });

  it('displays failure only on the selected row and unlocks for retry', async () => {
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? response(429, { message: 'Wait before sending again.' })
        : response(200, readyPayload('ready')));
    render(<Harness />);
    await waitFor(() => expect(rowButton('winner-a').hasAttribute('disabled')).toBe(false));

    fireEvent.click(rowButton('winner-b'));
    await waitFor(() => expect(within(screen.getByTestId('winner-b')).getByRole('alert')).toBeTruthy());
    expect(within(screen.getByTestId('winner-b')).getByRole('alert').textContent).toContain('Wait');
    expect(within(screen.getByTestId('winner-a')).queryByRole('alert')).toBeNull();
    expect(rowButton('winner-a').hasAttribute('disabled')).toBe(false);
  });

  it('drops stale send results after switching business mid-flight', async () => {
    const oldPost = deferred<ReturnType<typeof response>>();
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return oldPost.promise;
      return Promise.resolve(response(200, readyPayload(url.includes('biz-a') ? 'ready' : 'pending')));
    });
    const view = render(<Harness businessId="biz-a" />);
    await waitFor(() => expect(rowButton('winner-a').hasAttribute('disabled')).toBe(false));
    fireEvent.click(rowButton('winner-a'));
    view.rerender(<Harness businessId="biz-b" campaignId="campaign-b" />);
    await act(async () => { oldPost.resolve(response(200, { sent: true })); });
    expect(rowButton('winner-a').hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
