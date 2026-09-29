/**
 * Try Waaiio demo (#460) — interaction, truthfulness, and accessibility tests
 *
 * Proves the demo is visitor-interactive (not auto-play-only),
 * every visible option has a modeled next step (no dead branches),
 * supports free-text input, contains no unsupported claims,
 * and honors prefers-reduced-motion for all animation paths.
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

// ── Helper: extract all visible options and all trigger texts from scenario data ──

function extractOptionsAndTriggers(src: string) {
  // Extract all option strings from greeting and step options arrays
  const optionMatches = src.match(/options:\s*\[([^\]]+)\]/g) || [];
  const allOptions = new Set<string>();
  for (const match of optionMatches) {
    const inner = match.replace(/^options:\s*\[/, '').replace(/\]$/, '');
    // Extract quoted strings (handle single and double quotes, escaped quotes)
    const strings = inner.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) || [];
    for (const s of strings) {
      allOptions.add(s.slice(1, -1)); // remove surrounding quotes
    }
  }

  // Extract all trigger strings
  const triggerMatches = src.match(/trigger:\s*'([^']+)'/g) || [];
  const allTriggers = new Set<string>();
  for (const match of triggerMatches) {
    const trigger = match.replace(/^trigger:\s*'/, '').replace(/'$/, '');
    allTriggers.add(trigger);
  }

  return { allOptions, allTriggers };
}

// ── Visitor interaction ──

describe('#460 LiveBotDemo — visitor interaction', () => {
  it('has multiple scenario tabs (Book, Order, Ticket)', () => {
    expect(demoSrc).toContain("id: 'book'");
    expect(demoSrc).toContain("id: 'order'");
    expect(demoSrc).toContain("id: 'ticket'");
    expect(demoSrc).toContain('scenario-tab-');
  });

  it('waits for visitor input before advancing (not auto-play)', () => {
    expect(demoSrc).toContain('waitingForInput');
    expect(demoSrc).toContain('waitingForInput && opts');
    expect(demoSrc).toContain('if (!waitingForInput) return');
  });

  it('visitor tapping an option advances the scenario', () => {
    expect(demoSrc).toContain('handleOptionClick');
    expect(demoSrc).toContain('processAction(optionText)');
    expect(demoSrc).toContain('showBotMessage');
  });

  it('has a free-text input for natural language', () => {
    expect(demoSrc).toContain('demo-input');
    expect(demoSrc).toContain('handleFreeText');
    expect(demoSrc).toContain('processAction(trimmed)');
  });

  it('has reset/replay functionality', () => {
    expect(demoSrc).toContain('handleReset');
    expect(demoSrc).toContain('demo-reset');
  });

  it('has demo-options test ID for option buttons', () => {
    expect(demoSrc).toContain('demo-options');
  });

  it('does not auto-play customer/user messages', () => {
    expect(demoSrc).not.toContain('playNextTurn');
    expect(demoSrc).not.toContain('isPlaying');
  });
});

// ── No dead branches: every visible option has a matching trigger ──

describe('#460 LiveBotDemo — no dead/looping branches', () => {
  it('every visible option has a modeled trigger step', () => {
    const { allOptions, allTriggers } = extractOptionsAndTriggers(demoSrc);

    const deadOptions: string[] = [];
    for (const opt of allOptions) {
      if (!allTriggers.has(opt)) {
        deadOptions.push(opt);
      }
    }

    expect(deadOptions).toEqual([]);
  });

  it('does not have a wildcard (*) fallback trigger', () => {
    // No '*' triggers — every option must lead to a specific step
    expect(demoSrc).not.toContain("trigger: '*'");
  });

  it('Book scenario: greeting options all have triggers', () => {
    // Greeting shows Manicure and Pedicure
    expect(demoSrc).toContain("trigger: 'Manicure'");
    expect(demoSrc).toContain("trigger: 'Pedicure'");
  });

  it('Book scenario: time options all have triggers', () => {
    expect(demoSrc).toContain("trigger: 'Tomorrow 2pm'");
    expect(demoSrc).toContain("trigger: 'Tomorrow 4pm'");
  });

  it('Order scenario: greeting options all have triggers', () => {
    expect(demoSrc).toContain("trigger: 'Jollof Rice'");
    expect(demoSrc).toContain("trigger: 'Fried Rice'");
  });

  it('Order scenario: add/skip options all have triggers', () => {
    // Both "Add Plantain" and "No thanks" must have triggers
    expect(demoSrc).toMatch(/trigger: 'Add Plantain/);
    expect(demoSrc).toContain("trigger: 'No thanks, place order'");
    expect(demoSrc).toContain("trigger: 'Place Order'");
  });

  it('Ticket scenario: quantity options all have triggers', () => {
    expect(demoSrc).toContain("trigger: '1 Ticket'");
    expect(demoSrc).toContain("trigger: '2 Tickets'");
    expect(demoSrc).toContain("trigger: 'Confirm'");
  });

  it('Ticket scenario: does not show unmodeled options', () => {
    // These were removed because they had no real next step
    expect(demoSrc).not.toContain("'Event Details'");
    expect(demoSrc).not.toContain("'3 Tickets'");
    expect(demoSrc).not.toContain("'Change Quantity'");
  });

  it('Book scenario: does not show unmodeled options', () => {
    expect(demoSrc).not.toContain("'View Services'");
    expect(demoSrc).not.toContain("'Gel Nails'");
    expect(demoSrc).not.toContain("'Saturday 10am'");
  });

  it('Order scenario: does not show unmodeled options', () => {
    expect(demoSrc).not.toContain("'View Full Menu'");
    expect(demoSrc).not.toContain("'Add More'");
  });
});

// ── No fabricated names ──

describe('#460 LiveBotDemo — no fabricated business names from #452', () => {
  it("does not use King's Cuts (removed by #452)", () => {
    expect(demoSrc).not.toContain("King's Cuts");
  });

  it('does not call external API', () => {
    expect(demoSrc).not.toContain('/api/demo/chat');
    expect(demoSrc).not.toContain('fetch(');
  });
});

// ── Marketing claims ──

describe('#460 HeroAutomationFlow — no unsupported claims', () => {
  it('does not claim 0s response time', () => {
    expect(heroFlowSrc).not.toContain('0s');
    expect(heroFlowSrc).not.toMatch(/Response Time/);
  });

  it('does not claim 100% automated', () => {
    expect(heroFlowSrc).not.toContain('100%');
  });

  it('does not claim "Instant Replies"', () => {
    expect(heroFlowSrc).not.toContain('Instant Replies');
  });

  it('does not claim "24/7" or "Always On"', () => {
    expect(heroFlowSrc).not.toContain('24/7');
    expect(heroFlowSrc).not.toContain('Always On');
  });

  it('uses non-quantified descriptive language', () => {
    expect(heroFlowSrc).toContain('Automated Replies');
    expect(heroFlowSrc).toContain('Works in WhatsApp');
    expect(heroFlowSrc).toContain('Secure Payments');
  });
});

// ── Reduced motion ──

describe('#460 reduced-motion — complete coverage', () => {
  it('HeroAutomationFlow conditionally renders animate-ping', () => {
    expect(heroFlowSrc).toContain('!noMotion');
    expect(heroFlowSrc).toContain('animate-ping');
    expect(heroFlowSrc).toMatch(/\{!noMotion && <span.*animate-ping/);
  });

  it('HomeClient hero badge conditionally renders animate-ping', () => {
    expect(homeClientSrc).toContain('!noMotion');
    expect(homeClientSrc).toMatch(/\{!noMotion && <span.*animate-ping/);
  });

  it('LiveBotDemo typing indicator has motion-reduce class', () => {
    expect(demoSrc).toContain('motion-reduce:animate-none');
  });

  it('LiveBotDemo imports useReducedMotion from framer-motion', () => {
    expect(demoSrc).toContain('useReducedMotion');
    expect(demoSrc).toMatch(/import.*useReducedMotion.*from 'framer-motion'/);
  });

  it('LiveBotDemo disables Framer Motion transitions under reduced motion', () => {
    // Must construct transition props conditionally based on noMotion
    expect(demoSrc).toContain('noMotion');
    expect(demoSrc).toContain('msgTransition');
    expect(demoSrc).toContain('typingTransition');
    // When noMotion, initial/animate should be undefined
    expect(demoSrc).toMatch(/noMotion\s*\?\s*\{.*initial:\s*undefined/);
  });
});

// ── Copy audit ──

describe('#460 copy audit — no unsupported absolute/numerical claims', () => {
  it('homepage does not contain unsupported performance claims', () => {
    expect(homeClientSrc).not.toMatch(/\b0s\b/);
    expect(homeClientSrc).not.toContain('100%');
    expect(homeClientSrc).not.toMatch(/\d+%.*faster/i);
    expect(homeClientSrc).not.toMatch(/\d+%.*automated/i);
  });

  it('homepage does not contain "89+ business types"', () => {
    expect(homeClientSrc).not.toContain('89+');
  });

  it('homepage does not contain "5 countries" in trust strip', () => {
    expect(homeClientSrc).not.toMatch(/Available in.*\d+ countries/);
  });

  it('HeroAutomationFlow has no numeric SLA or performance claim', () => {
    // No percentage, no "Xs" time claims, no "24/7"
    expect(heroFlowSrc).not.toMatch(/\d+%/);
    expect(heroFlowSrc).not.toMatch(/\b\ds\b/);
    expect(heroFlowSrc).not.toContain('24/7');
  });
});
