/**
 * Try Waaiio demo (#460) — interaction and truthfulness tests
 *
 * Proves the demo is visitor-interactive (not auto-play-only),
 * supports free-text input, and does not contain unsupported claims.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const demoSrc = readFileSync(
  resolve(__dirname, '../../components/marketing/LiveBotDemo.tsx'),
  'utf-8'
);

const heroFlowSrc = readFileSync(
  resolve(__dirname, '../../components/marketing/HeroAutomationFlow.tsx'),
  'utf-8'
);

const homeClientSrc = readFileSync(
  resolve(__dirname, '../../app/(marketing)/HomeClient.tsx'),
  'utf-8'
);

describe('#460 LiveBotDemo — visitor interaction', () => {
  it('has multiple scenario tabs (Book, Order, Ticket)', () => {
    expect(demoSrc).toContain("id: 'book'");
    expect(demoSrc).toContain("id: 'order'");
    expect(demoSrc).toContain("id: 'ticket'");
    expect(demoSrc).toContain('scenario-tab-');
  });

  it('waits for visitor input before advancing (not auto-play)', () => {
    // Must have waitingForInput state that gates interaction
    expect(demoSrc).toContain('waitingForInput');
    // Options are shown only when waiting for input
    expect(demoSrc).toContain('waitingForInput && opts');
    // processAction is gated by waitingForInput
    expect(demoSrc).toContain('if (!waitingForInput) return');
  });

  it('visitor tapping an option advances the scenario', () => {
    // handleOptionClick calls processAction
    expect(demoSrc).toContain('handleOptionClick');
    expect(demoSrc).toContain('processAction(optionText)');
    // processAction shows user message and bot reply
    expect(demoSrc).toContain("from: 'user', text: userDisplay");
    expect(demoSrc).toContain('showBotMessage');
  });

  it('has a free-text input for natural language', () => {
    expect(demoSrc).toContain('demo-input');
    expect(demoSrc).toContain('handleFreeText');
    // Free text triggers processAction
    expect(demoSrc).toContain('processAction(trimmed)');
  });

  it('has a wildcard trigger for free-text fallback in each scenario', () => {
    // Each scenario should have a '*' trigger for free-text handling
    const wildcardMatches = demoSrc.match(/trigger: '\*'/g);
    expect(wildcardMatches).not.toBeNull();
    expect(wildcardMatches!.length).toBeGreaterThanOrEqual(3);
  });

  it('has reset/replay functionality', () => {
    expect(demoSrc).toContain('handleReset');
    expect(demoSrc).toContain('demo-reset');
  });

  it('has demo-options test ID for option buttons', () => {
    expect(demoSrc).toContain('demo-options');
  });

  it('does not auto-play customer/user messages', () => {
    // There should be no auto-play of user turns
    // User messages only appear via processAction which requires waitingForInput
    expect(demoSrc).not.toContain('auto-play');
    expect(demoSrc).not.toContain('playNextTurn');
    expect(demoSrc).not.toContain('isPlaying');
  });
});

describe('#460 LiveBotDemo — no fabricated business names from #452', () => {
  it("does not use King's Cuts (removed by #452)", () => {
    expect(demoSrc).not.toContain("King's Cuts");
  });

  it('does not call external API', () => {
    expect(demoSrc).not.toContain('/api/demo/chat');
    expect(demoSrc).not.toContain('fetch(');
  });
});

describe('#460 HeroAutomationFlow — no unsupported claims', () => {
  it('does not claim 0s response time', () => {
    expect(heroFlowSrc).not.toContain('0s');
    expect(heroFlowSrc).not.toMatch(/Response Time/);
  });

  it('does not claim 100% automated', () => {
    expect(heroFlowSrc).not.toContain('100%');
    expect(heroFlowSrc).not.toMatch(/Automated/);
  });

  it('uses non-quantified truthful language', () => {
    expect(heroFlowSrc).toContain('Instant Replies');
    expect(heroFlowSrc).toContain('Secure Payments');
  });
});

describe('#460 reduced-motion — CSS animations', () => {
  it('HeroAutomationFlow conditionally renders animate-ping', () => {
    // animate-ping must be conditionally rendered, not always present
    expect(heroFlowSrc).toContain('!noMotion');
    expect(heroFlowSrc).toContain('animate-ping');
    // The ping should be inside a conditional
    expect(heroFlowSrc).toMatch(/\{!noMotion && <span.*animate-ping/);
  });

  it('HomeClient hero badge conditionally renders animate-ping', () => {
    expect(homeClientSrc).toContain('!noMotion');
    // The ping should be inside a conditional
    expect(homeClientSrc).toMatch(/\{!noMotion && <span.*animate-ping/);
  });

  it('LiveBotDemo typing indicator has motion-reduce class', () => {
    expect(demoSrc).toContain('motion-reduce:animate-none');
  });
});

describe('#460 copy audit — no unsupported absolute/numerical claims', () => {
  it('homepage does not contain unsupported performance claims', () => {
    // No "0s", no "100%", no unsupported "X%" claims
    expect(homeClientSrc).not.toMatch(/\b0s\b/);
    expect(homeClientSrc).not.toContain('100%');
    expect(homeClientSrc).not.toMatch(/\d+%.*faster/i);
    expect(homeClientSrc).not.toMatch(/\d+%.*automated/i);
  });

  it('homepage does not contain "89+ business types"', () => {
    expect(homeClientSrc).not.toContain('89+');
  });

  it('homepage does not contain "5 countries" in trust strip', () => {
    // The trust strip should not claim a specific country count
    expect(homeClientSrc).not.toMatch(/Available in.*\d+ countries/);
  });
});
