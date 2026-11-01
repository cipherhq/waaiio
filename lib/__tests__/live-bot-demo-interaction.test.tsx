// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import LiveBotDemo from '@/components/marketing/LiveBotDemo';
vi.mock('framer-motion', () => ({
  useReducedMotion: () => true,
  AnimatePresence: ({children}: any) => children,
  motion: {div: ({initial, animate, transition, ...props}: any) => <div {...props} />},
}));
beforeEach(() => vi.useFakeTimers());
afterEach(() => {cleanup(); vi.useRealTimers();});
async function settle() { await act(async () => { await vi.runAllTimersAsync(); }); }
async function choose(name: string) {fireEvent.click(screen.getByRole('button', {name})); await settle();}
function chat() {return screen.getByRole('log').textContent || '';}
describe('interactive customer demo', () => {
  it('retains selected service, date and time and waits for payment before confirming', async () => {
    render(<LiveBotDemo />); await settle();
    for (const option of ['Pedicure','This Saturday','4:00 PM','Confirm booking']) await choose(option);
    expect(chat()).toContain('Total: $50');
    expect(chat()).toContain('This Saturday, 4:00 PM');
    expect(chat()).not.toContain('Appointment confirmed');
    await choose('Simulate payment');
    expect(chat()).toContain('Appointment confirmed');
    expect(chat()).not.toContain('{{');
  });
  it('retains ticket quantity and total through payment', async () => {
    render(<LiveBotDemo />); fireEvent.click(screen.getByTestId('scenario-tab-ticket')); await settle();
    for (const option of ['Buy Tickets','2 Tickets','Confirm']) await choose(option);
    expect(chat()).toContain('₦30,000');
    expect(chat()).not.toContain('Your tickets are ready');
    await choose('Simulate payment');
    expect(chat()).toContain('Your tickets are ready');
    expect(chat()).toContain('2 × General Admission');
  });
  it('keeps the chosen food and total through pickup and payment', async () => {
    render(<LiveBotDemo />);
    fireEvent.click(screen.getByTestId('scenario-tab-order')); await settle();
    for (const option of ['Fried Rice','1 portion','Checkout','Pickup','Place Order']) await choose(option);
    expect(chat()).toContain('₦2,800');
    expect(chat()).not.toContain('Order confirmed');
    await choose('Simulate payment');
    expect(chat()).toContain('Order confirmed');
    expect(chat()).not.toContain('{{');
  });
  it('does not allow typed future choices to skip steps and recovers with current choices', async () => {
    render(<LiveBotDemo />); await settle();
    fireEvent.change(screen.getByLabelText('Demo message'), {target:{value:'Simulate payment'}});
    fireEvent.keyDown(screen.getByLabelText('Demo message'), {key:'Enter'}); await settle();
    expect(chat()).not.toContain('Payment received');
    await choose('Manicure');
    expect(chat()).toContain('$35');
    expect(screen.getByRole('button',{name:'Tomorrow'})).toBeTruthy();
  });
  it('cancels pending replies when replaying or switching scenario', async () => {
    render(<LiveBotDemo />); await settle();
    fireEvent.click(screen.getByRole('button',{name:'Pedicure'}));
    fireEvent.click(screen.getByTestId('scenario-tab-order')); await settle();
    expect(chat()).toContain('Fresh Kitchen');
    expect(chat()).not.toContain('Pedicure');
    await choose('Fried Rice');
    fireEvent.click(screen.getByTestId('demo-reset')); await settle();
    expect(screen.getByRole('button',{name:'Jollof Rice'})).toBeTruthy();
    expect(chat()).not.toContain('₦2,800');
  });
});
