'use client';

import { useEffect, useRef, useCallback } from 'react';
import type { User } from '@supabase/supabase-js';
import type { CountryCode, BusinessCategoryKey, SubscriptionTier } from '@/lib/constants';
import type { CapabilityId } from '@/lib/capabilities/types';
import type { WizardStep, WhatsAppMethod } from '@/app/get-started/steps';

const STORAGE_KEY = 'waaiio-onboarding-draft';
const DEBOUNCE_MS = 500;

export interface OnboardingDraft {
  step: WizardStep;
  selectedCountry: CountryCode;
  city: string;
  state: string;
  zipCode: string;
  selectedGroup: string | null;
  category: string;
  selectedCapabilities: CapabilityId[];
  businessName: string;
  firstName: string;
  lastName: string;
  address: string;
  phone: string;
  email: string;
  customBotCode: string;
  selectedPlan: SubscriptionTier;
  waMethod: WhatsAppMethod;
  savedAt: number;
}

/**
 * Saves onboarding form state to localStorage (debounced) and restores on mount.
 * Does NOT persist passwords, tokens, or Facebook connection data.
 */
export function useOnboardingPersistence(
  user: User | null,
  formState: Omit<OnboardingDraft, 'savedAt'>,
  restore: (draft: OnboardingDraft) => void,
) {
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const restoredRef = useRef(false);
  const draftRestoredRef = useRef(false);

  // Restore draft on mount (only if user is authenticated)
  useEffect(() => {
    if (restoredRef.current) return;
    if (!user) return;

    restoredRef.current = true;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const draft: OnboardingDraft = JSON.parse(raw);

      // Don't restore if the draft is older than 24 hours
      if (Date.now() - draft.savedAt > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }

      // Don't restore if already on success step
      if (draft.step === 'success' || draft.step === 'auth') return;

      draftRestoredRef.current = true;
      restore(draft);
    } catch {
      // Corrupted data — clear it
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [user, restore]);

  // Save draft on state change (debounced)
  useEffect(() => {
    // Don't save if not authenticated or on auth/success step
    if (!user) return;
    if (formState.step === 'auth' || formState.step === 'success') return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      try {
        const draft: OnboardingDraft = { ...formState, savedAt: Date.now() };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
      } catch {
        // localStorage full or unavailable — ignore
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [user, formState]);

  // Return whether a draft was restored (for showing indicator)
  return { draftRestored: draftRestoredRef.current };
}

/**
 * Clear the onboarding draft from localStorage.
 * Call on: successful completion, cancel, or sign out.
 */
export function clearOnboardingDraft() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
