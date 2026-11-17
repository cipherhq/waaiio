// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FlowAnswers } from './FlowAnswers';

const biz = 'biz-1';
const flows = [{ id: 'f1', name: 'Retreat sign-up' }, { id: 'f2', name: 'Salon' }];
const responses = [
  { response_id: 'r2', customer_number: '2348099999999', answered_at: '2026-11-12T09:00:00.000Z', answers: [
    { id: 'a4', node_id: 'coming', question: 'Are you coming?', answer_type: 'yes_no', value_text: 'No', value_date: null, file_mime: null, file_size: null, created_at: '2026-11-12T09:00:00.000Z' }] },
  { response_id: 'r1', customer_number: '2348012345678', answered_at: '2026-11-10T09:02:00.000Z', answers: [
    { id: 'a1', node_id: 'coming', question: 'Are you coming?', answer_type: 'yes_no', value_text: 'Yes', value_date: null, file_mime: null, file_size: null, created_at: '2026-11-10T09:00:00.000Z' },
    { id: 'a2', node_id: 'day', question: 'Which day?', answer_type: 'date', value_text: null, value_date: '2026-11-21', file_mime: null, file_size: null, created_at: '2026-11-10T09:01:00.000Z' },
    { id: 'a3', node_id: 'id', question: 'Send your ID', answer_type: 'file', value_text: null, value_date: null, file_mime: 'application/pdf', file_size: 10, created_at: '2026-11-10T09:02:00.000Z' }] },
];
let state: { flows: typeof flows; responses: typeof responses; canDelete: boolean; truncated?: boolean; remainingCalls?: number };
let posts: Array<Record<string, unknown>>;

beforeEach(() => {
  state = { flows, responses: structuredClone(responses), canDelete: true };
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)); posts.push(body);
      if (state.remainingCalls) { state.remainingCalls--; return { ok: true, json: async () => ({ deleted: 500, remaining: true }) }; }
      const before = state.responses.length;
      state.responses = body.action === 'delete_flow_answers' ? [] : state.responses.filter(r => r.response_id !== body.responseId);
      return { ok: true, json: async () => ({ deleted: before === state.responses.length ? 0 : body.action === 'delete_flow_answers' ? 4 : 3 }) };
    }
    if (url.includes('&file=')) return { ok: true, json: async () => ({ url: 'https://signed/x', expiresIn: 300 }) };
    const flowId = new URL(url, 'http://x').searchParams.get('flowId');
    return { ok: true, json: async () => ({ flows: state.flows, canDelete: state.canDelete, truncated: !!state.truncated, ...(flowId ? { responses: flowId === 'f1' ? state.responses : [] } : {}) }) };
  }));
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('open', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderPage = () => render(<FlowAnswers businessId={biz} timezone="Africa/Lagos" country="GB" />);

describe('Flow answers page', () => {
  it('shows a friendly empty state with a way to build a flow when there are no flows', async () => {
    state.flows = [];
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No flows yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Build a flow' }).getAttribute('href')).toBe('/dashboard/custom-flows');
  });

  it('groups answers by customer, newest first, with full dates and file buttons', async () => {
    renderPage();
    const list = await screen.findByRole('list', { name: 'Answers for Retreat sign-up' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards.map(c => within(c).getByRole('heading').textContent)).toEqual(['+2348099999999', '+2348012345678']);
    expect(within(cards[1]).getByText('Saturday, 21 November 2026')).toBeTruthy();
    expect(within(cards[1]).getByText('Answered 10 Nov 2026, 10:02')).toBeTruthy();
    fireEvent.click(within(cards[1]).getByRole('button', { name: 'View PDF' }));
    await waitFor(() => expect(window.open).toHaveBeenCalledWith('https://signed/x', '_blank', 'noopener,noreferrer'));
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === `/api/custom-flows/responses?businessId=${biz}&file=a3`)).toBe(true);
  });

  it('links the CSV download for the selected flow', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: 'Download CSV' });
    expect(link.getAttribute('href')).toBe(`/api/custom-flows/responses?businessId=${biz}&flowId=f1&format=csv`);
  });

  it('shows an empty state for a flow with no answers yet', async () => {
    renderPage();
    await screen.findByRole('list');
    fireEvent.change(screen.getByLabelText('Flow'), { target: { value: 'f2' } });
    expect(await screen.findByRole('heading', { name: 'No answers yet' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Download CSV' })).toBeNull();
  });

  it('the owner deletes one customer’s answers only after confirming', async () => {
    renderPage();
    const button = await screen.findByRole('button', { name: 'Delete answers from +2348012345678' });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(button);
    expect(window.confirm).toHaveBeenCalledWith('Delete these answers? This cannot be undone.');
    expect(posts).toEqual([]);
    fireEvent.click(button);
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '3 answers deleted.');
    expect(posts).toEqual([{ businessId: biz, flowId: 'f1', action: 'delete_response', responseId: 'r1' }]);
    expect(screen.queryByText('+2348012345678')).toBeNull();
  });

  it('the owner can delete every answer for a flow after confirming', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all answers for this flow' }));
    expect(window.confirm).toHaveBeenCalledWith('Delete every answer for this flow? This cannot be undone.');
    expect(await screen.findByRole('heading', { name: 'No answers yet' })).toBeTruthy();
    expect(posts[0]).toMatchObject({ action: 'delete_flow_answers', flowId: 'f1' });
  });

  it('keeps deleting while the server says answers remain, then reports the total', async () => {
    state.remainingCalls = 2;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all answers for this flow' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '1004 answers deleted.');
    expect(posts).toHaveLength(3);
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });

  it('team members can read and download but see no delete buttons', async () => {
    state.canDelete = false;
    renderPage();
    await screen.findByRole('list');
    expect(screen.getByRole('link', { name: 'Download CSV' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('says when only the newest answers are shown', async () => {
    state.truncated = true;
    renderPage();
    expect(await screen.findByText('Showing the newest answers. Download the CSV to get all of them.')).toBeTruthy();
  });

  it('uses plain English with no code words', async () => {
    const { container } = renderPage();
    await screen.findByRole('list');
    expect(container.textContent).not.toMatch(/\b(node|response_id|lookup|yes_no|null|undefined)\b|\{\{/);
  });
});
