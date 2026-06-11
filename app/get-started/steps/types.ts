import type React from 'react';
import type { User } from '@supabase/supabase-js';
import type {
  BusinessCategoryKey,
  SubscriptionTier,
  CountryCode,
} from '@/lib/constants';
import type { CapabilityId } from '@/lib/capabilities/types';
import type { CountryRow } from '@/lib/countries';

export type WizardStep = 'auth' | 'category' | 'features' | 'plan' | 'details' | 'success';
export type AuthSubStep = 'phone' | 'otp';
export type AuthMode = 'phone' | 'email';
export type WhatsAppMethod = 'shared' | 'transfer' | 'coexist';
export type ConnectSubStep = 'choose' | 'warnings' | 'setup' | 'phone_select';

export interface FbConnectionData {
  waba_id: string;
  phone_number_id: string;
  access_token: string;
  token_expires_at: string | null;
  display_name?: string;
  phone_number?: string;
}

export interface DiscoveredWaba {
  waba_id: string;
  waba_name: string;
  phones: Array<{
    id: string;
    display_phone_number: string;
    verified_name: string;
    quality_rating: string;
  }>;
}

export interface StepAuthProps {
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  authLoading: boolean;
  emailSent: boolean;
  setEmailSent: (v: boolean) => void;
  handleEmailSignup: (e: React.FormEvent) => void;
  setAuthLoading: (v: boolean) => void;
}

export interface StepCategoryProps {
  selectedCountry: CountryCode;
  setSelectedCountry: (v: CountryCode) => void;
  countryList: CountryRow[];
  setCity: (v: string) => void;
  selectedGroup: string | null;
  setSelectedGroup: (v: string | null) => void;
  category: BusinessCategoryKey | '';
  setCategory: (v: BusinessCategoryKey | '') => void;
  setSelectedCapabilities: React.Dispatch<React.SetStateAction<CapabilityId[]>>;
  setSelectedPlan: (v: SubscriptionTier) => void;
  setStep: (v: WizardStep) => void;
}

export interface StepFeaturesProps {
  selectedCapabilities: CapabilityId[];
  setSelectedCapabilities: React.Dispatch<React.SetStateAction<CapabilityId[]>>;
  selectedPlan: SubscriptionTier;
  setSelectedPlan: (v: SubscriptionTier) => void;
  selectedCountry: CountryCode;
  category: BusinessCategoryKey | '';
  requiredPlan: 'free' | 'growth' | 'business';
  localTiers: ReturnType<typeof import('@/lib/constants').getPricingTiers>;
  setStep: (v: WizardStep) => void;
}

export interface StepPlanProps {
  selectedPlan: SubscriptionTier;
  setSelectedPlan: (v: SubscriptionTier) => void;
  selectedCapabilities: CapabilityId[];
  setSelectedCapabilities: React.Dispatch<React.SetStateAction<CapabilityId[]>>;
  selectedCountry: CountryCode;
  requiredPlan: 'free' | 'growth' | 'business';
  localTiers: ReturnType<typeof import('@/lib/constants').getPricingTiers>;
  setStep: (v: WizardStep) => void;
}

export interface StepDetailsProps {
  firstName: string;
  setFirstName: (v: string) => void;
  lastName: string;
  setLastName: (v: string) => void;
  name: string;
  handleNameChange: (v: string) => void;
  nameCheckStatus: 'idle' | 'checking' | 'available' | 'taken';
  customBotCode: string;
  handleBotCodeChange: (v: string) => void;
  botCodeStatus: 'idle' | 'checking' | 'available' | 'taken';
  suggestedBotCode: string;
  address: string;
  setAddress: (v: string) => void;
  city: string;
  setCity: (v: string) => void;
  state: string;
  setState: (v: string) => void;
  zipCode: string;
  setZipCode: (v: string) => void;
  businessPhone: string;
  setBusinessPhone: (v: string) => void;
  selectedCountry: CountryCode;
  selectedPlan: SubscriptionTier;
  waMethod: WhatsAppMethod;
  setWaMethod: (v: WhatsAppMethod) => void;
  ownPhone: string;
  setOwnPhone: (v: string) => void;
  fbConnecting: boolean;
  setFbConnecting: (v: boolean) => void;
  fbConnected: boolean;
  setFbConnected: (v: boolean) => void;
  fbSdkReady: boolean;
  fbConnectionData: FbConnectionData | null;
  setFbConnectionData: React.Dispatch<React.SetStateAction<FbConnectionData | null>>;
  discoveredWabas: DiscoveredWaba[];
  setDiscoveredWabas: (v: DiscoveredWaba[]) => void;
  agreedToTerms: boolean;
  setAgreedToTerms: (v: boolean) => void;
  agreedToDataProcessing: boolean;
  setAgreedToDataProcessing: (v: boolean) => void;
  loading: boolean;
  error: string;
  category: BusinessCategoryKey | '';
  categoryInfo: ReturnType<typeof import('@/lib/categoryConfig').getCategoryByKey>;
  localTiers: ReturnType<typeof import('@/lib/constants').getPricingTiers>;
  launchWhatsAppSignup: () => void;
  handleRegister: (e: React.FormEvent | React.MouseEvent) => void;
  setStep: (v: WizardStep) => void;
}

export interface StepSuccessProps {
  loading: boolean;
  successData: { bot_code: string; business_id: string } | null;
  waMethod: WhatsAppMethod;
  waLink: string;
  selectedCapabilities: CapabilityId[];
  error: string;
  setStep: (v: WizardStep) => void;
  setError: (v: string) => void;
  fbConnectionData: FbConnectionData | null;
}
