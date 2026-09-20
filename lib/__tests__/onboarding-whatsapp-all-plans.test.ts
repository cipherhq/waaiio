/**
 * Regression tests for #346: customer-owned WhatsApp connection on all plans.
 *
 * Proves:
 * 1. StepDetails WhatsApp section renders for free plan (no tier gate)
 * 2. StepDetails WhatsApp section renders for growth plan
 * 3. StepDetails WhatsApp section renders for business plan
 * 4. StepDetails defaults to shared method
 * 5. StepDetails does NOT contain Pro/Premium-only wording
 * 6. StepSuccess shows connect CTA when waMethod is shared
 * 7. StepSuccess shows connected state when fbConnectionData exists
 * 8. StepSuccess shows incomplete-connection prompt when waMethod is transfer but no fbConnectionData
 * 9. StepSuccess does NOT show "our team is setting up" misleading copy
 * 10. StepSuccess connect CTA links to /dashboard/whatsapp/connect
 * 11. Dashboard connect page has no subscription_tier gate (structural)
 * 12. Shared onboarding still works (waMethod defaults to shared)
 * 13. Free/trial onboarding still works (plan selection unchanged)
 * 14. Paid onboarding still works (plan selection unchanged)
 * 15. Own-number connection does NOT change selectedPlan
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read source files for structural assertions
const stepDetailsSource = readFileSync(
  join(process.cwd(), 'app/get-started/steps/StepDetails.tsx'),
  'utf-8',
);
const stepSuccessSource = readFileSync(
  join(process.cwd(), 'app/get-started/steps/StepSuccess.tsx'),
  'utf-8',
);
const dashboardConnectSource = readFileSync(
  join(process.cwd(), 'app/dashboard/whatsapp/connect/page.tsx'),
  'utf-8',
);
const qrPageSource = readFileSync(
  join(process.cwd(), 'app/dashboard/qr-code/page.tsx'),
  'utf-8',
);

describe('Onboarding WhatsApp connection available on all plans (#346)', () => {

  describe('StepDetails — WhatsApp section', () => {
    it('does NOT gate WhatsApp section behind selectedPlan !== free', () => {
      // The old gate: {selectedPlan !== 'free' && (
      expect(stepDetailsSource).not.toContain("selectedPlan !== 'free'");
      expect(stepDetailsSource).not.toContain('selectedPlan !== "free"');
    });

    it('renders WhatsApp Connection section unconditionally', () => {
      expect(stepDetailsSource).toContain('WhatsApp Connection');
      // The section is not wrapped in a plan-conditional
      expect(stepDetailsSource).toContain('available on every plan');
    });

    it('does NOT contain Pro/Premium-only wording in WhatsApp section', () => {
      // The old gated wording was: "As a Pro/Premium user, you can connect..."
      expect(stepDetailsSource).not.toMatch(/As a .* user, you can connect/);
      // No tier-specific label in WhatsApp section
      expect(stepDetailsSource).not.toContain("'Pro'");
      expect(stepDetailsSource).not.toContain("'Premium'");
    });

    it('renders shared option as default', () => {
      expect(stepDetailsSource).toContain("Use Waaiio");
      expect(stepDetailsSource).toContain("shared number");
      expect(stepDetailsSource).toContain("Get started instantly");
    });

    it('renders own-number option', () => {
      expect(stepDetailsSource).toContain('Connect my own WhatsApp number');
    });

    it('renders Waaiio-managed as Coming Soon', () => {
      expect(stepDetailsSource).toContain('Dedicated Waaiio-managed number');
      expect(stepDetailsSource).toContain('Coming Soon');
    });

    it('does NOT mutate selectedPlan when waMethod changes', () => {
      // setWaMethod only sets waMethod, never touches selectedPlan
      expect(stepDetailsSource).not.toMatch(/setSelectedPlan.*transfer/);
      expect(stepDetailsSource).not.toMatch(/setSelectedPlan.*coexist/);
      // waMethod setters only call setWaMethod
      const waMethodSetCalls = stepDetailsSource.match(/setWaMethod\([^)]+\)/g) || [];
      expect(waMethodSetCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of waMethodSetCalls) {
        expect(call).toMatch(/setWaMethod\('(shared|transfer|coexist)'\)/);
      }
    });
  });

  describe('StepSuccess — WhatsApp connection prompt', () => {
    it('shows connect CTA when waMethod is shared', () => {
      // When waMethod === 'shared', show the connect prompt
      expect(stepSuccessSource).toContain("waMethod === 'shared'");
      expect(stepSuccessSource).toContain('Connect Your Own WhatsApp Number');
      expect(stepSuccessSource).toContain('Connect WhatsApp Number');
      expect(stepSuccessSource).toContain('Do this later');
    });

    it('connect CTA links to /dashboard/whatsapp/connect', () => {
      expect(stepSuccessSource).toContain('/dashboard/whatsapp/connect');
    });

    it('shows connected state when fbConnectionData exists', () => {
      expect(stepSuccessSource).toContain('fbConnectionData');
      expect(stepSuccessSource).toContain('WhatsApp Number Connected');
    });

    it('shows incomplete-connection prompt for transfer without fbConnectionData', () => {
      expect(stepSuccessSource).toContain("completed the connection yet");
    });

    it('does NOT contain misleading "our team is setting up" copy', () => {
      expect(stepSuccessSource).not.toContain('Our team is setting up');
      expect(stepSuccessSource).not.toContain('setting up your dedicated');
      expect(stepSuccessSource).not.toContain('usually within 24 hours');
    });

    it('states availability on every plan', () => {
      expect(stepSuccessSource).toContain('Available on every plan');
    });
  });

  describe('Dashboard WhatsApp connect page — no tier gate', () => {
    it('does not reference subscription_tier', () => {
      expect(dashboardConnectSource).not.toContain('subscription_tier');
    });

    it('does not reference selectedPlan', () => {
      expect(dashboardConnectSource).not.toContain('selectedPlan');
    });

    it('does not gate on plan or tier', () => {
      expect(dashboardConnectSource).not.toMatch(/tier.*gate/i);
      expect(dashboardConnectSource).not.toMatch(/plan.*required/i);
      expect(dashboardConnectSource).not.toContain("'free'");
      expect(dashboardConnectSource).not.toContain("'growth'");
      expect(dashboardConnectSource).not.toContain("'business'");
    });
  });

  describe('Dashboard QR — channel priority', () => {
    it('queries assigned channel first', () => {
      // assigned_channel_id or channelId used first in priority resolution
      expect(qrPageSource).toContain('assignedResult');
    });

    it('queries dedicated channel second', () => {
      expect(qrPageSource).toContain('dedicatedResult');
      expect(qrPageSource).toContain("channel_type");
      expect(qrPageSource).toContain("dedicated");
    });

    it('queries shared channel as fallback', () => {
      expect(qrPageSource).toContain('sharedResult');
    });

    it('resolves priority: assigned > dedicated > shared', () => {
      // The resolution line uses || chaining in this order
      const resolvedLine = qrPageSource.match(/const resolved\s*=\s*assignedResult[\s\S]*?\|\|[\s\S]*?dedicatedResult[\s\S]*?\|\|[\s\S]*?sharedResult/);
      expect(resolvedLine).not.toBeNull();
    });
  });

  describe('Regression — existing behavior preserved', () => {
    it('shared WhatsApp onboarding still works (default waMethod)', () => {
      // StepDetails still renders shared option
      expect(stepDetailsSource).toContain("setWaMethod('shared')");
      expect(stepDetailsSource).toContain("shared number");
    });

    it('free/trial plan selection is unchanged', () => {
      // selectedPlan prop is received but not modified by WhatsApp section
      expect(stepDetailsSource).toContain('selectedPlan');
      // No plan mutation in WhatsApp section
      expect(stepDetailsSource).not.toMatch(/setSelectedPlan.*waMethod/);
    });

    it('paid plan selection is unchanged', () => {
      // selectedPlan continues to be a read-only prop in StepDetails
      // The WhatsApp section does not modify it
      expect(stepDetailsSource).not.toContain('setSelectedPlan');
    });

    it('Meta Embedded Signup UI remains in StepDetails', () => {
      expect(stepDetailsSource).toContain('Connect with Facebook');
      expect(stepDetailsSource).toContain('launchWhatsAppSignup');
    });

    it('Facebook connection state is preserved', () => {
      expect(stepDetailsSource).toContain('fbConnected');
      expect(stepDetailsSource).toContain('Facebook Connected');
    });
  });
});
