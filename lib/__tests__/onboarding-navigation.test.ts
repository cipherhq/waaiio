/**
 * Onboarding Navigation & Step Indicator Tests
 *
 * Verifies the actual production source for:
 * 1. Primary path: Category → Features → Details, with Details Back → Features
 * 2. Step indicator: features/plan map to a visible stage (not -1)
 * 3. Resumed draft: restoreDraft can set 'plan', Details Back still → Features
 * 4. Plan entry: StepPlan Back → category, StepPlan Continue → details
 * 5. StepFeatures: Back → category, Continue → details
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const wizardSource = readFileSync(
  join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'),
  'utf-8',
);
const detailsSource = readFileSync(
  join(process.cwd(), 'app/get-started/steps/StepDetails.tsx'),
  'utf-8',
);
const featuresSource = readFileSync(
  join(process.cwd(), 'app/get-started/steps/StepFeatures.tsx'),
  'utf-8',
);
const planSource = readFileSync(
  join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'),
  'utf-8',
);

describe('Onboarding navigation — primary path', () => {
  it('StepCategory advances to features', () => {
    // StepCategory calls setStep('features') on category selection
    const categorySource = readFileSync(
      join(process.cwd(), 'app/get-started/steps/StepCategory.tsx'),
      'utf-8',
    );
    expect(categorySource).toContain("setStep('features')");
  });

  it('StepFeatures Back returns to category', () => {
    expect(featuresSource).toContain("setStep('category')");
    // The back button is the first setStep call — verify it targets category
    const backIdx = featuresSource.indexOf("setStep('category')");
    expect(backIdx).toBeGreaterThan(-1);
    // Verify it's in a Back button context (label appears after onClick in the button)
    const surroundingBack = featuresSource.slice(backIdx, backIdx + 400);
    expect(surroundingBack).toContain('Back');
  });

  it('StepFeatures Continue advances to details', () => {
    expect(featuresSource).toContain("setStep('details')");
  });

  it('StepDetails Back returns to features (not category)', () => {
    // The Back button must target 'features' — the step directly before Details
    expect(detailsSource).toContain("setStep('features')");
    // Verify it does NOT target 'category' in a Back button context
    const backButtonMatch = detailsSource.match(/Back<\/button>/);
    expect(backButtonMatch).not.toBeNull();
    // Extract the onClick handler for the Back button
    const backBtnIdx = detailsSource.indexOf('Back</button>');
    const precedingChunk = detailsSource.slice(Math.max(0, backBtnIdx - 200), backBtnIdx);
    expect(precedingChunk).toContain("setStep('features')");
    expect(precedingChunk).not.toContain("setStep('category')");
  });
});

describe('Onboarding navigation — step indicator', () => {
  it('indicator maps features/plan to a visible step (not -1)', () => {
    // The wizard must map intermediate steps so findIndex never returns -1
    // Verify the intermediateSteps mapping exists
    expect(wizardSource).toContain('intermediateSteps');
    expect(wizardSource).toContain("'features'");
    expect(wizardSource).toContain("'plan'");
    // Verify the mapping assigns 'category' (a step that exists in the array)
    expect(wizardSource).toContain("? 'category' : step");
  });

  it('steps array contains auth, category, details, success', () => {
    expect(wizardSource).toContain("key: 'auth'");
    expect(wizardSource).toContain("key: 'category'");
    expect(wizardSource).toContain("key: 'details'");
    expect(wizardSource).toContain("key: 'success'");
  });

  it('stepIndex uses indicatorKey (not raw step)', () => {
    // Verify findIndex uses indicatorKey, not step directly
    expect(wizardSource).toContain('s.key === indicatorKey');
  });
});

describe('Onboarding navigation — Plan entry path', () => {
  it('StepPlan Back returns to category', () => {
    expect(planSource).toContain("setStep('category')");
    // Verify the first setStep in StepPlan is the Back button (targets 'category')
    // and that a 'Back' label exists shortly after in the same button
    const backIdx = planSource.indexOf("setStep('category')");
    const surroundingBack = planSource.slice(backIdx, backIdx + 400);
    expect(surroundingBack).toContain('Back');
  });

  it('StepPlan Continue advances to details', () => {
    expect(planSource).toContain("setStep('details')");
  });
});

describe('Onboarding navigation — resumed draft', () => {
  it('restoreDraft sets the step from the draft', () => {
    // restoreDraft must call setStep(draft.step) to restore any saved step
    expect(wizardSource).toContain('setStep(draft.step)');
  });

  it('Details Back target is fixed regardless of entry path', () => {
    // Whether user arrives at Details from Features (primary) or Plan (alternate),
    // the Back button always goes to 'features' — it's hardcoded, not dynamic
    const allSetStepInDetails = [...detailsSource.matchAll(/setStep\('(\w+)'\)/g)].map(m => m[1]);
    // The only navigation targets in StepDetails should be 'features' (Back) and possibly 'success' or form submit
    expect(allSetStepInDetails).toContain('features');
    expect(allSetStepInDetails).not.toContain('category');
  });
});
