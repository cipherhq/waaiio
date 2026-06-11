import type { Business } from '@/components/dashboard/DashboardProvider';
import type { CapabilityId } from '@/lib/capabilities/types';
import type { CountryCode } from '@/lib/constants';

export interface SettingsTabProps {
  business: Business;
  capabilities: CapabilityId[];
  country: CountryCode;
  curr: string;
  saving: boolean;
  setSaving: (v: boolean) => void;
  saved: boolean;
  setSaved: (v: boolean) => void;
  openSections: string[];
  toggleSection: (section: string) => void;
}
