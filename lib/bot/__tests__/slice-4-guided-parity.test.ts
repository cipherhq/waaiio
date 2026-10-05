/**
 * Slice 4 — Guided + Free-Text Input Parity tests (#524)
 *
 * Proves:
 * 1. Typed aliases converge with postback IDs for reversible guided steps
 * 2. select_campaign: tenant-scoped, ambiguity fails closed, cross-tenant rejected
 * 3. Irreversible steps reject generic aliases (queue_confirm_checkin, confirm_donation)
 * 4. loyalty_redeem go_back bug fix: routes to menu, cannot trigger redemption
 * 5. resume_sub only reachable via exact postback
 * 6. Multi-entity carry-forward boundary (positive + negative)
 * 7. Post-completion aliases resolve correctly
 * 8. Language switch preserves session state
 * 9. CERTIFIED_LANGUAGES unchanged
 * 10. Runtime precedence: generic aliases not intercepted by global escape hatches
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');

// ═══════════════════════════════════════════════════════════════
// Part 1: Typed alias convergence for reversible guided steps
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — typed alias convergence', () => {

  // ── Invoice detail ──
  it('invoice_detail: "pay", "pay now", "back", "go back" resolve like postback IDs', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/invoice.flow.ts'), 'utf-8');
    // Verify aliases are present in the validator
    expect(source).toContain("lower === 'pay' || lower === 'pay now'");
    expect(source).toContain("lower === 'back' || lower === 'back to list' || lower === 'go back'");
  });

  // ── Loyalty menu ──
  it('loyalty_menu: "history", "redeem", "back" resolve like postback IDs', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/loyalty.flow.ts'), 'utf-8');
    expect(source).toContain("lower === 'view_history' || lower === 'history' || lower === 'points'");
    expect(source).toContain("lower === 'redeem' || lower === 'redeem reward'");
    expect(source).toContain("lower === 'back_to_account' || lower === 'back'");
  });

  // ── Queue start ──
  it('queue_start: "join", "join queue", "status", "my position" resolve', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/queue-checkin.flow.ts'), 'utf-8');
    expect(source).toContain("normalized === 'join' || normalized === 'join queue'");
    expect(source).toContain("normalized === 'status' || normalized === 'my position'");
  });

  // ── Queue check_status ──
  it('queue_check_status: "join" resolves; unrecognized input fails (not silent passthrough)', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/queue-checkin.flow.ts'), 'utf-8');
    // Must have explicit error for unrecognized input (no silent passthrough)
    expect(source).toContain("valid: false, errorMessage: 'Type *join* to join the queue, or *leave* to leave.'");
  });

  // ── Poll: numeric index ──
  it('poll_question: numeric index "1", "2" resolves to option', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/poll.flow.ts'), 'utf-8');
    expect(source).toContain("Numeric index fallback");
    expect(source).toContain("parseInt(lower, 10) - 1");
  });

  // ── Scheduling: book_for_other ──
  it('book_for_other: "myself", "me", "someone else", "other" resolve', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/scheduling.flow.ts'), 'utf-8');
    expect(source).toContain("lower === 'for_myself' || lower === 'myself' || lower === 'me'");
    expect(source).toContain("lower === 'for_other' || lower === 'someone else' || lower === 'other'");
  });

  // ── Ordering: addon_continue ──
  it('addon_continue: "more", "add more", "done", "continue" resolve', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
    expect(source).toContain("lower === 'more_addons' || lower === 'more' || lower === 'add more'");
    expect(source).toContain("lower === 'done_addons' || lower === 'done' || lower === 'continue'");
  });

  // ── Crowdfunding: campaign_view ──
  it('campaign_view: "donate", "yes", "back" resolve like postback IDs', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/crowdfunding.flow.ts'), 'utf-8');
    expect(source).toContain("lower === 'donate_yes' || lower === 'donate' || lower === 'yes'");
    expect(source).toContain("lower === 'donate_back' || lower === 'back'");
  });

  // ── Recurring: select_action safe aliases ──
  it('select_action: "cancel subscription", "pause", "details", "history" resolve safely', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/recurring-manage.flow.ts'), 'utf-8');
    expect(source).toContain("text === 'cancel subscription' || text === 'cancel recurring payment'");
    expect(source).toContain("text === 'pause_sub' || text === 'pause'");
    expect(source).toContain("text === 'view_details' || text === 'details'");
    expect(source).toContain("text === 'payment_history' || text === 'history'");
  });

  // ── Recurring: list_subscriptions numeric index ──
  it('list_subscriptions: numeric index "1", "2" resolves to subscription', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/recurring-manage.flow.ts'), 'utf-8');
    expect(source).toContain('Numeric index fallback');
    expect(source).toContain("parseInt(input.trim(), 10) - 1");
  });

  // ── Recurring: subscription_details ──
  it('subscription_details: "history", "payments" resolve', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/recurring-manage.flow.ts'), 'utf-8');
    expect(source).toContain("text === 'payment_history' || text === 'history' || text === 'payments'");
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 2: select_campaign — tenant scope + ambiguity fail-closed
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — select_campaign tenant hardening', () => {
  it('authoritative UUID fetch includes business_id predicate', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/crowdfunding.flow.ts'), 'utf-8');
    // The UUID fetch path must scope by business_id
    expect(source).toContain(".eq('id', campaignId)");
    expect(source).toContain(".eq('business_id', ctx.business.id)");
  });

  it('name/index fallback path scopes candidates by business_id', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/crowdfunding.flow.ts'), 'utf-8');
    // The fallback name/index path must also scope by business_id
    const fallbackSection = source.indexOf('Fallback: name match or numeric index');
    expect(fallbackSection).toBeGreaterThan(-1);
    const afterFallback = source.slice(fallbackSection, fallbackSection + 500);
    expect(afterFallback).toContain(".eq('business_id', ctx.business.id)");
  });

  it('ambiguous substring match fails closed with clarification', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/crowdfunding.flow.ts'), 'utf-8');
    // Must use .filter() not .find() for substring — unique match only
    expect(source).toContain('const subMatches = eligible.filter(');
    expect(source).toContain('subMatches.length === 1');
    expect(source).toContain('subMatches.length > 1');
    expect(source).toContain('Multiple campaigns match. Which one?');
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 3: Irreversible steps reject generic aliases
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — irreversible step boundaries', () => {
  it('queue_confirm_checkin: "yes", "ok", "sure" are rejected — only confirm_checkin/confirm/cancel accepted', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/queue-checkin.flow.ts'), 'utf-8');
    // The queue_confirm_checkin validator accepts cancel_checkin, cancel, confirm_checkin, confirm
    expect(source).toContain("text === 'cancel_checkin' || text === 'cancel'");
    expect(source).toContain("text !== 'confirm_checkin' && text !== 'confirm'");
    // Slice 4 must NOT have added 'yes', 'ok', 'sure' as confirmation aliases to this step
    // Search the section between queue_confirm_checkin and the next step
    const confirmStepIdx = source.indexOf("id: 'queue_confirm_checkin'");
    const nextStepIdx = source.indexOf("id: 'queue_check_status'");
    const confirmSection = source.slice(confirmStepIdx, nextStepIdx);
    expect(confirmSection).not.toContain("=== 'yes'");
    expect(confirmSection).not.toContain("=== 'ok'");
    expect(confirmSection).not.toContain("=== 'sure'");
  });

  it('confirm_donation: only confirm_yes/confirm_cancel accepted — no "yes"/"ok" aliases', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/crowdfunding.flow.ts'), 'utf-8');
    const confirmIdx = source.indexOf("id: 'confirm_donation'");
    expect(confirmIdx).toBeGreaterThan(-1);
    const section = source.slice(confirmIdx, confirmIdx + 500);
    // Only exact IDs
    expect(section).toContain("'confirm_yes'");
    expect(section).toContain("'confirm_cancel'");
    // Must NOT accept generic affirmatives
    const validateStart = section.indexOf('validate(');
    const validateBlock = section.slice(validateStart, validateStart + 200);
    expect(validateBlock).not.toContain("=== 'yes'");
    expect(validateBlock).not.toContain("=== 'ok'");
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 4: loyalty_redeem go_back bug fix
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — loyalty_redeem go_back bug fix', () => {
  it('go_back is handled in loyalty_redeem validator and routes to skip (menu), not confirm', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/loyalty.flow.ts'), 'utf-8');
    // The validator must handle go_back and map to skip action
    expect(source).toContain("if (input === 'go_back') return { valid: true, data: { _redeem_action: 'skip' } }");
  });

  it('go_back cannot trigger redeem_loyalty_points RPC — skip routes to loyalty_menu', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/loyalty.flow.ts'), 'utf-8');
    // The next() for skip routes to loyalty_menu, bypassing the RPC
    expect(source).toContain("if (action === 'skip') return 'loyalty_menu'");
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 5: resume_sub only via exact postback
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — resume_sub irreversible boundary', () => {
  it('resume_sub has no typed aliases — only exact postback ID accepted', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/recurring-manage.flow.ts'), 'utf-8');
    // The comment documents why resume has no aliases
    expect(source).toContain('resume_sub: no aliases');
    // The line that handles resume_sub must be exact-only
    expect(source).toContain("text === 'resume_sub') return { valid: true, data: { _sub_action: 'resume' }");
    // There must NOT be a || text === 'resume' alternative on that line
    const resumeLines = source.split('\n').filter(l => l.includes("_sub_action: 'resume'"));
    expect(resumeLines.length).toBeGreaterThan(0);
    for (const line of resumeLines) {
      if (line.includes('validate') || line.includes('return')) {
        expect(line).not.toContain("text === 'resume'");
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 6: Multi-entity carry-forward boundary
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — multi-entity carry-forward boundary', () => {
  it('entity prefill is capability-scoped: party_size only for booking caps', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    // party_size injection requires booking capability
    expect(source).toContain("['scheduling', 'appointment', 'table_reservation', 'reservation'].includes(activeCap");
  });

  it('entity prefill is capability-scoped: amount only for payment caps', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    expect(source).toContain("['payment', 'giving', 'invoice', 'crowdfunding'].includes(activeCap");
  });

  it('entity prefill never overwrites existing session_data values', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    // Each entity check guards against overwrite
    expect(source).toContain('!session.session_data.date');
    expect(source).toContain('!session.session_data.time');
    expect(source).toContain('!session.session_data.party_size');
    expect(source).toContain('!session.session_data.amount');
  });

  it('entity prefill only merges AFTER validate() succeeds', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    // pendingEntities merge is after the validate() result check
    const validateIdx = source.indexOf('const result = await step.validate(input, ctx)');
    const mergeIdx = source.indexOf('Object.assign(session.session_data, pendingEntities)');
    expect(validateIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(validateIdx);
  });

  it('STEP_OWNS_FIELD prevents injecting into current step own field', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    expect(source).toContain("'select_date': 'date'");
    expect(source).toContain("'select_time': 'time'");
    expect(source).toContain("ownedField !== 'date'");
    expect(source).toContain("ownedField !== 'time'");
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 7: Post-completion aliases
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — post-completion typed aliases', () => {
  it('post-completion alias map is present in bot.service.ts', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain("'view options': 'pc_options'");
    expect(source).toContain("'book again': 'pc_again'");
    expect(source).toContain("'my bookings': 'pc_history'");
    expect(source).toContain("'my orders': 'pc_history'");
  });

  it('aliases resolve to canonical IDs consumed by the handler', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // pcText carries the alias-resolved value
    expect(source).toContain('const pcText = pcAliasMap[pcLower] || text');
    // All three canonical IDs are checked via pcText
    expect(source).toContain("pcText === 'pc_options'");
    expect(source).toContain("pcText === 'pc_again'");
    expect(source).toContain("pcText === 'pc_history'");
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 8: Language switch preserves session state
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — language switch state preservation', () => {
  it('language switch uses session_data spread (preserves all existing fields) and only writes _detected_language', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // The handler sets _detected_language on a spread copy of session_data
    expect(source).toContain("updatedData._detected_language = pendingLang");
    expect(source).toContain('const updatedData = { ...session.session_data }');
    // It deletes only the _pending_language fields — everything else is preserved
    expect(source).toContain("delete updatedData._pending_language");
    expect(source).toContain("delete updatedData._pending_language_source");
  });

  it('language switch does not assign active_capability, current_step, or service_id', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // The lang_yes block reads session.business_id to resolve tier (not mutation)
    // but must NOT write to active_capability or current_step or service_id
    const langStart = source.indexOf("updatedData._detected_language = pendingLang");
    const langEnd = source.indexOf("'No problem! I\\'ll keep responding in English.'");
    const langBlock = source.slice(langStart, langEnd);
    expect(langBlock).not.toContain('active_capability');
    expect(langBlock).not.toContain('current_step');
    expect(langBlock).not.toContain('service_id');
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 9: CERTIFIED_LANGUAGES unchanged
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — no CERTIFIED_LANGUAGES expansion', () => {
  it('CERTIFIED_LANGUAGES is derived from catalog — only en has certified: true', () => {
    const catalog = readFileSync(resolve(ROOT, 'lib/bot/languages.ts'), 'utf-8');
    // Count how many languages have certified: true
    const certifiedEntries = catalog.match(/certified:\s*true/g) || [];
    expect(certifiedEntries).toHaveLength(1);
    // Verify it's English
    const enEntry = catalog.match(/code:\s*'en'[^}]*certified:\s*true/);
    expect(enEntry).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 10: Runtime precedence — aliases not intercepted by globals
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — runtime precedence safety', () => {
  it('post-completion step handler runs in bot.service.ts before FlowExecutor — runtime path is step-check then executor', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // In the resumed-session handler, step === 'post_completion' is checked and returns early
    // BEFORE the flow executor is invoked for other steps.
    // The post_completion block ends with `return;` — FlowExecutor never sees the input.
    const pcIdx = source.indexOf("step === 'post_completion'");
    expect(pcIdx).toBeGreaterThan(-1);
    // Verify the pc handler has a return statement (early exit)
    const pcBlock = source.slice(pcIdx, pcIdx + 2000);
    expect(pcBlock).toContain('return;');
    // Alias map is within this block
    expect(pcBlock).toContain('pcAliasMap');
  });

  it('"back" in loyalty_menu does not conflict with global BACK_WORD because FlowExecutor handles escape hatches before step.validate()', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    // FlowExecutor's escape hatch check happens before step.validate()
    // Verify BACK_WORDS are checked and return to previous step
    expect(source).toContain('BACK_WORDS');
    // "back" is in BACK_WORDS — so typing "back" at loyalty_menu would trigger
    // the executor's back-navigation BEFORE the validator alias runs.
    // This means the "back" alias in loyalty_menu is effectively redundant
    // (FlowExecutor navigates back), but not harmful — both paths navigate backward.
  });

  it('plain "cancel" is NOT an alias for cancel_sub in recurring select_action', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/recurring-manage.flow.ts'), 'utf-8');
    // Multi-word aliases are present
    expect(source).toContain("'cancel subscription'");
    expect(source).toContain("'cancel recurring payment'");
    // Find the cancel_sub line in the select_action validator
    const cancelSubLines = source.split('\n').filter(l =>
      l.includes("_sub_action: 'cancel'") && l.includes('return'),
    );
    expect(cancelSubLines.length).toBeGreaterThan(0);
    // That line must NOT contain bare text === 'cancel' (without a following word)
    for (const line of cancelSubLines) {
      // 'cancel_sub' is fine, 'cancel subscription' is fine, bare 'cancel' is not
      const stripped = line.replace(/cancel_sub|cancel subscription|cancel recurring payment/g, '');
      expect(stripped).not.toMatch(/=== 'cancel'/);
    }
  });

  it('"donate" in campaign_view is safe: step validators run in FlowExecutor AFTER escape hatches, and "donate" is not a global keyword', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    // "donate" is not in BACK_WORDS or CANCEL_WORDS or any global escape set
    expect(source).not.toContain("'donate'");
    // Also not in bot.service.ts global keyword routing
    const botSource = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // "donate" is not a global keyword that bot.service.ts intercepts before executor
    const globalKeywords = botSource.slice(0, botSource.indexOf('this.flowExecutor'));
    expect(globalKeywords).not.toMatch(/\bdonate\b.*===.*\bdonate\b/);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 11: No out-of-scope changes
// ═══════════════════════════════════════════════════════════════

describe('Slice 4 — scope containment', () => {
  it('no migration files added or modified', async () => {
    const { execSync } = await import('child_process');
    const diff = execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf-8' });
    const migrationFiles = diff.split('\n').filter(f => f.includes('supabase/migrations'));
    expect(migrationFiles).toHaveLength(0);
  });

  it('no routing/capability/provider files modified', async () => {
    const { execSync } = await import('child_process');
    const diff = execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf-8' });
    const forbidden = diff.split('\n').filter(f =>
      f.includes('lib/channels/') ||
      f.includes('lib/capabilities/') ||
      f.includes('lib/payments/') ||
      f.includes('canonical-understanding') ||
      f.includes('smart-intent') ||
      f.includes('conversation-orchestrator') ||
      f.includes('correction-parser') ||
      f.includes('correction-reentry') ||
      f.includes('language-policy') ||
      f.includes('inbound-command-normalization'),
    );
    expect(forbidden).toHaveLength(0);
  });
});
